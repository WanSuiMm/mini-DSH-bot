import { spawn } from 'node:child_process';

const MAX_DELAY_MS = 60_000;
const RESET_AFTER_MS = 5 * 60_000;
let stopping = false;
let child;
let sleepTimer;
let wakePause;
const recentFailures = [];

function requestStop(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(sleepTimer);
  sleepTimer = undefined;
  wakePause?.();
  child?.kill(signal);
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

function startService() {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let settled = false;
    child = spawn(process.execPath, ['scripts/serve.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const finish = result => {
      if (settled) return;
      settled = true;
      child = undefined;
      resolve({ ...result, uptimeMs: Date.now() - startedAt });
    };
    child.once('error', () => finish({ code: null, signal: null, spawnError: true }));
    child.once('close', (code, signal) => finish({ code, signal, spawnError: false }));
  });
}

function pause(milliseconds) {
  return new Promise(resolve => {
    wakePause = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = undefined;
      wakePause = undefined;
      resolve();
    }, milliseconds);
  });
}

let delayMs = 1_000;
while (!stopping) {
  const exit = await startService();
  if (stopping) break;
  if (exit.uptimeMs >= RESET_AFTER_MS) {
    delayMs = 1_000;
    recentFailures.length = 0;
  }
  const now = Date.now();
  recentFailures.push(now);
  while (recentFailures.length && now - recentFailures[0] > 5 * 60_000) recentFailures.shift();
  if (recentFailures.length >= 10) {
    process.stderr.write(`${JSON.stringify({ service: 'mini-DSH-browser', event: 'restart-window-exhausted', failures: recentFailures.length })}\n`);
    process.exitCode = 1;
    break;
  }
  const waitMs = delayMs;
  delayMs = Math.min(MAX_DELAY_MS, delayMs * 2);
  process.stdout.write(`${JSON.stringify({ service: 'mini-DSH-browser', event: 'child-exited', exitCode: exit.code, signal: exit.signal, spawnError: exit.spawnError, restartDelayMs: waitMs })}\n`);
  await pause(waitMs);
}
