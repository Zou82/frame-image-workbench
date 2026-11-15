import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect, device } from './android-cdp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let c;
async function attach() {
  for (let i = 0; i < 50; i++) {
    try {
      const client = await connect();
      if (await client.evaluate('!!document.querySelector(".app-shell")')) return client;
      client.close();
    } catch {}
    await pause(200);
  }
  throw new Error('FRAME did not reopen');
}
async function setup() {
  await c.evaluate(`window.testApi=(route,method='GET',body={})=>new Promise((resolve,reject)=>{
    const id=crypto.randomUUID(),old=window.__frameNativeResolve;
    window.__frameNativeResolve=r=>{if(r.id===id){window.__frameNativeResolve=old;r.ok?resolve(r.data):reject(Error(r.error));}else old(r);};
    FrameNative.request(JSON.stringify({id,route,method,body}));
  })`);
}
const api = (route, method = 'GET', body = {}) => c.evaluate(`testApi(${JSON.stringify(route)},${JSON.stringify(method)},${JSON.stringify(body)})`);
const task = prompt => ({ profileId: 'default', model: 'fixture-image-a', title: prompt, prompt, size: '1024x1024', quality: 'auto', n: 1, outputFormat: 'png', background: 'auto', references: [], extra: {} });
async function finished(id, status) {
  for (let i = 0; i < 60; i++) {
    const job = (await api('/jobs')).jobs.find(j => j.id === id);
    if (job.status === status) return job;
    await pause(200);
  }
  throw new Error(`Job ${id} did not become ${status}`);
}
async function shot(name) {
  const image = await c.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(`output/android/${name}.png`, Buffer.from(image.data, 'base64'));
}
async function layout(name) {
  c?.close(); c = await attach();
  await pause(500);
  const dimensions = await c.evaluate('({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth})');
  assert.ok(dimensions.scroll <= dimensions.width, `${name} overflow: ${JSON.stringify(dimensions)}`);
  await shot(name);
  console.log(`PASS: ${name} ${JSON.stringify(dimensions)}`);
}

const font = device('shell', 'settings', 'get', 'system', 'font_scale').trim();
const rotation = device('shell', 'settings', 'get', 'system', 'user_rotation').trim();
const automatic = device('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim();
try {
  c = await attach();
  await c.evaluate(`document.querySelector('[aria-label="关闭导入"]')?.click()`);
  await setup();
  const url = await api('/jobs', 'POST', task('URL result image'));
  const failure = await api('/jobs', 'POST', task('FAIL independent error'));
  const cancelled = await api('/jobs', 'POST', task('SLOW cancel me'));
  await api(`/jobs/${cancelled.id}/cancel`, 'POST');
  assert.equal((await finished(url.id, 'completed')).results.length, 1);
  const failed = await finished(failure.id, 'failed');
  assert.match(failed.error, /429/);
  assert.ok(!failed.error.includes('fixture-key-local'));
  await finished(cancelled.id, 'cancelled');
  const interrupted = await api('/jobs', 'POST', task('SLOW interrupted without retry'));
  await pause(1000);
  device('shell', 'am', 'force-stop', 'com.frame.workbench');
  c.close(); c = null;
  device('shell', 'am', 'start', '-n', 'com.frame.workbench/.MainActivity');
  c = await attach(); await setup();
  await finished(interrupted.id, 'interrupted');
  const statsBefore = await fetch('http://127.0.0.1:4329/stats').then(r => r.json());
  await pause(2500);
  assert.equal((await api('/jobs')).jobs.find(j => j.id === interrupted.id).status, 'interrupted');
  const statsAfter = await fetch('http://127.0.0.1:4329/stats').then(r => r.json());
  assert.equal(statsAfter.generated, statsBefore.generated);
  console.log('PASS: URL result, independent429/redaction, cancellation and force-stop interruption without retry');
  await layout('portrait-restored');
  device('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  device('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  await pause(1500);
  await layout('landscape');
  assert.ok(await c.evaluate('innerWidth>innerHeight'));
  device('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  device('shell', 'settings', 'put', 'system', 'font_scale', '1.5');
  await pause(1500);
  await layout('large-font');
  device('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
  device('shell', 'wm', 'size', '1600x2560');
  device('shell', 'wm', 'density', '240');
  await pause(2000);
  await layout('tablet');
  assert.ok(await c.evaluate('innerWidth>=1000'));
  await fs.writeFile('output/android/lifecycle-result.json', JSON.stringify({ url: true, independentFailure: true, cancellation: true, interruptedWithoutRetry: true, portrait: true, landscape: true, largeFont: 1.5, tablet: '1600x2560 density240' }, null, 2));
} finally {
  c?.close();
  device('shell', 'wm', 'size', 'reset');
  device('shell', 'wm', 'density', 'reset');
  device('shell', 'settings', 'put', 'system', 'font_scale', font === 'null' ? '1.0' : font);
  device('shell', 'settings', 'put', 'system', 'user_rotation', rotation === 'null' ? '0' : rotation);
  device('shell', 'settings', 'put', 'system', 'accelerometer_rotation', automatic === 'null' ? '1' : automatic);
}
