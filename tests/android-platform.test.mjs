import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeClient, uploadNativeFiles } from '../src/platform.js';

test('native requests keep parallel responses associated with their callers', async () => {
  const sent = [];
  const client = createNativeClient({ request: value => sent.push(JSON.parse(value)) });
  const settings = client.request('/settings');
  const models = client.request('/profiles/a/models', { method: 'POST', body: {} });
  client.resolve({ id: sent[1].id, ok: true, data: { models: ['provider-only'] } });
  client.resolve({ id: sent[0].id, ok: true, data: { concurrency: 100 } });
  assert.deepEqual(await settings, { concurrency: 100 });
  assert.deepEqual(await models, { models: ['provider-only'] });
  assert.equal(sent[1].route, '/profiles/a/models');
  assert.equal(sent[1].method, 'POST');
});

test('native errors and timeouts reject without retrying paid requests', async () => {
  const sent = [];
  const client = createNativeClient({ request: value => sent.push(JSON.parse(value)) }, 20);
  const failed = client.request('/jobs', { method: 'POST', body: { prompt: 'one' } });
  client.resolve({ id: sent[0].id, ok: false, error: 'HTTP 401' });
  await assert.rejects(failed, /HTTP 401/);
  await assert.rejects(client.request('/settings'), /响应超时/);
  assert.equal(sent.length, 2);
  client.resolve({ id: sent[1].id, ok: true, data: {} });
});

test('reference images cross the bridge individually and retain names and bytes', async () => {
  const sent = [];
  let active = 0;
  let peak = 0;
  const result = await uploadNativeFiles([
    Object.assign(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { name: 'first.png' }),
    Object.assign(new Blob([new Uint8Array([4, 5])], { type: 'image/webp' }), { name: 'second.webp' }),
  ], async (route, options) => {
    active++;
    peak = Math.max(peak, active);
    sent.push({ route, ...options });
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return { files: [{ id: `uploads/${sent.length}.png` }] };
  });
  assert.equal(peak, 1);
  assert.equal(sent[0].body.files[0].data, 'AQID');
  assert.equal(sent[1].body.files[0].data, 'BAU=');
  assert.equal(sent[1].body.files[0].name, 'second.webp');
  assert.equal(sent[1].body.files[0].type, 'image/webp');
  assert.equal(result.files.length, 2);
});

test('uploads from different task windows share a memory bounded bridge lane', async () => {
  let active = 0;
  let peak = 0;
  const request = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { files: [{ id: 'uploads/one.png' }] };
  };
  const file = Object.assign(new Blob(['image'], { type: 'image/png' }), { name: 'one.png' });
  await Promise.all([uploadNativeFiles([file], request), uploadNativeFiles([file], request)]);
  assert.equal(peak, 1);
});
