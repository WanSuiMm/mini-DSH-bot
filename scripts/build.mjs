import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let compiler = process.env.MICRO_DSH_TSC;
if (!compiler) {
  try { compiler = require.resolve('typescript/bin/tsc'); }
  catch {
    console.error('TypeScript is missing. Run npm install --ignore-scripts, or set MICRO_DSH_TSC to an existing tsc JavaScript entry.');
    process.exit(1);
  }
}
const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.json', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
