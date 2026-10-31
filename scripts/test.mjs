import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit', shell: false });
if (result.status !== 0) process.exit(result.status ?? 1);
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(x => x.endsWith('.test.mjs')).map(x => `tests/${x}`);
if (!files.length) throw new Error('No runtime tests found');
result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
