import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { redactSensitive } from '../../service/security/guard.mjs';

const MAX_JSON_DEPTH = 24;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const TOKEN_FIELDS = new Set([
  'inputTokens', 'outputTokens', 'totalTokens', 'prompt_tokens', 'completion_tokens',
  'total_tokens', 'promptTokens', 'completionTokens', 'input_tokens', 'output_tokens',
  'cacheHitInputTokens', 'cacheMissInputTokens', 'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
]);

const SECRET_QUERY = /([?&](?:access_token|refresh_token|session_token|auth_token|api_key|apikey|token|password|secret|credential)=)[^&#\s]*/gi;
const SECRET_HEADER = /\b(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[^,;\r\n]*/gi;
const COOKIE_HEADER = /(^|[\r\n]\s*)(cookie|set-cookie)\s*[:=][^\r\n]*/gi;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function scrubString(value) {
  return value
    .replace(SECRET_HEADER, '$1[REDACTED]')
    .replace(COOKIE_HEADER, '$1$2: [REDACTED]')
    .replace(SECRET_QUERY, '$1[REDACTED]');
}

function normalizeData(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_JSON_DEPTH) throw evidenceError('EVIDENCE_DEPTH_LIMIT');
  if (value === undefined || value === null) return value ?? null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw evidenceError('EVIDENCE_NON_FINITE_NUMBER');
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw evidenceError('EVIDENCE_NON_JSON_VALUE');
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw evidenceError('EVIDENCE_INVALID_DATE');
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(typeof value.code === 'string' || typeof value.code === 'number' ? { code: value.code } : {}),
      ...(value.cause === undefined ? {} : { cause: normalizeData(value.cause, depth + 1, seen) }),
      ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
    };
  }
  if (seen.has(value)) throw evidenceError('EVIDENCE_CIRCULAR_DATA');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(item => normalizeData(item, depth + 1, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw evidenceError('EVIDENCE_NON_PLAIN_OBJECT');
    result = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw evidenceError('EVIDENCE_ACCESSOR_PROPERTY');
      result[key] = normalizeData(descriptor.value, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

function scrubRedacted(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubRedacted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubRedacted(item)]));
  }
  return value;
}

function serializeEvidence(value, indent = 2) {
  const safeData = normalizeData(value);
  const redacted = redactSensitive(safeData);
  if (containsDepthMarker(redacted)) throw evidenceError('EVIDENCE_REDACTION_DEPTH_LIMIT');
  return Buffer.from(`${JSON.stringify(scrubRedacted(redacted), null, indent)}\n`, 'utf8');
}

function containsDepthMarker(value) {
  if (value === '[DEPTH_LIMIT]') return true;
  if (Array.isArray(value)) return value.some(containsDepthMarker);
  if (value && typeof value === 'object') return Object.values(value).some(containsDepthMarker);
  return false;
}

function evidenceError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function safeCellDirectory(cellId) {
  if (typeof cellId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}::(?:single|multi|fixture)$/.test(cellId)) {
    throw evidenceError('EVIDENCE_INVALID_CELL_ID');
  }
  return cellId.replace('::', '--');
}

function positiveLimit(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw evidenceError(`EVIDENCE_INVALID_${name.toUpperCase()}`);
  return selected;
}

function usageObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasUsageField(value) {
  return Object.keys(value).some(key => TOKEN_FIELDS.has(key));
}

function findUsageCandidate(input) {
  if (!usageObject(input)) return undefined;
  if (hasUsageField(input)) return input;
  const paths = [
    ['data', 'usage'], ['usage'], ['result', 'data', 'usage'], ['result', 'usage'],
  ];
  for (const path of paths) {
    let candidate = input;
    for (const key of path) candidate = usageObject(candidate) ? candidate[key] : undefined;
    if (usageObject(candidate)) return candidate;
  }
  return undefined;
}

function readIntegerAlias(source, aliases, field, { optional = false } = {}) {
  const keys = aliases.filter(key => Object.hasOwn(source, key));
  if (!keys.length) return { present: false, value: undefined };
  const values = keys.map(key => source[key]);
  if (optional && values.every(value => value === null || value === undefined)) {
    return { present: true, value: undefined };
  }
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || values.some(value => value !== values[0])) {
    return { present: true, invalid: `${field}_invalid_or_conflicting` };
  }
  return { present: true, value: values[0] };
}

/** Parse either an actual normalized usage object or a provider/adapter wrapper. */
export function parseProviderUsage(rawOrWrapper) {
  const source = findUsageCandidate(rawOrWrapper);
  if (!source) return { usage: null, reason: 'usage_missing' };
  const input = readIntegerAlias(source, ['inputTokens', 'prompt_tokens', 'promptTokens', 'input_tokens'], 'inputTokens');
  const output = readIntegerAlias(source, ['outputTokens', 'completion_tokens', 'completionTokens', 'output_tokens'], 'outputTokens');
  const total = readIntegerAlias(source, ['totalTokens', 'total_tokens'], 'totalTokens');
  for (const item of [input, output, total]) if (item.invalid) return { usage: null, reason: item.invalid };
  if (!input.present || !output.present || !total.present) return { usage: null, reason: 'required_token_field_missing' };
  if (!Number.isSafeInteger(input.value + output.value) || total.value !== input.value + output.value) {
    return { usage: null, reason: 'total_tokens_do_not_reconcile' };
  }

  const cacheHit = readIntegerAlias(source, ['cacheHitInputTokens', 'prompt_cache_hit_tokens'], 'cacheHitInputTokens', { optional: true });
  const cacheMiss = readIntegerAlias(source, ['cacheMissInputTokens', 'prompt_cache_miss_tokens'], 'cacheMissInputTokens', { optional: true });
  for (const item of [cacheHit, cacheMiss]) if (item.invalid) return { usage: null, reason: item.invalid };
  const hitKnown = Number.isSafeInteger(cacheHit.value);
  const missKnown = Number.isSafeInteger(cacheMiss.value);
  if (hitKnown !== missKnown) return { usage: null, reason: 'cache_token_breakdown_incomplete' };
  if (hitKnown && cacheHit.value + cacheMiss.value !== input.value) {
    return { usage: null, reason: 'cache_tokens_do_not_reconcile' };
  }

  return {
    usage: {
      inputTokens: input.value,
      ...(hitKnown ? { cacheHitInputTokens: cacheHit.value, cacheMissInputTokens: cacheMiss.value } : {}),
      outputTokens: output.value,
      totalTokens: total.value,
    },
    reason: null,
  };
}

export function normalizeProviderUsage(rawOrWrapper) {
  return parseProviderUsage(rawOrWrapper).usage ?? undefined;
}

// Drop-in name for callers that already use browser-acceptance-pricing.providerUsage.
export const providerUsage = normalizeProviderUsage;

function sameUsage(left, right) {
  if (left.inputTokens !== right.inputTokens || left.outputTokens !== right.outputTokens || left.totalTokens !== right.totalTokens) return false;
  const leftHasCache = Number.isSafeInteger(left.cacheHitInputTokens) && Number.isSafeInteger(left.cacheMissInputTokens);
  const rightHasCache = Number.isSafeInteger(right.cacheHitInputTokens) && Number.isSafeInteger(right.cacheMissInputTokens);
  return !(leftHasCache && rightHasCache) ||
    (left.cacheHitInputTokens === right.cacheHitInputTokens && left.cacheMissInputTokens === right.cacheMissInputTokens);
}

function sumUsage(items) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const cacheKnown = items.every(item => Number.isSafeInteger(item.cacheHitInputTokens) && Number.isSafeInteger(item.cacheMissInputTokens));
  for (const item of items) {
    totals.inputTokens += item.inputTokens;
    totals.outputTokens += item.outputTokens;
    totals.totalTokens += item.totalTokens;
    if (cacheKnown) {
      totals.cacheHitInputTokens = (totals.cacheHitInputTokens ?? 0) + item.cacheHitInputTokens;
      totals.cacheMissInputTokens = (totals.cacheMissInputTokens ?? 0) + item.cacheMissInputTokens;
    }
  }
  if (![totals.inputTokens, totals.outputTokens, totals.totalTokens].every(Number.isSafeInteger) ||
      totals.inputTokens + totals.outputTokens !== totals.totalTokens) return null;
  return totals;
}

/** Reconcile each ordered response against its ordered actual-usage journal record. */
export function reconcileProviderUsage({ responses = [], journal = [], dispatchedCalls = 0, unknownUsageCalls = 0 } = {}) {
  if (!Array.isArray(responses) || !Array.isArray(journal) ||
      !Number.isSafeInteger(dispatchedCalls) || dispatchedCalls < 0 ||
      !Number.isSafeInteger(unknownUsageCalls) || unknownUsageCalls < 0) {
    throw evidenceError('PROVIDER_USAGE_RECONCILIATION_INPUT_INVALID');
  }
  const orderedResponses = [...responses].sort((left, right) => (left?.id ?? 0) - (right?.id ?? 0));
  const orderedJournal = [...journal].sort((left, right) => {
    const leftIndex = Number.isSafeInteger(left?.globalCallIndex) ? left.globalCallIndex : left?.callIndex;
    const rightIndex = Number.isSafeInteger(right?.globalCallIndex) ? right.globalCallIndex : right?.callIndex;
    return (leftIndex ?? 0) - (rightIndex ?? 0);
  });
  const aligned = [];
  const actualItems = [];
  let failedAlignments = 0;
  const pairCount = Math.max(orderedResponses.length, orderedJournal.length);
  for (let index = 0; index < pairCount; index += 1) {
    const response = orderedResponses[index];
    const journalEntry = orderedJournal[index];
    const source = response?.payload?.usageSource;
    const responseRaw = response?.payload?.actualProviderUsage;
    const responseParse = responseRaw === null || responseRaw === undefined
      ? { usage: null, reason: 'response_usage_absent' }
      : parseProviderUsage(responseRaw);
    const journalParse = journalEntry
      ? parseProviderUsage(journalEntry.actualProviderUsage ?? journalEntry)
      : { usage: null, reason: 'journal_entry_absent' };
    const responseClaimsActual = source === 'provider_actual' || (source == null && responseRaw != null);
    let usage = null;
    let alignmentStatus;
    if (!response || !journalEntry) {
      alignmentStatus = !response ? 'journal_without_response' : 'response_without_journal';
    } else if (responseRaw != null && responseClaimsActual && !responseParse.usage) {
      alignmentStatus = `response_${responseParse.reason}`;
    } else if (journalParse.usage && responseRaw != null && responseClaimsActual &&
        !sameUsage(journalParse.usage, responseParse.usage)) {
      alignmentStatus = 'response_journal_usage_conflict';
    } else if (journalParse.usage && (responseRaw == null || responseParse.usage || !responseClaimsActual)) {
      usage = journalParse.usage;
      alignmentStatus = responseParse.usage && responseClaimsActual ? 'matched' : 'journal_used';
    } else {
      alignmentStatus = journalParse.reason === 'journal_entry_absent'
        ? 'journal_entry_absent' : `journal_${journalParse.reason}`;
    }
    if (usage) actualItems.push(usage);
    else failedAlignments += 1;
    aligned.push({
      responseEventId: response?.id ?? null,
      responsePhase: response?.payload?.phase ?? null,
      responseStatus: response?.payload?.status ?? null,
      journalCallIndex: journalEntry?.callIndex ?? null,
      globalCallIndex: journalEntry?.globalCallIndex ?? null,
      responseUsageReason: responseParse.reason,
      journalUsageReason: journalParse.reason,
      status: alignmentStatus,
      actualProviderUsage: usage,
    });
  }
  const unknownCalls = Math.max(unknownUsageCalls, dispatchedCalls - actualItems.length, failedAlignments);
  const complete = dispatchedCalls > 0 && actualItems.length === dispatchedCalls &&
    orderedResponses.length === dispatchedCalls && orderedJournal.length === dispatchedCalls && unknownCalls === 0;
  const actualProviderUsage = complete ? sumUsage(actualItems) : null;
  const totalsValid = !complete || actualProviderUsage !== null;
  const finalComplete = complete && totalsValid;
  const reportedUnknownCalls = finalComplete ? 0 : Math.max(unknownCalls, complete && !totalsValid ? 1 : 0);
  return {
    providerUsageComplete: dispatchedCalls > 0 ? finalComplete : null,
    usageUnknown: dispatchedCalls > 0 && !finalComplete || unknownUsageCalls > 0,
    providerUsageUnknownCalls: reportedUnknownCalls,
    actualProviderUsage: finalComplete ? actualProviderUsage : null,
    cacheTokenStatus: finalComplete && Number.isSafeInteger(actualProviderUsage?.cacheHitInputTokens)
      ? 'complete' : 'unknown_or_partial',
    calls: aligned,
    alignment: {
      dispatchedCalls,
      modelResponseEvents: orderedResponses.length,
      journalEntries: orderedJournal.length,
      alignedActualCalls: actualItems.length,
      failedAlignments,
    },
  };
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !(typeof event.id === 'string' && event.id.length > 0) && !Number.isSafeInteger(event.id)) {
    throw evidenceError('EVIDENCE_EVENT_ID_REQUIRED');
  }
}

function browserEventSessionId(event) {
  const sessionId = event.sessionId ?? event.payload?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw evidenceError('EVIDENCE_BROWSER_EVENT_SESSION_ID_REQUIRED');
  return sessionId;
}

class EvidenceWriter {
  constructor({ rootDir, maxFileBytes, maxTotalBytes, maxRecordBytes, io }) {
    this.rootDir = rootDir;
    this.maxFileBytes = positiveLimit(maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'max_file_bytes');
    this.maxTotalBytes = positiveLimit(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'max_total_bytes');
    this.maxRecordBytes = positiveLimit(maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 'max_record_bytes');
    this.io = io;
    this.artifacts = new Map();
    this.seenIds = new Map();
    this.createdCells = new Set();
    this.tail = Promise.resolve();
    this.failure = null;
  }

  serialize(operation) {
    const result = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      try { return await operation(); }
      catch (cause) {
        this.failure = cause;
        throw cause;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async ensureCell(cellId) {
    const cellDirectory = safeCellDirectory(cellId);
    if (this.createdCells.has(cellDirectory)) return cellDirectory;
    await this.io.mkdir(resolve(this.rootDir, cellDirectory), { recursive: false, mode: 0o700 });
    this.createdCells.add(cellDirectory);
    return cellDirectory;
  }

  async atomicWrite(relativePath, bytes) {
    const target = resolve(this.rootDir, relativePath);
    if (!withinRoot(this.rootDir, target)) throw evidenceError('EVIDENCE_PATH_ESCAPE');
    const previous = this.artifacts.get(relativePath);
    const projectedTotal = this.totalBytes() - (previous?.lengthBytes ?? 0) + bytes.length;
    if (bytes.length > this.maxFileBytes || projectedTotal > this.maxTotalBytes) {
      throw evidenceError('EVIDENCE_LIMIT_EXCEEDED');
    }
    const temporary = `${target}.tmp-${randomUUID()}`;
    const handle = await this.io.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await this.io.rename(temporary, target);
      await this.syncDirectory(dirname(target));
    } catch (cause) {
      await handle.close().catch(() => {});
      await this.io.unlink(temporary).catch(() => {});
      throw cause;
    }
    this.artifacts.set(relativePath, { lengthBytes: bytes.length, sha256: sha256(bytes) });
    await this.writeManifest();
  }

  async append(relativePath, stream, events) {
    if (!Array.isArray(events)) throw evidenceError('EVIDENCE_EVENTS_MUST_BE_ARRAY');
    const serialized = [];
    const pending = new Map();
    for (const event of events) {
      validateEvent(event);
      const sessionId = stream === 'browser' ? browserEventSessionId(event) : '';
      const identity = `${relativePath}\u0000${sessionId}\u0000${String(event.id)}`;
      const bytes = serializeEvidence({ trustBoundary: 'untrusted_harness_or_browser_data', event }, 0);
      const record = Buffer.from(bytes.toString('utf8').replace(/\n$/, '') + '\n', 'utf8');
      if (record.length > this.maxRecordBytes) throw evidenceError('EVIDENCE_RECORD_LIMIT_EXCEEDED');
      const digest = sha256(record);
      const existingDigest = pending.get(identity) ?? this.seenIds.get(identity);
      if (existingDigest !== undefined) {
        if (existingDigest !== digest) throw evidenceError('EVIDENCE_EVENT_ID_CONFLICT');
        continue;
      }
      pending.set(identity, digest);
      serialized.push({ identity, digest, record });
    }
    if (!serialized.length) return { appended: 0, duplicates: events.length };
    const previous = this.artifacts.get(relativePath);
    const previousLength = previous?.lengthBytes ?? 0;
    const appendBytes = serialized.reduce((sum, item) => sum + item.record.length, 0);
    const projectedLength = previousLength + appendBytes;
    if (projectedLength > this.maxFileBytes || this.totalBytes() + appendBytes > this.maxTotalBytes) {
      throw evidenceError('EVIDENCE_LIMIT_EXCEEDED');
    }
    const target = resolve(this.rootDir, relativePath);
    const handle = await this.io.open(target, 'a', 0o600);
    try {
      for (const item of serialized) await handle.writeFile(item.record);
      await handle.sync();
      await handle.close();
    } catch (cause) {
      await handle.close().catch(() => {});
      try {
        const restore = await this.io.open(target, 'r+');
        try { await restore.truncate(previousLength); await restore.sync(); }
        finally { await restore.close(); }
      } catch { /* Preserve the prior durable prefix if rollback is unavailable. */ }
      throw cause;
    }
    const nextHash = previous?.hashState?.copy() ?? createHash('sha256');
    for (const item of serialized) {
      nextHash.update(item.record);
      this.seenIds.set(item.identity, item.digest);
    }
    const nextDigest = nextHash.copy().digest('hex');
    this.artifacts.set(relativePath, { lengthBytes: projectedLength, sha256: nextDigest, hashState: nextHash });
    await this.writeManifest();
    return { appended: serialized.length, duplicates: events.length - serialized.length };
  }

  totalBytes() {
    let total = 0;
    for (const artifact of this.artifacts.values()) total += artifact.lengthBytes;
    return total;
  }

  async writeManifest() {
    const artifacts = Object.fromEntries([...this.artifacts.entries()].map(([path, item]) => [path, {
      lengthBytes: item.lengthBytes,
      sha256: item.sha256,
    }]));
    const manifest = {
      schemaVersion: 1,
      trustBoundary: 'captured page and tool contents are untrusted data',
      updatedAt: new Date().toISOString(),
      totalBytes: this.totalBytes(),
      artifactCount: Object.keys(artifacts).length,
      artifacts,
    };
    const bytes = serializeEvidence(manifest);
    const target = resolve(this.rootDir, 'evidence-manifest.json');
    const temporary = `${target}.tmp-${randomUUID()}`;
    const handle = await this.io.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await this.io.rename(temporary, target);
      await this.syncDirectory(this.rootDir);
    } catch (cause) {
      await handle.close().catch(() => {});
      await this.io.unlink(temporary).catch(() => {});
      throw cause;
    }
  }

  async syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const handle = await this.io.open(directory, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  writeJson(cellId, filename, value) {
    return this.serialize(async () => {
      const cellDirectory = await this.ensureCell(cellId);
      const bytes = serializeEvidence(value);
      if (bytes.length > this.maxRecordBytes) throw evidenceError('EVIDENCE_RECORD_LIMIT_EXCEEDED');
      await this.atomicWrite(`${cellDirectory}/${filename}`, bytes);
      return { path: `${cellDirectory}/${filename}`, lengthBytes: bytes.length, sha256: sha256(bytes) };
    });
  }

  writeCellSnapshot(cellId, snapshot) {
    return this.writeJson(cellId, 'run-snapshot.json', {
      trustBoundary: 'run and tool payloads are captured as untrusted data',
      snapshot,
    });
  }

  writeCellResult(cellId, result) {
    return this.writeJson(cellId, 'structured-result.json', result);
  }

  appendHarnessEvents(cellId, events) {
    return this.serialize(async () => {
      const cellDirectory = await this.ensureCell(cellId);
      return this.append(`${cellDirectory}/harness-events.jsonl`, 'harness', events);
    });
  }

  appendBrowserEvents(cellId, events) {
    return this.serialize(async () => {
      const cellDirectory = await this.ensureCell(cellId);
      return this.append(`${cellDirectory}/browser-events.jsonl`, 'browser', events);
    });
  }

  writeBrowserSessions(cellId, sessions) {
    return this.writeJson(cellId, 'browser-sessions.json', { trustBoundary: 'browser session data is untrusted', sessions });
  }

  writeBrowserCommands(cellId, commands) {
    return this.writeJson(cellId, 'browser-commands.json', { trustBoundary: 'browser command data is untrusted', commands });
  }

  writePageObservations(cellId, observations) {
    return this.writeJson(cellId, 'page-observations.json', { trustBoundary: 'page observations are untrusted', observations });
  }

  writeProviderJournal(cellId, journal) {
    return this.writeJson(cellId, 'provider-usage-journal.json', journal);
  }

  async writeCellEvidence(cellId, evidence) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw evidenceError('EVIDENCE_CELL_PAYLOAD_INVALID');
    if (Object.hasOwn(evidence, 'runSnapshot')) await this.writeCellSnapshot(cellId, evidence.runSnapshot);
    if (Object.hasOwn(evidence, 'result') || Object.hasOwn(evidence, 'error')) {
      await this.writeCellResult(cellId, { result: evidence.result ?? null, error: evidence.error ?? null });
    }
    if (Object.hasOwn(evidence, 'harnessEvents')) await this.appendHarnessEvents(cellId, evidence.harnessEvents);
    if (Object.hasOwn(evidence, 'browserSessions')) await this.writeBrowserSessions(cellId, evidence.browserSessions);
    if (Object.hasOwn(evidence, 'browserCommands')) await this.writeBrowserCommands(cellId, evidence.browserCommands);
    if (Object.hasOwn(evidence, 'browserEvents')) await this.appendBrowserEvents(cellId, evidence.browserEvents);
    if (Object.hasOwn(evidence, 'pageObservations')) await this.writePageObservations(cellId, evidence.pageObservations);
    if (Object.hasOwn(evidence, 'providerUsageJournal')) await this.writeProviderJournal(cellId, evidence.providerUsageJournal);
  }

  async close() {
    await this.tail;
    if (this.failure) throw this.failure;
  }
}

function withinRoot(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Create a writer only at a new, independent evidence directory; failures are sticky and propagate. */
export async function createEvidenceWriter({
  rootDir,
  maxFileBytes,
  maxTotalBytes,
  maxRecordBytes,
  io = fs,
} = {}) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) throw evidenceError('EVIDENCE_ROOT_MUST_BE_ABSOLUTE');
  const resolvedRoot = resolve(rootDir);
  await io.mkdir(resolvedRoot, { recursive: false, mode: 0o700 });
  const writer = new EvidenceWriter({ rootDir: resolvedRoot, maxFileBytes, maxTotalBytes, maxRecordBytes, io });
  try { await writer.writeManifest(); }
  catch (cause) { writer.failure = cause; throw cause; }
  return writer;
}
