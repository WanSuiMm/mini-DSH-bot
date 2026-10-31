import { cp, mkdir, readFile, readdir, rename, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Packaging only: no browser, service or model is started by this entry.
const project = fileURLToPath(new URL('../', import.meta.url));
const desktopPackage = JSON.parse(await readFile(join(project, 'desktop/package.json'), 'utf8'));
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--(platform|runtime-dir|dependencies-dir|output-dir)=(.+)$/.exec(value);
  if (!match) throw new Error('Use --platform=win32 --runtime-dir=<extracted Electron> --dependencies-dir=<production node_modules> --output-dir=<new directory>');
  return [match[1], match[2]];
}));
if (options.platform !== 'win32' || !options['runtime-dir'] || !options['dependencies-dir'] || !options['output-dir']) throw new Error('Explicit Windows runtime, dependencies and new output directory are required');
const runtime = resolve(options['runtime-dir']), dependencies = resolve(options['dependencies-dir']), output = resolve(options['output-dir']);
if (!isAbsolute(output) || output === project || !relative(project, output).startsWith('..') && relative(project, output).split(/[\\/]/).length < 2)
  throw new Error('Output must be a dedicated new artifact directory');
await lstat(join(runtime, 'electron.exe'));
await lstat(join(project, 'dist', 'core', 'agent-loop.js'));
await mkdir(output); // Never merge a package into an old artifact.
await cp(runtime, output, { recursive: true, dereference: false, errorOnExist: true });
await rename(join(output, 'electron.exe'), join(output, 'mini-DSH Browser.exe'));
const application = join(output, 'resources', 'app');
await mkdir(application, { recursive: true });
for (const directory of ['desktop', 'service', 'dist']) {
  await cp(join(project, directory), join(application, directory), { recursive: true, dereference: false,
    filter: path => !['node_modules', 'checks', 'downloads', 'package-lock.json', 'pnpm-lock.yaml'].includes(path.split(/[\\/]/).at(-1)) });
}
await cp(dependencies, join(application, 'node_modules'), { recursive: true, dereference: true });
await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'mini-dsh-browser', productName: 'mini-DSH Browser',
  version: desktopPackage.version, type: 'module', main: 'desktop/start.mjs', private: true }, null, 2));
await writeFile(join(output, '使用说明.txt'), [
  `mini-DSH Browser ${desktopPackage.version} — Chromium 桌面浏览器`,
  '', '解压整个文件夹后，双击 mini-DSH Browser.exe。不要只复制 exe。',
  '浏览网页无需模型密钥；右上角配置 Agent 后才能执行模型任务。',
  '使用独立应用数据目录，不导入或修改 Edge / Chrome 登录资料。',
  '网页登录状态、标签页与任务记录保存在 Windows 当前用户的应用数据目录。',
  '模型密钥只在当前进程内存中使用，每次启动重新填写。',
  'Agent 默认仅获当前网站授权；操作卡片确认后执行。',
  '点击“人工接管”或直接点击正在由 Agent 控制的页面，会先停止后续 Agent 操作。',
  '恢复时重新观察页面，结果不明的写操作不会自动重发。',
  '已在 Windows 实机使用隔离测试页验证浏览、多标签、登录持久化、Agent 接管／继续和取消。',
  'Agent 功能验收使用零计费脚本模型，不代表真实模型在第三方网站上的任务成功率。',
  '保留 LICENSE / LICENSES.chromium.html，它们包含 Electron / Chromium 第三方许可。',
].join('\r\n'));
const files = [];
async function walk(path) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const file = join(path, item.name);
    if (item.isDirectory()) await walk(file);
    else if (item.isFile()) {
      const data = await readFile(file);
      files.push({ file: relative(output, file).replaceAll('\\', '/'), bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex') });
    } else throw new Error('Package contains an unsupported filesystem entry');
  }
}
await walk(output);
await writeFile(join(output, 'PACKAGE_MANIFEST.json'), JSON.stringify({ product: 'mini-DSH Browser', version: desktopPackage.version,
  electron: '45.1.0', platform: 'win32-x64', generatedAt: new Date().toISOString(), files }, null, 2));
console.log(JSON.stringify({ packaged: true, files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) }));
