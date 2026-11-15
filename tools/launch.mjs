import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const runtimePath = path.join(dataDir, 'runtime.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getRuntime() {
  try {
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    if (!Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) return null;
    const url = `http://127.0.0.1:${runtime.port}`;
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }).then(response => response.json());
    return health.app === 'frame-image-workbench' && health.pid === runtime.pid ? { ...runtime, url } : null;
  } catch { return null; }
}

function openBrowser(url) {
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => console.log(`Open this address in your browser: ${url}`));
  child.unref();
}

function npm(args) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', `npm ${args.join(' ')}`], { cwd: root, stdio: 'inherit', windowsHide: true })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0 || result.error) throw new Error(`npm ${args[0]} failed.`);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Please install Node.js 24 LTS (minimum 22.12).');
  const existing = await getRuntime();
  if (existing) {
    console.log(`FRAME is running: ${existing.url}`);
    openBrowser(existing.url);
  } else {
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(path.join(root, 'node_modules'))) {
      console.log('Installing dependencies. The first launch requires internet access...');
      npm(['ci', '--no-fund', '--no-audit']);
    }
    npm(['run', 'build']);
    const stdout = openSync(path.join(dataDir, 'server.log'), 'a');
    const stderr = openSync(path.join(dataDir, 'server-error.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
    let startupError;
    child.on('error', error => { startupError = error; });
    child.unref();
    closeSync(stdout);
    closeSync(stderr);
    let runtime;
    for (let i = 0; i < 80; i++) {
      if (startupError) throw startupError;
      await sleep(250);
      const current = await getRuntime();
      if (current?.pid === child.pid) { runtime = current; break; }
    }
    if (!runtime) throw new Error('Startup timed out. Check data/server-error.log.');
    console.log(`FRAME is running: ${runtime.url}`);
    openBrowser(runtime.url);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
