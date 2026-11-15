import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = JSON.parse(await readFile(path.join(root, 'data', 'runtime.json'), 'utf8'));
  if (!Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) throw new Error('Invalid local port.');
  const health = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.json());
  if (health.app !== 'frame-image-workbench' || health.pid !== runtime.pid || !Number.isInteger(runtime.pid) || runtime.pid < 1) throw new Error('The running service does not match this FRAME instance.');
  process.kill(runtime.pid);
  console.log('FRAME stopped. Your files and settings are preserved.');
} catch (error) {
  console.log(`FRAME is not reachable: ${error.message}`);
}
