import { execFileSync } from 'node:child_process';
import path from 'node:path';

const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
const adb = process.env.FRAME_ADB || (sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb');
export function device(...args) {
  return execFileSync(adb, ['-s', process.env.FRAME_QA_SERIAL || 'emulator-5580', ...args], { encoding: 'utf8', timeout: 30000 });
}

export async function connect() {
  const sockets = device('shell', 'cat', '/proc/net/unix');
  const pid = device('shell', 'pidof', 'com.frame.workbench').trim().split(/\s+/)[0];
  const name = sockets.includes(`@webview_devtools_remote_${pid}`) ? `webview_devtools_remote_${pid}` : null;
  if (!name) throw new Error('No debug WebView running on emulator-5580');
  device('forward', 'tcp:9333', `localabstract:${name}`);
  const pages = await fetch('http://127.0.0.1:9333/json', { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const page = pages.find(item => item.url.startsWith('https://frame.local'));
  if (!page) throw new Error('FRAME page missing');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    if (result.error) entry.reject(new Error(JSON.stringify(result.error)));
    else entry.resolve(result.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

if (process.argv[1]?.endsWith('android-cdp.mjs')) {
  const client = await connect();
  try { console.log(JSON.stringify(await client.evaluate(process.argv[2] || 'document.body.innerText'), null, 2)); }
  finally { client.close(); }
}
