import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const POLICY_VERSION = 'micro-dsh-execution-v1';
const actions = new Set(['read', 'write', 'delete', 'git', 'command', 'network', 'opaque']);
const secretKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|auth[_-]?token|private[_-]?key|credential(?:s)?)$/i;

/** Best-effort output minimization, not an arbitrary secret detector or DLP proof. */
export function redactSensitive(value, depth = 0) {
  if (depth > 30) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return value
    .replace(/-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/(\b(?:api[_-]?key|password|access[_-]?token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redactSensitive(item, depth + 1)]));
  return value;
}

function protectedPath(path) {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  return parts.some(part => part === '.git' || part === '.ssh' || part === '.aws' || part === '.gnupg' || part === '.kube' || part === '.env' || part.startsWith('.env.') || part === '.envrc' || part.startsWith('.envrc.') ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_.*)?(?:\.pub)?$/.test(part) || /\.(?:pem|key|p12|pfx)$/.test(part) ||
    ['.git-credentials', '.netrc', '_netrc', '.npmrc', '.pypirc', 'credentials.json'].includes(part)) ||
    parts.some((part, index) => part === '.git' && ['config', 'hooks', 'credentials'].includes(parts[index + 1]));
}
function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function pathError(code) { return Object.assign(new Error('Path is not permitted by the configured workspace policy.'), { code }); }
function getField(input, field) {
  return field.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, input);
}
function decision(action, ruleId, reason) { return { action, ruleId, reason, policyVersion: POLICY_VERSION }; }

/** Host policy only. Does not sandbox code, freeze an external filesystem, or police remote server internals. */
export function createExecutionGuard({ workspaceRoot, allowReadOnlyCommands = ['git'], policyVersion = POLICY_VERSION } = {}) {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) throw new Error('An absolute workspaceRoot is required');
  const root = resolve(workspaceRoot);
  // Resolve lazily for test/CLI setup, but pin the canonical root once checked.
  const rootPromise = realpath(root);
  rootPromise.catch(() => {});
  const approvedCommands = new Set(allowReadOnlyCommands);

  async function assertPath(path, { allowMissing = false } = {}) {
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f]/.test(path)) throw pathError('INVALID_PATH');
    // NTFS alternate streams, namespace/device paths, drive-relative paths, and
    // ambiguous trailing dots/spaces must not alias an innocuous checked name.
    if (path.startsWith('~') || /^(?:\\\\|\/\/)/.test(path) || path.replace(/^[A-Za-z]:[\\/]/, '').includes(':') ||
      path.replaceAll('\\', '/').split('/').some(part => (/[. ]$/.test(part) && part !== '.' && part !== '..') || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw pathError('AMBIGUOUS_PATH');
    const absolute = resolve(root, path);
    if (!within(root, absolute)) throw pathError('OUTSIDE_WORKSPACE');
    if (protectedPath(path) || protectedPath(absolute)) throw pathError('PROTECTED_PATH');
    const canonicalRoot = await rootPromise;
    // Reject every symlink/junction component, including links to a path inside
    // the root. Check again in the actual read adapter to narrow TOCTOU exposure.
    const rel = relative(root, absolute);
    let cursor = root;
    let missing = false;
    for (const component of rel.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, component);
      if (missing) continue;
      try {
        const st = await lstat(cursor);
        if (st.isSymbolicLink()) throw pathError('SYMLINK_PATH');
      } catch (cause) {
        if (cause.code !== 'ENOENT' || !allowMissing) throw cause;
        missing = true;
      }
    }
    if (!missing) {
      const canonical = await realpath(absolute);
      if (!within(canonicalRoot, canonical) || protectedPath(canonical)) throw pathError('OUTSIDE_WORKSPACE');
      return canonical;
    }
    return absolute;
  }

  async function evaluate({ input, options = {}, context = {} }) {
    const policy = options.policy;
    if (!policy || !actions.has(policy.effect)) return decision('deny', 'UNCLASSIFIED_TOOL', 'Tool has no trusted host execution policy.');
    if (context.signal?.aborted) return decision('deny', 'CANCELLED', 'Execution was cancelled.');
    try {
      const pathFields = policy.pathFields ?? [];
      if (!Array.isArray(pathFields) || pathFields.some(field => typeof field !== 'string' || !field)) throw pathError('INVALID_POLICY');
      for (const field of pathFields) {
        const paths = getField(input, field);
        for (const path of Array.isArray(paths) ? paths : [paths]) await assertPath(path, { allowMissing: policy.effect === 'write' });
      }
      if (policy.cwdField) await assertPath(getField(input, policy.cwdField));
      if (['command', 'git'].includes(policy.effect)) return await commandDecision(input, policy);
      if (['write', 'delete', 'network', 'opaque'].includes(policy.effect)) return decision('approval', 'SIDE_EFFECT_APPROVAL', 'This operation requires approval outside the model before execution.');
      return { ...decision('allow', 'SCOPED_READ', 'Trusted read capability within the configured scope.'), policyVersion };
    } catch (cause) {
      return decision('deny', cause.code && /^[A-Z_]+$/.test(cause.code) ? cause.code : 'PATH_CHECK_FAILED', 'The resource failed the workspace or protected-file policy.');
    }
  }

  async function commandDecision(input, policy) {
    const command = policy.effect === 'git' ? 'git' : getField(input, policy.commandField ?? 'command');
    const args = getField(input, policy.argvField ?? 'args');
    // There is deliberately no shell string parser. Operators, interpreters,
    // scripts and arbitrary programs never reach a shell through this policy.
    if (typeof command !== 'string' || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f]/.test(arg))) return decision('deny', 'STRUCTURED_ARGV_REQUIRED', 'Commands require a trusted executable and structured argument array.');
    if (command !== 'git' || !approvedCommands.has(command)) return decision('deny', 'EXECUTABLE_DENIED', 'This executable is not enabled by the host policy.');
    const subcommand = args[0];
    if (['reset', 'clean', 'restore', 'checkout', 'push', 'merge', 'rebase', 'commit', 'add', 'rm', 'branch', 'tag', 'config', 'update-ref'].includes(subcommand)) {
      return decision('approval', 'GIT_MUTATION_APPROVAL', 'Git state changes require approval outside the model.');
    }
    // Git object/path selectors may expose secrets without a filesystem read.
    if (args.some(arg => protectedPath(arg) || arg.split(/[\\/]/).includes('..'))) return decision('deny', 'PROTECTED_GIT_PATH', 'Git selectors may not access protected or traversing paths.');
    // Broad diff/show/cat-file can reveal a tracked secret even without a path
    // argument. Those reads belong to the pinned, path-scoped review adapter.
    if (subcommand !== 'status' || args.slice(1).some(arg => !['--short', '--porcelain', '--porcelain=v1', '--branch', '--untracked-files=no'].includes(arg))) {
      return decision('deny', 'GIT_ARGUMENT_DENIED', 'Use the pinned repository adapter for content reads; generic Git allows status only.');
    }
    return decision('allow', 'READ_ONLY_GIT', 'Read-only Git argv accepted; the adapter must disable external helpers and hooks.');
  }

  return Object.freeze({ evaluate, assertReadablePath: path => assertPath(path), redact: redactSensitive, policyVersion, workspaceRoot: root });
}
