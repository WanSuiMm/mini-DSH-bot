import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const FULL_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxMetadataBytes: 2 * 1024 * 1024,
  maxDiffBytes: 48 * 1024,
  maxFileBytes: 256 * 1024,
  maxChangedFiles: 50,
  maxFileLines: 200,
  maxExcerptChars: 24_000,
});

const DIFF_TOOL = Object.freeze({
  name: 'repository_review_diff',
  description: 'Read the fixed base-to-head Git diff and the actual changed lines that are present at the reviewed head. The repository root and commit pair are fixed by the caller.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

const FILE_TOOL = Object.freeze({
  name: 'repository_review_file_at_head',
  description: 'Read a bounded line range from a regular text file that changed and exists at the fixed reviewed head commit. Use this to inspect context before reporting a finding.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Exact repository-relative path from repository_review_diff.' },
      startLine: { type: 'integer', minimum: 1, description: 'First one-based line to return. Defaults to 1.' },
      maxLines: { type: 'integer', minimum: 1, maximum: DEFAULTS.maxFileLines, description: 'Maximum number of lines to return. Defaults to 80.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
});

/**
 * Read-only local Git tools for one immutable, caller-selected base/head pair.
 * The model never supplies a repository root, revision, executable, or Git argv.
 */
export function createRepositoryReviewTools({ repoRoot, guard, ...limits } = {}) {
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) throw new TypeError('repoRoot must be an explicit absolute path');
  if (!guard || typeof guard.assertReadablePath !== 'function') throw new TypeError('An execution guard with assertReadablePath(path) is required');

  const config = validateLimits({ ...DEFAULTS, ...limits });
  const requestedRoot = resolve(repoRoot);
  let canonicalRootPromise;
  let fixedSpec;
  let snapshotPromise;

  async function canonicalRoot() {
    if (!canonicalRootPromise) {
      canonicalRootPromise = (async () => {
        const guarded = await guard.assertReadablePath(requestedRoot);
        const canonical = await realpath(guarded);
        const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd: canonical, timeoutMs: config.timeoutMs, maxBuffer: config.maxMetadataBytes })).toString('utf8').trim();
        const canonicalTop = await realpath(top);
        if (!samePath(canonical, canonicalTop)) throw reviewError('INVALID_REPOSITORY_ROOT', 'repoRoot must be the top-level root of a Git worktree.');
        return canonical;
      })();
      canonicalRootPromise.catch(() => {});
    }
    return canonicalRootPromise;
  }

  async function snapshot(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('snapshot requires {base, head}');
    const base = normalizeObjectId(spec.base, 'base');
    const head = normalizeObjectId(spec.head, 'head');
    if (fixedSpec && (fixedSpec.base !== base || fixedSpec.head !== head)) {
      throw reviewError('SNAPSHOT_IMMUTABLE', 'This review tool instance is already bound to a different base/head pair.');
    }
    if (!fixedSpec) {
      fixedSpec = Object.freeze({ base, head });
      snapshotPromise = buildSnapshot(fixedSpec, spec.signal).catch(error => { throw publicReviewError(error); });
      snapshotPromise.catch(() => {});
    }
    return freezeJson(await snapshotPromise);
  }

  async function buildSnapshot({ base, head }, signal) {
    const cwd = await canonicalRoot();
    await resolveCommit(base, cwd, signal, config);
    await resolveCommit(head, cwd, signal, config);

    const statusOutput = await runGit([
      'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, head, '--',
    ], gitOptions(cwd, signal, config.maxMetadataBytes, config));
    const changed = parseNameStatus(statusOutput);
    if (changed.length > config.maxChangedFiles * 4) {
      throw reviewError('REVIEW_FILE_LIMIT', 'The commit range changes too many paths for this bounded review.');
    }

    const reviewable = [];
    let omittedByPolicyCount = 0;
    let omittedAtHeadCount = 0;
    for (const item of changed) {
      if (!isSafeGitPath(item.path)) {
        omittedByPolicyCount += 1;
        continue;
      }
      const treeEntry = await readTreeEntry(cwd, head, item.path, signal, config, guard);
      if (treeEntry?.blocked) {
        omittedByPolicyCount += 1;
        continue;
      }
      if (!treeEntry) {
        // A deleted file has no line in the reviewed head to anchor a finding to.
        omittedAtHeadCount += 1;
        continue;
      }
      if (!/^100(?:644|755)$/.test(treeEntry.mode) || treeEntry.type !== 'blob') {
        // Symlinks, submodules and unusual file modes are deliberately not opened.
        omittedByPolicyCount += 1;
        continue;
      }
      try {
        await guard.assertReadablePath(toNativePath(cwd, item.path));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          omittedByPolicyCount += 1;
          continue;
        }
        // The worktree may have moved since the selected commit. The eventual
        // read is from the pinned Git blob, never from this missing path.
      }
      reviewable.push({ ...item, treeEntry });
    }
    if (reviewable.length > config.maxChangedFiles) {
      throw reviewError('REVIEW_FILE_LIMIT', `The commit range changes more than ${config.maxChangedFiles} reviewable files.`);
    }

    const files = [];
    const patches = [];
    let totalDiffBytes = 0;
    for (const item of reviewable) {
      const patch = await runGit([
        'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=0', base, head, '--', `:(literal)${item.path}`,
      ], gitOptions(cwd, signal, config.maxDiffBytes + 1, config));
      totalDiffBytes += patch.byteLength;
      if (totalDiffBytes > config.maxDiffBytes) {
        throw reviewError('REVIEW_DIFF_LIMIT', `The filtered diff exceeds the ${config.maxDiffBytes}-byte review limit.`);
      }
      const safePatch = sanitizeGitText(patch.toString('utf8'));
      patches.push(safePatch);
      files.push({
        path: item.path,
        status: item.status,
        addedLines: parseAddedLines(safePatch),
      });
    }

    const limitations = [
      'This review is limited to the selected immutable base/head commit range.',
      'Findings can be anchored only to added lines that exist at the reviewed head; deletions have no head-side line anchor.',
      'Binary files, symlinks, submodules, protected paths, and files rejected by the workspace guard are omitted.',
    ];
    if (omittedByPolicyCount > 0) limitations.push(`${omittedByPolicyCount} changed path(s) were omitted by workspace safety policy.`);
    if (omittedAtHeadCount > 0) limitations.push(`${omittedAtHeadCount} deleted path(s) were omitted because they have no lines at the reviewed head.`);

    return {
      base,
      head,
      files,
      diff: patches.filter(Boolean).join('\n'),
      omittedByPolicyCount,
      omittedAtHeadCount,
      limitations,
    };
  }

  async function readFileAtHead(input, context = {}) {
    if (!snapshotPromise || !fixedSpec) return fail('SNAPSHOT_NOT_INITIALIZED', 'The caller must initialize the fixed review snapshot before tools can run.');
    const args = objectInput(input);
    if (!args || Object.keys(args).some(key => !['path', 'startLine', 'maxLines'].includes(key))) {
      return fail('INVALID_REVIEW_INPUT', 'Expected only path, startLine, and maxLines.');
    }
    if (typeof args.path !== 'string' || args.path.length < 1 || args.path.length > 1024 || !isSafeGitPath(args.path)) {
      return fail('INVALID_REVIEW_PATH', 'The requested path is not an eligible changed file.');
    }
    const startLine = args.startLine === undefined ? 1 : args.startLine;
    const maxLines = args.maxLines === undefined ? 80 : args.maxLines;
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > config.maxFileLines) {
      return fail('INVALID_REVIEW_RANGE', `startLine must be positive and maxLines must be from 1 through ${config.maxFileLines}.`);
    }

    let data;
    try { data = await snapshotPromise; }
    catch (error) { return failureFrom(error); }
    const file = data.files.find(candidate => candidate.path === args.path);
    if (!file) return fail('REVIEW_FILE_NOT_AVAILABLE', 'The path is not an eligible changed file present at the reviewed head.');

    try {
      const cwd = await canonicalRoot();
      await assertReviewPath(guard, cwd, file.path, true);
      const objectId = await resolveCommit(fixedSpec.head, cwd, context.signal, config);
      const content = await runGit(['cat-file', 'blob', `${objectId}:${file.path}`], gitOptions(cwd, context.signal, config.maxFileBytes + 1, config));
      if (content.byteLength > config.maxFileBytes) return fail('REVIEW_FILE_LIMIT', `The file exceeds the ${config.maxFileBytes}-byte read limit.`);
      if (content.includes(0)) return fail('REVIEW_FILE_NOT_TEXT', 'Binary files cannot be read by this review tool.');
      await assertReviewPath(guard, cwd, file.path, true);
      const text = sanitizeFileText(content.toString('utf8'));
      const lines = text.split('\n');
      const end = Math.min(lines.length, startLine - 1 + maxLines);
      if (startLine > lines.length) return fail('INVALID_REVIEW_RANGE', 'startLine is past the end of the file at the reviewed head.');
      const excerpt = lines.slice(startLine - 1, end).map((line, index) => ({ line: startLine + index, text: line.replace(/\r$/, '') }));
      const characterCount = excerpt.reduce((count, line) => count + line.text.length, 0);
      if (characterCount > config.maxExcerptChars) return fail('REVIEW_EXCERPT_LIMIT', `The selected lines exceed the ${config.maxExcerptChars}-character read limit; request a narrower line range.`);
      return success({ head: fixedSpec.head, path: file.path, startLine, endLine: end, lines: excerpt, truncated: end < lines.length }, [{
        id: `review:${fixedSpec.head}:${file.path}:${startLine}-${end}`,
        kind: 'tool_output',
        ref: `${fixedSpec.head}:${file.path}#L${startLine}-L${end}`,
        summary: `Lines ${startLine}-${end} from a changed file at the reviewed head.`,
      }]);
    } catch (error) {
      return failureFrom(error);
    }
  }

  async function readDiff(input) {
    if (!snapshotPromise || !fixedSpec) return fail('SNAPSHOT_NOT_INITIALIZED', 'The caller must initialize the fixed review snapshot before tools can run.');
    const args = objectInput(input);
    if ((input !== undefined && !args) || (args && Object.keys(args).length > 0)) return fail('INVALID_REVIEW_INPUT', 'The diff tool accepts no arguments.');
    try {
      const data = await snapshotPromise;
      return success(data, [{
        id: `review-diff:${data.base}:${data.head}`,
        kind: 'tool_output',
        ref: `${data.base}..${data.head}`,
        summary: `Filtered local Git diff with ${data.files.length} reviewable changed file(s).`,
      }]);
    } catch (error) { return failureFrom(error); }
  }

  const definitions = () => [DIFF_TOOL, FILE_TOOL].map(definition => structuredClone(definition));
  function register(registry) {
    if (!registry || typeof registry.register !== 'function') throw new TypeError('registry must expose register(name, handler, options)');
    registry.register(DIFF_TOOL.name, input => readDiff(input), { readOnly: true, policy: { effect: 'read', source: 'native' } });
    registry.register(FILE_TOOL.name, (input, context) => readFileAtHead(input, context), {
      readOnly: true,
      // This path selects a pinned Git blob and need not exist in the current
      // worktree. The adapter maps it to the fixed root and checks it internally.
      policy: { effect: 'read', source: 'native' },
    });
    return registry;
  }

  return Object.freeze({ definitions, register, snapshot });
}

function validateLimits(options) {
  const bounds = {
    timeoutMs: [100, 60_000], maxMetadataBytes: [1024, 8 * 1024 * 1024], maxDiffBytes: [1024, 4 * 1024 * 1024],
    maxFileBytes: [1024, 8 * 1024 * 1024], maxChangedFiles: [1, 200], maxFileLines: [1, 200], maxExcerptChars: [256, 64 * 1024],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) {
      throw new TypeError(`${key} must be an integer from ${min} through ${max}`);
    }
  }
  return Object.freeze(options);
}

function normalizeObjectId(value, name) {
  if (typeof value !== 'string' || !FULL_OBJECT_ID.test(value)) throw new TypeError(`${name} must be a full 40- or 64-character Git commit SHA`);
  return value.toLowerCase();
}

async function resolveCommit(sha, cwd, signal, config) {
  const result = await runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], gitOptions(cwd, signal, 256, config));
  const resolved = result.toString('utf8').trim().toLowerCase();
  if (resolved !== sha) throw reviewError('INVALID_REVIEW_COMMIT', 'The selected value is not the exact full SHA of a commit in the configured repository.');
  return resolved;
}

async function readTreeEntry(cwd, head, path, signal, config, guard) {
  try {
    await assertReviewPath(guard, cwd, path, true);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { blocked: true };
  }
  const output = await runGit(['ls-tree', '-z', '--full-tree', head, '--', `:(literal)${path}`], gitOptions(cwd, signal, config.maxMetadataBytes, config));
  const entry = output.toString('utf8').split('\0').find(Boolean);
  if (!entry) return undefined;
  const tab = entry.indexOf('\t');
  if (tab < 0 || entry.slice(tab + 1) !== path) return undefined;
  const [mode, type, objectId] = entry.slice(0, tab).split(' ');
  if (!mode || !type || !objectId || !FULL_OBJECT_ID.test(objectId)) return undefined;
  return { mode, type, objectId };
}

async function assertReviewPath(guard, cwd, path, allowMissing) {
  try {
    await guard.assertReadablePath(toNativePath(cwd, path));
  } catch (error) {
    if (!(allowMissing && error?.code === 'ENOENT')) throw error;
  }
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  const result = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const path = fields[i++];
    if (typeof path !== 'string' || path.length === 0) throw reviewError('INVALID_GIT_OUTPUT', 'Git returned malformed changed-path metadata.');
    if (/^[RC]/.test(status)) throw reviewError('INVALID_GIT_OUTPUT', 'Git rename detection was unexpectedly enabled.');
    result.push({ status: status[0], path });
  }
  return result;
}

function parseAddedLines(patch) {
  const changed = [];
  let nextLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      changed.push({ line: nextLine, text: line.slice(1) });
      nextLine += 1;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      // Removed lines and the no-final-newline marker do not consume a head line.
    } else if (nextLine > 0 && line.startsWith(' ')) {
      nextLine += 1;
    }
  }
  return changed;
}

function isSafeGitPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes(':')) return false;
  const parts = path.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[. ]$/.test(part));
}

function toNativePath(root, gitPath) {
  return resolve(root, ...gitPath.split('/'));
}

function gitOptions(cwd, signal, maxBuffer, config) {
  return { cwd, signal, timeoutMs: config.timeoutMs, maxBuffer };
}

async function runGit(args, { cwd, signal, timeoutMs, maxBuffer }) {
  const env = sanitizedGitEnvironment();
  try {
    const { stdout } = await execFileAsync('git', [
      '--no-pager', '--no-optional-locks',
      '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=',
      '-c', 'diff.external=',
      '-c', 'core.pager=cat',
      '-c', 'protocol.ext.allow=never',
      ...args,
    ], {
      cwd,
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer,
      signal,
      windowsHide: true,
      shell: false,
      env,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw reviewError('REVIEW_CANCELLED', 'The local Git read was cancelled.');
    if (error?.killed || error?.code === 'ETIMEDOUT') throw reviewError('REVIEW_TIMEOUT', 'The local Git read exceeded its time limit.');
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw reviewError('REVIEW_OUTPUT_LIMIT', 'The local Git read exceeded its output limit.');
    throw reviewError('REVIEW_GIT_FAILED', 'A fixed read-only Git operation failed; check the selected commits and local Git installation.');
  }
}

function sanitizedGitEnvironment() {
  const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'systemdrive', 'temp', 'tmp', 'comspec']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toLowerCase())));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_EXTERNAL_DIFF: '',
    GIT_ATTR_NOSYSTEM: '1',
    PAGER: 'cat',
  });
  return env;
}

function sanitizeGitText(value) {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, char => `\\x${(char.charCodeAt(0)).toString(16).padStart(2, '0')}`);
}

function sanitizeFileText(value) {
  return sanitizeGitText(value.replace(/\r\n/g, '\n'));
}

function objectInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
}

function samePath(left, right) {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/, '');
  const normalizedRight = resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function reviewError(code, message) { return Object.assign(new Error(message), { code }); }

function publicReviewError(error) {
  if (error?.code && /^REVIEW_[A-Z_]+$/.test(error.code)) return error;
  if (error?.code === 'INVALID_REPOSITORY_ROOT' || error?.code === 'INVALID_REVIEW_COMMIT' || error?.code === 'SNAPSHOT_IMMUTABLE') return error;
  if (error?.code === 'PROTECTED_PATH' || error?.code === 'SYMLINK_PATH' || error?.code === 'OUTSIDE_WORKSPACE') return reviewError('REVIEW_PATH_BLOCKED', 'A requested path was rejected by the workspace safety policy.');
  if (error?.code === 'ENOENT') return reviewError('REVIEW_PATH_BLOCKED', 'The configured repository path is unavailable.');
  return reviewError('REVIEW_SETUP_FAILED', 'The local repository review could not be initialized.');
}

function failureFrom(error) {
  const normalized = publicReviewError(error);
  return fail(normalized.code ?? 'REVIEW_FAILED', normalized.message ?? 'The review operation failed.');
}

function fail(code, message) { return { ok: false, error: { code, message, retryable: false }, evidence: [] }; }
function success(data, evidence = []) { return { ok: true, data, evidence }; }

function freezeJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}
