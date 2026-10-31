import { isAbsolute } from 'node:path';
import { PostgresBrowserStore } from './postgres-store.mjs';
import { BrowserProfileVault } from './profile-vault.mjs';
import { BrowserRuntime } from './runtime.mjs';
import { createPlaywrightDriver } from './playwright-driver.mjs';
import { createBrowserToolProvider } from './provider.mjs';

/** Called only during explicitly enabled service startup; imports launch nothing. */
export async function configureBrowserProvider(config, { workspaceRoot }) {
  const fields = ['enabled', 'allowedOrigins', 'databaseEnv', 'executablePath', 'allowHttp', 'maxSessions', 'maxOwnerSessions', 'leaseMs', 'ttlMs', 'idleMs', 'timeoutMs', 'profiles'];
  if (!config || Array.isArray(config) || config.enabled !== true || Object.keys(config).some(k => !fields.includes(k))) throw new Error('Browser configuration must be explicitly enabled and contain known fields only');
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || config.allowedOrigins.length > 32) throw new Error('Browser requires a bounded origin allowlist');
  const databaseEnv = config.databaseEnv ?? 'MICRO_DSH_BROWSER_DATABASE_URL';
  if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(databaseEnv) || !process.env[databaseEnv]) throw new Error('Browser PostgreSQL configuration is missing');
  if (config.executablePath !== undefined && !isAbsolute(config.executablePath)) throw new Error('Browser executable must be an absolute trusted path');
  let vault, store, driver;
  try {
    if (config.profiles) {
      const p = config.profiles;
      if (!p || Array.isArray(p) || Object.keys(p).some(k => !['root', 'keyEnv', 'byOwner'].includes(k)) || !isAbsolute(p.root ?? '') || !/^[A-Z][A-Z0-9_]{0,100}$/.test(p.keyEnv ?? '') || !p.byOwner || Array.isArray(p.byOwner) || Object.entries(p.byOwner).some(([owner, id]) => !owner || owner.length > 256 || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('Invalid private browser profile configuration');
      vault = new BrowserProfileVault({ root: p.root, keyBase64: process.env[p.keyEnv], workspaceRoot });
    }
    driver = await createPlaywrightDriver({ allowedOrigins: config.allowedOrigins, executablePath: config.executablePath, allowHttp: config.allowHttp ?? false, timeoutMs: config.timeoutMs ?? 10_000, headless: true });
    store = await PostgresBrowserStore.connect(process.env[databaseEnv]);
    const runtime = new BrowserRuntime({ store, driver, vault, ...Object.fromEntries(['maxSessions', 'maxOwnerSessions', 'leaseMs', 'ttlMs', 'idleMs'].filter(k => config[k] !== undefined).map(k => [k, config[k]])) });
    runtime.publicConfig = { allowedOrigins: [...config.allowedOrigins], preview: true };
    await runtime.ready();
    return createBrowserToolProvider({ runtime, profilesByOwner: config.profiles?.byOwner ?? {} });
  } catch (cause) {
    await driver?.close().catch(() => {}); await store?.close().catch(() => {}); vault?.close();
    throw new Error('Browser startup failed; check non-secret configuration, database and dependencies.', { cause: undefined });
  }
}
