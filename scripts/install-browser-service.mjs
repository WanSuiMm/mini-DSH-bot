import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--replace') { options.set('replace', true); continue; }
  if (!['--env-file', '--profile-root', '--service-unit'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Usage: node scripts/install-browser-service.mjs --env-file ABSOLUTE_PRIVATE_ENV --profile-root ABSOLUTE_PROFILE_ROOT [--service-unit mini-dsh-browser-20261029.service] [--replace]');
  }
  if (options.has(arg)) throw new Error(`Duplicate option: ${arg}`);
  options.set(arg, args[++index]);
}

function pathArg(option) {
  const value = options.get(option);
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n%]/.test(value)) throw new Error(`${option} must be an absolute path without newlines or percent signs`);
  return resolve(value);
}

function outsideWorkspace(path) {
  const rel = relative(workspaceRoot, path);
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);
}

function containsPath(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function ensurePrivateDirectory(path, label) {
  if (!outsideWorkspace(path) || containsPath(path, homedir()) || containsPath(path, workspaceRoot)) {
    throw new Error(`${label} must be a dedicated directory outside the project and its ancestors`);
  }

  const missing = [];
  let current = path;
  while (true) {
    let info;
    try { info = await lstat(current); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw new Error(`${label} has no existing canonical parent`);
      current = parent;
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error(`${label} path must not contain a symlink or alias`);
    }
    if (current === path && (info.mode & 0o777) !== 0o700) {
      throw new Error(`${label} must be an owner-only 0700 directory`);
    }
    break;
  }

  for (const directory of missing.reverse()) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory || (info.mode & 0o777) !== 0o700) {
      throw new Error(`${label} could not be created as a canonical owner-only 0700 directory`);
    }
  }
}

const envFile = pathArg('--env-file');
const profileRoot = pathArg('--profile-root');
const serviceUnit = options.get('--service-unit') ?? 'mini-dsh-browser.service';
if (serviceUnit !== 'mini-dsh-browser.service' && serviceUnit !== 'mini-dsh-browser-20261029.service') {
  throw new Error('Only the legacy C1 browser unit or the authorized dated C1 unit may be installed');
}
if (!outsideWorkspace(envFile) || !outsideWorkspace(profileRoot)) throw new Error('Private environment and profile paths must be outside the project workspace');
const envStat = await lstat(envFile);
if (!envStat.isFile() || envStat.isSymbolicLink() || (envStat.mode & 0o077) !== 0) throw new Error('Private environment file must be a regular file with owner-only permissions');
const envRealPath = await realpath(envFile);
if (envRealPath !== envFile) throw new Error('Private environment file cannot be a symlink or alias');
await ensurePrivateDirectory(profileRoot, 'Profile root');

const unitRoot = resolve(homedir(), '.config', 'systemd', 'user');
const unitPath = resolve(unitRoot, serviceUnit);
await mkdir(unitRoot, { recursive: true, mode: 0o700 });
const nodePath = resolve(process.execPath);
for (const value of [workspaceRoot, nodePath, envFile, profileRoot]) {
  if (/\s/.test(value)) throw new Error('Systemd install paths cannot contain whitespace');
}

const unit = `[Unit]
Description=mini-DSH browser Agent service
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${workspaceRoot}
EnvironmentFile=${envFile}
ExecStart=${nodePath} ${workspaceRoot}/scripts/browser-supervisor.mjs
Restart=on-failure
RestartSec=3s
TimeoutStopSec=60s
KillSignal=SIGTERM
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${profileRoot}
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=default.target
`;

let file;
if (options.get('replace')) {
  try {
    const prior = await lstat(unitPath);
    if (!prior.isFile() || prior.isSymbolicLink()) throw new Error('Existing unit must be a regular file before replacement');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
}
try {
  file = await open(unitPath, options.get('replace') ? 'w' : 'wx', 0o600);
  await file.writeFile(unit, 'utf8');
  await file.sync();
} catch (cause) {
  if (cause.code === 'EEXIST') throw new Error('The user service unit already exists; review it or pass --replace');
  throw cause;
} finally {
  await file?.close().catch(() => {});
}
await chmod(unitPath, 0o600);
process.stdout.write(`${JSON.stringify({ installed: true, unit: serviceUnit, unitPath, restart: 'exponential 1s to 60s; reset after 5m stable', startLimitBurst: 10, startLimitIntervalSec: 300 })}\n`);
