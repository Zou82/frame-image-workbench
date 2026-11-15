import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect, device } from './android-cdp.mjs';
import { tree, tap } from './android-tree.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = new URL('../output/android/', import.meta.url);
await fs.mkdir(output, { recursive: true });
async function ready() {
  let last;
  for (let i = 0; i < 50; i++) {
    let client;
    try {
      client = await connect();
      if (await client.evaluate('Boolean(document.querySelector(".app-shell"))')) return client;
      client.close();
    } catch (error) { last = error; client?.close(); }
    await pause(200);
  }
  throw new Error(`Startup failed: ${last?.message}`);
}

async function wait(client, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await pause(200);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function installHelpers(client) {
  await client.evaluate(`window.qa={
    click(text){const button=[...document.querySelectorAll('button')].find(e=>e.innerText.replace(/\\s/g,'')===text.replace(/\\s/g,''));
      if(!button||button.disabled)throw Error('Button unavailable: '+text);button.click();},
    field(selector,value){const e=document.querySelector(selector);if(!e)throw Error('Missing '+selector);
      const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);
      e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));},
    api(route,method='GET',body={}){
      return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),old=window.__frameNativeResolve;
        window.__frameNativeResolve=r=>{if(r.id===id){window.__frameNativeResolve=old;r.ok?resolve(r.data):reject(Error(r.error));}else old(r);};
        FrameNative.request(JSON.stringify({id,route,method,body}));});}
  }`);
}
async function screenshot(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(new URL(name + '.png', output), Buffer.from(shot.data, 'base64'));
}

let client;
try {
  client = await ready();
  await client.evaluate(`localStorage.removeItem('frame-workbench-drafts-v1');location.reload()`);
  client.close();
  client = await ready();
  client.close();
  for (let i = 1; i <= 5; i++) {
    device('shell', 'am', 'force-stop', 'com.frame.workbench');
    device('shell', 'am', 'start', '-f', '0x10008000', '-n', 'com.frame.workbench/.MainActivity');
    client = await ready();
    assert.equal(await client.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    console.log(`Cold startup ${i}: passed`);
    client.close();
  }
  client = await ready();
  await installHelpers(client);
  await client.evaluate(`document.querySelector('[aria-label="API 连接与设置"]').click()`);
  await wait(client, 'Boolean(document.querySelector(".profile-form"))');
  await client.evaluate(`qa.field('.profile-form .field:nth-of-type(1) input','Emulator fixture')`);
  await client.evaluate(`qa.field('.profile-form input[placeholder="https://api.openai.com/v1"]','http://10.0.2.2:4329')`);
  await client.evaluate(`qa.field('.key-input input','fixture-key-local')`);
  await client.evaluate(`qa.field('[aria-label="最大并行任务精确值"]','100')`);
  await client.evaluate(`qa.click('获取模型')`);
  await wait(client, 'document.querySelector("#model-list").value==="fixture-image-a\\nfixture-image-b"');
  await wait(client, '!document.querySelector(".modal-footer .primary").disabled');
  await screenshot(client, 'settings-phone');
  await client.evaluate(`qa.click('保存配置')`);
  await wait(client, '!document.querySelector("#settings-title")');
  const settings = await client.evaluate(`qa.api('/settings')`);
  assert.equal(settings.concurrency, 100);
  assert.deepEqual(settings.profiles[0].models, ['fixture-image-a', 'fixture-image-b']);
  assert.equal(settings.profiles[0].hasKey, true);
  console.log('UI model discovery and encrypted settings: passed');

  await client.evaluate(`qa.click('JSON 批量导入')`);
  const batch = {
    version: 1,
    defaults: { model: 'fixture-image-a', size: '1024x1024', quality: 'medium' },
    tasks: Array.from({ length: 100 }, (_, i) => ({
      title: `并行任务 ${i + 1}`, prompt: `SLOW distinct scene ${i + 1}`,
      ...(i === 4 ? { model: 'fixture-image-b', size: '1024x1536', quality: 'high', n: 2 } : {}),
    })),
  };
  await client.evaluate(`qa.field('[aria-label="任务 JSON"]',${JSON.stringify(JSON.stringify(batch))})`);
  await wait(client, 'document.body.innerText.includes("100 个任务待导入")');
  assert.equal(await client.evaluate('document.querySelectorAll(".validation-errors").length'), 0);
  await client.evaluate(`qa.click('导入草稿 (100)')`);
  await wait(client, 'document.querySelectorAll(".task-table-row").length===25');
  await pause(500);
  let drafts = await client.evaluate(`JSON.parse(localStorage.getItem('frame-workbench-drafts-v1'))`);
  assert.equal(drafts.length, 100);
  assert.equal(new Set(drafts.map(d => d.prompt)).size, 100);
  assert.equal(drafts[4].model, 'fixture-image-b');
  assert.equal(drafts[4].n, 2);
  await screenshot(client, 'batch-phone');
  console.log('JSON import 100 distinct tasks, pagination and overrides: passed');

  await client.evaluate(`qa.click('统一参数')`);
  await wait(client, 'Boolean(document.querySelector("#batch-settings-title"))');
  await client.evaluate(`document.querySelector('[aria-label="批量修改模型"]').click()`);
  await client.evaluate(`document.querySelector('[aria-label="批量修改尺寸 / 比例"]').click()`);
  await client.evaluate(`qa.field('[aria-label="统一画质"]','low')`);
  await client.evaluate(`qa.click('应用勾选参数')`);
  await wait(client, '!document.querySelector("#batch-settings-title")');
  await pause(500);
  drafts = await client.evaluate(`JSON.parse(localStorage.getItem('frame-workbench-drafts-v1'))`);
  assert.equal(drafts.every(d => d.quality === 'low'), true);
  assert.equal(drafts[4].model, 'fixture-image-b');
  assert.equal(drafts[4].size, '1024x1536');
  assert.equal(drafts[4].n, 2);
  assert.equal(drafts[0].prompt, 'SLOW distinct scene 1');
  console.log('Bulk selected-field change preserves task overrides/prompts: passed');

  await client.evaluate(`document.querySelector('[aria-label="打开任务 5"]').click()`);
  await wait(client, 'Boolean(document.querySelector(".task-editor"))');
  await client.evaluate(`qa.field('[aria-label="任务 5 画质"]','high')`);
  await client.evaluate(`document.querySelector('[aria-label="关闭任务编辑"]').click()`);
  await pause(500);
  drafts = await client.evaluate(`JSON.parse(localStorage.getItem('frame-workbench-drafts-v1'))`);
  assert.equal(drafts[4].quality, 'high');
  assert.equal(drafts[3].quality, 'low');
  assert.equal(drafts[4].model, 'fixture-image-b');
  assert.equal(drafts[4].n, 2);
  console.log('Independent task editing after bulk changes: passed');

  await fetch('http://127.0.0.1:4329/reset');
  await client.evaluate(`qa.click('全部生成100')`);
  await wait(client, 'document.body.innerText.includes("并行 100 / 100")', 20000);
  const active = await fetch('http://127.0.0.1:4329/stats').then(r => r.json());
  assert.equal(active.peak, 100);
  assert.equal(active.active, 100);
  if ((await tree()).some(node => node['resource-id'] === 'com.android.permissioncontroller:id/permission_allow_button')) {
    await tap('resource-id', 'com.android.permissioncontroller:id/permission_allow_button', { name: 'notification-permission' });
  }
  device('shell', 'input', 'keyevent', '3');
  const service = device('shell', 'dumpsys', 'activity', 'services', 'com.frame.workbench');
  assert.match(service, /isForeground=true/);
  await fs.writeFile(new URL('foreground-service.txt', output), service);
  console.log('100 simultaneous generations and foreground service: passed');
  client.close();
  client = null;
  const deadline = Date.now() + 35000;
  let stats;
  do {
    await pause(1000);
    stats = await fetch('http://127.0.0.1:4329/stats').then(r => r.json());
  } while (stats.generated < 100 && Date.now() < deadline);
  assert.equal(stats.generated, 100);
  assert.deepEqual(stats.errors, []);
  device('shell', 'am', 'start', '-n', 'com.frame.workbench/.MainActivity');
  client = await ready();
  await installHelpers(client);
  await wait(client, 'document.querySelectorAll(".status-completed").length===25', 15000);
  const jobs = await client.evaluate(`qa.api('/jobs')`);
  assert.equal(jobs.jobs.filter(j => j.status === 'completed').length, 100);
  assert.equal(jobs.jobs.reduce((n, j) => n + j.results.length, 0), 101);
  await screenshot(client, 'results-phone');
  await fs.writeFile(new URL('ui-batch-result.json', output), JSON.stringify({ stats, tasks: 100, images: 101, coldStarts: 5 }, null, 2));
  console.log('Background completion: 100 successful tasks / 101 images');
} finally {
  client?.close();
}
