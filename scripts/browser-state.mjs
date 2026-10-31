import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [action, ...rawArgs] = process.argv.slice(2);
if (!['backup', 'restore'].includes(action)) throw new Error('Usage: node scripts/browser-state.mjs backup|restore [options]');
let currentPhase = 'argument_validation';
let activeReceiptPath;

const options = new Map();
const flags = new Set();
for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  if (arg === '--confirm-fresh-target') { flags.add(arg); continue; }
  if (!['--tool-config', '--destination', '--source', '--profiles-destination', '--receipt', '--service-target-env', '--browser-target-env', '--service-unit'].includes(arg) ||
      !rawArgs[index + 1] || rawArgs[index + 1].startsWith('--')) {
    throw new Error('See docs/BROWSER_RECOVERY_20261028.md for browser-state backup and restore options');
  }
  if (options.has(arg)) throw new Error(`Duplicate option: ${arg}`);
  options.set(arg, rawArgs[++index]);
}

function outsideProject(path) {
  const rel = relative(projectRoot, path);
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);
}

function abs(value, option) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n]/.test(value)) throw new Error(`${option} must be an absolute path`);
  const path = resolve(value);
  if (!outsideProject(path)) throw new Error(`${option} must be outside the project workspace`);
  return path;
}

function toolConfigPath() {
  return abs(options.get('--tool-config') ?? process.env.MICRO_DSH_TOOL_CONFIG, '--tool-config');
}

async function readToolConfig(path) {
  const fileStat = await lstat(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0 || await realpath(path) !== path) {
    throw new Error('Tool configuration must be a real owner-only private file');
  }
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Tool configuration is not valid JSON'); }
  if (!config || Array.isArray(config) || typeof config !== 'object' || !config.browser || typeof config.browser !== 'object') {
    throw new Error('Browser configuration is missing');
  }
  const profiles = config.browser.profiles;
  if (!profiles || !isAbsolute(profiles.root ?? '') || typeof profiles.keyEnv !== 'string' ||
      !profiles.byOwner || Array.isArray(profiles.byOwner) || typeof profiles.byOwner !== 'object') {
    throw new Error('Encrypted browser profile configuration is required');
  }
  const databaseEnv = config.browser.databaseEnv ?? 'MICRO_DSH_BROWSER_DATABASE_URL';
  if (typeof databaseEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(databaseEnv)) throw new Error('Browser database environment name is invalid');
  return { config, profiles, databaseEnv };
}

function dbUrlFromEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Database environment ${name} is unavailable`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Database environment ${name} must contain a PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`Database environment ${name} is not PostgreSQL`);
  return value;
}

function pgEnv(connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid PostgreSQL connection URL'); }
  const environment = { ...process.env };
  environment.PGHOST = url.searchParams.get('host') ?? url.hostname.replace(/^\[|\]$/g, '');
  environment.PGPORT = url.searchParams.get('port') ?? url.port ?? '5432';
  environment.PGDATABASE = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  const sslMap = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY' };
  for (const [query, name] of Object.entries(sslMap)) if (url.searchParams.has(query)) environment[name] = url.searchParams.get(query);
  if (url.searchParams.has('options')) environment.PGOPTIONS = url.searchParams.get('options');
  environment.PGAPPNAME = 'mini-dsh-browser-state';
  environment.PGCONNECT_TIMEOUT ??= '10';
  return environment;
}

function fingerprint(identity) {
  return createHash('sha256').update(JSON.stringify([identity.server, identity.port, identity.database])).digest('hex');
}

async function withPool(connectionString, work, applicationName = 'mini-dsh-browser-state') {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 2, application_name: applicationName });
  try { return await work(pool); } finally { await pool.end(); }
}

async function dbIdentity(connectionString) {
  return withPool(connectionString, async pool => {
    const result = await pool.query(`SELECT COALESCE(inet_server_addr()::text, current_setting('unix_socket_directories')) AS server,
      COALESCE(inet_server_port(), 0) AS port,current_database() AS database`);
    const identity = result.rows[0];
    if (!identity || typeof identity.database !== 'string' || !identity.database) throw new Error('PostgreSQL identity could not be verified');
    return { server: String(identity.server), port: Number(identity.port), database: identity.database };
  }, 'mini-dsh-browser-state-identity');
}

async function rowCounts(connectionString) {
  return withPool(connectionString, async pool => {
    const tables = await pool.query(`SELECT schemaname,tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY schemaname,tablename`);
    const counts = [];
    for (const table of tables.rows) {
      const quote = value => `"${String(value).replaceAll('"', '""')}"`;
      const result = await pool.query(`SELECT COUNT(*)::text AS count FROM ${quote(table.schemaname)}.${quote(table.tablename)}`);
      counts.push({ schema: table.schemaname, table: table.tablename, rows: result.rows[0].count });
    }
    return counts;
  }, 'mini-dsh-browser-state-counts');
}

function runPgTool(command, args, environment) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawn(command, args, { env: environment, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); }
    catch { reject(new Error(`${command} could not be started`)); return; }
    child.once('error', () => reject(new Error(`${command} could not be started`)));
    child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`${command} failed with exit code ${code ?? 'unknown'}`)));
  });
}

async function syncFile(path) {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

async function listProfileFiles(root) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error('Profile vault root must be a private real directory');
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Profile vault contains a symbolic link');
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const directoryStat = await lstat(path);
        if ((directoryStat.mode & 0o077) !== 0) throw new Error('Profile vault contains a non-private directory');
        await visit(path, relativePath);
      }
      else if (entry.isFile() && /^[a-f0-9]{64}\.state\.enc$/.test(entry.name) && !relativePath.includes('/')) {
        const fileStat = await lstat(path);
        if ((fileStat.mode & 0o077) !== 0) throw new Error('Profile vault contains a non-private file');
        const contents = await readFile(path);
        if (contents.length > 4 * 1024 * 1024) throw new Error('Encrypted profile file exceeds the configured backup limit');
        files.push({ path: relativePath, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
      } else throw new Error('Profile vault contains an unexpected file');
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function copyProfileTree(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Profile vault contains a symbolic link');
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyProfileTree(from, to);
      await chmod(to, 0o700);
    } else {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.state\.enc$/.test(entry.name)) throw new Error('Profile vault contains an unexpected entry');
      await copyFile(from, to);
      await chmod(to, 0o600);
    }
  }
  await chmod(destination, 0o700);
}

async function hashFiles(root) {
  const records = await listProfileFiles(root);
  return records;
}

function safeDestination(value, option) { return abs(value, option); }

async function assertUnitStopped(unit) {
  const result = await new Promise(resolvePromise => {
    const child = spawn('systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => resolvePromise({ code: null, output: '' }));
    child.once('close', code => resolvePromise({ code, output: output.trim() }));
  });
  if (result.code !== 0 || !['inactive', 'failed'].includes(result.output)) throw new Error('Stop the mini-DSH browser service before creating a state backup');
}

async function acquireBrowserLock(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 1, application_name: 'mini-dsh-browser-state-backup' });
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('mini-dsh-browser-runtime', 0)) AS acquired");
    if (result.rows[0]?.acquired !== true) throw new Error('Browser runtime still owns the database lock');
    return { pool, client };
  } catch (cause) {
    client.release();
    await pool.end();
    throw cause;
  }
}

async function releaseBrowserLock(lock) {
  if (!lock) return;
  await lock.client.query("SELECT pg_advisory_unlock(hashtextextended('mini-dsh-browser-runtime', 0))").catch(() => {});
  lock.client.release();
  await lock.pool.end().catch(() => {});
}

async function emptyDatabase(connectionString) {
  return withPool(connectionString, async pool => {
    const result = await pool.query(`SELECT
      (SELECT COUNT(*) FROM pg_class AS c JOIN pg_namespace AS n ON n.oid=c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         AND c.relkind IN ('r','p','v','m','S','f')) +
      (SELECT COUNT(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public')
       AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\') AS count`);
    return Number(result.rows[0].count) === 0;
  }, 'mini-dsh-browser-state-restore-check');
}

async function verifyBackup(source) {
  const manifestPath = join(source, 'manifest.json');
  const fileStat = await lstat(manifestPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Backup manifest is not a regular file');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new Error('Backup manifest is invalid'); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.databases) || !Array.isArray(manifest.profiles) ||
      typeof manifest.createdAt !== 'string' || manifest.databases.length < 1 || manifest.databases.length > 2) {
    throw new Error('Backup manifest version is unsupported');
  }
  const manifestContents = await readFile(manifestPath);
  const manifestHash = createHash('sha256').update(manifestContents).digest('hex');
  const hashPath = join(source, 'manifest.sha256');
  const hashStat = await lstat(hashPath);
  if (!hashStat.isFile() || hashStat.isSymbolicLink() || (hashStat.mode & 0o077) !== 0 ||
      (await readFile(hashPath, 'utf8')).trim() !== manifestHash) throw new Error('Backup manifest hash does not match');
  const seenRoles = new Set();
  const seenFiles = new Set();
  for (const database of manifest.databases) {
    if (!/^[a-z0-9_-]+\.dump$/.test(database.file) || seenFiles.has(database.file) || !Array.isArray(database.roles) ||
        !database.roles.length || database.roles.some(role => !['service', 'browser'].includes(role)) ||
        new Set(database.roles).size !== database.roles.length || database.roles.some(role => seenRoles.has(role)) ||
        typeof database.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(database.sourceFingerprint) ||
        typeof database.sourceDatabase !== 'string' || !database.sourceDatabase || !Array.isArray(database.rowCounts)) throw new Error('Backup manifest database entry is invalid');
    for (const role of database.roles) seenRoles.add(role);
    seenFiles.add(database.file);
    const path = join(source, database.file);
    const dumpStat = await lstat(path);
    if (!dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.size < 1) throw new Error('Database dump is missing or invalid');
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== database.sha256) throw new Error('Database dump hash does not match the manifest');
  }
  if (seenRoles.size !== 2 || !seenRoles.has('service') || !seenRoles.has('browser')) {
    throw new Error('Backup manifest must cover both service and browser databases');
  }
  const profileRoot = join(source, 'profile-vault');
  const profileStat = await lstat(profileRoot);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) throw new Error('Profile backup directory is missing or invalid');
  const actualProfiles = await hashFiles(profileRoot);
  if (JSON.stringify(actualProfiles) !== JSON.stringify(manifest.profiles)) throw new Error('Encrypted profile file hashes do not match the manifest');
  if (manifest.profiles.some(profile => typeof profile.path !== 'string' || !/^[a-f0-9]{64}\.state\.enc$/.test(profile.path) ||
      !Number.isSafeInteger(profile.size) || profile.size < 1 || !/^[a-f0-9]{64}$/.test(profile.sha256))) throw new Error('Backup profile manifest entry is invalid');
  return manifest;
}

async function backup() {
  const privatePath = toolConfigPath();
  const { profiles, databaseEnv } = await readToolConfig(privatePath);
  const serviceUrl = dbUrlFromEnv('MICRO_DSH_DATABASE_URL');
  const browserUrl = dbUrlFromEnv(databaseEnv);
  const sourceProfileRoot = abs(profiles.root, 'browser profile root');
  const destination = safeDestination(options.get('--destination'), '--destination');
  const unit = options.get('--service-unit') ?? 'mini-dsh-browser.service';
  if (!/^[A-Za-z0-9_.@:-]{1,128}$/.test(unit)) throw new Error('Invalid systemd user service name');
  await assertUnitStopped(unit);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error('Backup parent cannot be a symlink or alias');
  try { await lstat(destination); throw new Error('Backup destination already exists'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }

  const lock = await acquireBrowserLock(browserUrl);
  const temporary = `${destination}.tmp-${process.pid}`;
  let temporaryCreated = false;
  let committed = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    temporaryCreated = true;
    const identities = await Promise.all([dbIdentity(serviceUrl), dbIdentity(browserUrl)]);
    const unique = new Map();
    for (const [index, role] of ['service', 'browser'].entries()) {
      const identity = identities[index];
      const key = fingerprint(identity);
      const prior = unique.get(key);
      if (prior) prior.roles.push(role);
      else unique.set(key, { roles: [role], identity, connectionString: index === 0 ? serviceUrl : browserUrl });
    }
    const databases = [];
    for (const [index, item] of [...unique.values()].entries()) {
      const file = `database-${index + 1}.dump`;
      const path = join(temporary, file);
      const rows = await rowCounts(item.connectionString);
      const environment = pgEnv(item.connectionString);
      await runPgTool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--no-password', '--file', path,
        '--dbname', environment.PGDATABASE], environment);
      await syncFile(path);
      const contents = await readFile(path);
      databases.push({ roles: item.roles, file, sourceFingerprint: fingerprint(item.identity), sourceDatabase: item.identity.database,
        sha256: createHash('sha256').update(contents).digest('hex'), rowCounts: rows });
    }
    const profileManifest = await listProfileFiles(sourceProfileRoot);
    await copyProfileTree(sourceProfileRoot, join(temporary, 'profile-vault'));
    const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), consistency: 'service-unit-stopped-and-browser-runtime-lock-held',
      databases, profiles: profileManifest };
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    const manifestFile = await open(join(temporary, 'manifest.json'), 'wx', 0o600);
    try { await manifestFile.writeFile(manifestText, 'utf8'); await manifestFile.sync(); }
    finally { await manifestFile.close(); }
    const manifestHash = createHash('sha256').update(manifestText).digest('hex');
    const hashFile = await open(join(temporary, 'manifest.sha256'), 'wx', 0o600);
    try { await hashFile.writeFile(`${manifestHash}\n`, 'utf8'); await hashFile.sync(); }
    finally { await hashFile.close(); }
    await rename(temporary, destination);
    committed = true;
    process.stdout.write(`${JSON.stringify({ backupCreated: true, destination, databaseSnapshots: databases.length, profileFiles: profileManifest.length,
      consistency: manifest.consistency })}\n`);
  } finally {
    await releaseBrowserLock(lock);
    if (temporaryCreated && !committed) await rm(temporary, { recursive: true, force: true });
  }
}

async function restore() {
  currentPhase = 'verify_fresh_target_flag';
  if (!flags.has('--confirm-fresh-target')) throw new Error('Restore requires --confirm-fresh-target after the target PostgreSQL database has been created empty');
  currentPhase = 'validate_restore_receipt_path';
  const receiptPath = safeDestination(options.get('--receipt'), '--receipt');
  try { await lstat(receiptPath); throw new Error('Restore receipt already exists'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const receiptParent = dirname(receiptPath);
  const receiptParentStat = await lstat(receiptParent);
  if (!receiptParentStat.isDirectory() || receiptParentStat.isSymbolicLink() || (receiptParentStat.mode & 0o077) !== 0 ||
      await realpath(receiptParent) !== receiptParent) throw new Error('Restore receipt parent must be an existing real private directory');
  activeReceiptPath = receiptPath;
  currentPhase = 'read_private_configuration';
  const privatePath = toolConfigPath();
  const { profiles } = await readToolConfig(privatePath);
  currentPhase = 'verify_backup';
  const source = safeDestination(options.get('--source'), '--source');
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || await realpath(source) !== source) throw new Error('Backup source must be a real directory');
  const manifest = await verifyBackup(source);
  currentPhase = 'identify_target_databases';
  const serviceTargetEnv = options.get('--service-target-env') ?? 'MICRO_DSH_RESTORE_SERVICE_DATABASE_URL';
  const browserTargetEnv = options.get('--browser-target-env') ?? 'MICRO_DSH_RESTORE_BROWSER_DATABASE_URL';
  for (const name of [serviceTargetEnv, browserTargetEnv]) if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(name)) throw new Error('Restore database environment name is invalid');
  const targetByRole = { service: dbUrlFromEnv(serviceTargetEnv), browser: dbUrlFromEnv(browserTargetEnv) };
  const identityByRole = { service: await dbIdentity(targetByRole.service), browser: await dbIdentity(targetByRole.browser) };
  const targetFingerprintByRole = { service: fingerprint(identityByRole.service), browser: fingerprint(identityByRole.browser) };
  const usedTargets = new Set();
  for (const database of manifest.databases) {
    const targetRoles = database.roles.map(role => targetFingerprintByRole[role]);
    if (targetRoles.some(value => !value) || new Set(targetRoles).size !== 1) throw new Error('Roles sharing one backup must target the same fresh database');
    const targetFingerprint = targetRoles[0];
    if (targetFingerprint === database.sourceFingerprint) {
      throw new Error('Restore target matches the source database; a new database is required');
    }
    if (usedTargets.has(targetFingerprint)) throw new Error('Separate backups cannot be restored into the same database');
    usedTargets.add(targetFingerprint);
    const role = database.roles[0];
    currentPhase = `verify_empty_${role}_target`;
    if (!await emptyDatabase(targetByRole[role])) throw new Error('Restore target database must be empty');
  }
  const profileDestination = safeDestination(options.get('--profiles-destination'), '--profiles-destination');
  try { await lstat(profileDestination); throw new Error('Profile restore destination already exists'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const profileParent = dirname(profileDestination);
  if (await realpath(profileParent) !== profileParent) throw new Error('Profile restore parent cannot be a symlink or alias');
  const restored = [];
  for (const database of manifest.databases) {
    const role = database.roles[0];
    currentPhase = `restore_${role}_database_dump`;
    const environment = pgEnv(targetByRole[role]);
    await runPgTool('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--no-password',
      '--dbname', environment.PGDATABASE, join(source, database.file)], environment);
    currentPhase = `verify_${role}_row_counts`;
    const counts = await rowCounts(targetByRole[role]);
    if (JSON.stringify(counts) !== JSON.stringify(database.rowCounts)) throw new Error(`Restored ${role} database row counts do not match the backup manifest`);
    restored.push({ roles: database.roles, fingerprint: targetFingerprintByRole[role], tables: counts.length });
  }
  currentPhase = 'copy_encrypted_profiles';
  await copyProfileTree(join(source, 'profile-vault'), profileDestination);
  currentPhase = 'verify_encrypted_profile_hashes';
  const copiedProfiles = await hashFiles(profileDestination);
  if (JSON.stringify(copiedProfiles) !== JSON.stringify(manifest.profiles)) throw new Error('Restored profile hashes do not match the backup manifest');
  const key = process.env[profiles.keyEnv];
  currentPhase = 'verify_profile_key_decryption';
  if (copiedProfiles.length && !key) throw new Error(`Profile key environment ${profiles.keyEnv} is required to verify restored encrypted profiles`);
  if (key) {
    const { BrowserProfileVault } = await import('../service/browser/profile-vault.mjs');
    const vault = new BrowserProfileVault({ root: profileDestination, keyBase64: key, workspaceRoot: projectRoot });
    try {
      const expectedNames = new Set(Object.entries(profiles.byOwner).map(([owner, profileId]) => vault.name(owner, profileId)));
      const actualNames = new Set(copiedProfiles.map(profile => profile.path));
      if ([...actualNames].some(name => !expectedNames.has(name))) {
        throw new Error('Configured owner/profile mappings do not cover every restored profile file');
      }
      for (const [owner, profileId] of Object.entries(profiles.byOwner)) {
        const name = vault.name(owner, profileId);
        const path = join(profileDestination, name);
        try { await lstat(path); await vault.load(owner, profileId); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
    } finally { vault.close(); }
  }
  currentPhase = 'write_restore_receipt';
  const receipt = { schemaVersion: 1, verifiedAt: new Date().toISOString(), backupCreatedAt: manifest.createdAt,
    targetDatabasesFreshAndDistinctFromSources: true, databases: restored, profileFiles: copiedProfiles.length,
    profileCiphertextHashesVerified: true, profileKeyDecryptionVerified: copiedProfiles.length > 0 && Boolean(key), serviceStarted: false };
  const receiptHandle = await open(receiptPath, 'wx', 0o600);
  try { await receiptHandle.writeFile(JSON.stringify(receipt, null, 2) + '\n', 'utf8'); await receiptHandle.sync(); }
  finally { await receiptHandle.close(); }
  process.stdout.write(`${JSON.stringify({ restoreVerified: true, receipt: receiptPath, databases: restored.length, profileFiles: copiedProfiles.length,
    targetDatabasesFreshAndDistinctFromSources: true, serviceStarted: false })}\n`);
}

try {
  if (action === 'backup') await backup();
  else await restore();
} catch (cause) {
  if (action === 'restore' && activeReceiptPath) {
    const failureMessage = typeof cause?.message === 'string' ? cause.message : '';
    const failureCode = /^[A-Za-z0-9 _.-]{1,100}$/.test(failureMessage)
      ? failureMessage.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)
      : 'RESTORE_STEP_FAILED';
    const failurePath = `${activeReceiptPath}.failure.json`;
    const failureRecord = { schemaVersion: 1, action: 'restore', status: 'failed', phase: currentPhase,
      failureType: typeof cause?.name === 'string' ? cause.name : 'Error', failureCode };
    const failureHandle = await open(failurePath, 'wx', 0o600).catch(() => undefined);
    if (failureHandle) {
      try { await failureHandle.writeFile(JSON.stringify(failureRecord, null, 2) + '\n', 'utf8'); await failureHandle.sync(); }
      finally { await failureHandle.close(); }
    }
  }
  process.stderr.write(`browser-state ${action}: failed; sensitive connection details were not emitted.\n`);
  process.exitCode = 1;
}
