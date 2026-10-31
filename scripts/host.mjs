/** Node host ports: explicit local process execution and JSON checkpoints only. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InMemoryTaskStore } from '../dist/session/task-store.js';
import { InMemoryMemoryStore } from '../dist/memory/store.js';

export class FileTaskStore extends InMemoryTaskStore {
  constructor(file) {
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schema_version: 1, tasks: [] };
    if (data.schema_version !== 1 || !Array.isArray(data.tasks)) throw new Error('Unsupported checkpoint format');
    super(data.tasks);
    this.file = file;
  }
  flush() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schema_version: 1, tasks: this.snapshot() }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  async create(task) { const value = await super.create(task); this.flush(); return value; }
  async update(task) { const value = await super.update(task); this.flush(); return value; }
  async delete(taskId) { const value = await super.delete(taskId); this.flush(); return value; }
}

/** Persisted namespace/TTL records; callers receive namespace-scoped capabilities. */
export class FileMemoryStore extends InMemoryMemoryStore {
  constructor(file) {
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schema_version: 1, records: [] };
    if (data.schema_version !== 1 || !Array.isArray(data.records)) throw new Error('Unsupported memory format');
    super(data.records);
    this.file = file;
  }
  flush() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schema_version: 1, records: this.snapshot() }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  async create(record) { const value = await super.create(record); this.flush(); return value; }
  async update(record) { const value = await super.update(record); this.flush(); return value; }
  async delete(namespace, id) { const value = await super.delete(namespace, id); this.flush(); return value; }
}

/** Exclusive single-host writer; stale locks require explicit human inspection. */
export function lockState(directory) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const path = join(root, 'writer.lock');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new Error('Checkpoint is locked. Check for an active writer before removing writer.lock.'); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
  return () => { closeSync(fd); unlinkSync(path); };
}

export function searchForgeTool({ python = 'python', script, index, maxOutputBytes = 2_000_000 }) {
  return async (input, context) => {
    if (!input || typeof input.query !== 'string' || !input.query.trim()) {
      return { ok: false, error: { code: 'BAD_QUERY', message: 'query must be a nonempty string' }, evidence: [] };
    }
    if (context.signal?.aborted) return { ok: false, error: { code: 'CANCELLED', message: 'Search cancelled' }, evidence: [] };
    return await new Promise(resolveResult => {
      // No arbitrary command, shell expansion, model invocation or API keys cross this port.
      const child = spawn(python, [resolve(script), '--index', resolve(index)], {
        shell: false, windowsHide: true, signal: context.signal,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
          TMP: process.env.TMP, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output = [];
      let bytes = 0;
      let settled = false;
      const finish = result => { if (!settled) { settled = true; resolveResult(result); } };
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          child.kill();
          finish({ ok: false, error: { code: 'OUTPUT_LIMIT', message: 'Search output exceeded its byte budget' }, evidence: [] });
        } else output.push(chunk);
      });
      // Drain stderr; never include arbitrary process logs in a model-facing error.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', () => finish({ ok: false, error: {
        code: context.signal?.aborted ? 'CANCELLED' : 'SEARCH_PROCESS',
        message: context.signal?.aborted ? 'Search cancelled' : 'Search process failed to start',
      }, evidence: [] }));
      child.on('close', code => {
        if (code !== 0) return finish({ ok: false, error: { code: 'SEARCH_PROCESS', message: `Search exited with code ${code}` }, evidence: [] });
        try {
          const envelope = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (typeof envelope.ok !== 'boolean' || !Array.isArray(envelope.evidence)) throw new Error('Bad envelope');
          finish(envelope);
        } catch { finish({ ok: false, error: { code: 'SEARCH_PROTOCOL', message: 'Search did not return a JSON result envelope' }, evidence: [] }); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  };
}
