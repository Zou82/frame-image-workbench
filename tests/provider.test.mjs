import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTask, requestImages } from '../server/provider.mjs';

const task = {
  prompt: 'A green glass bottle', model: 'gpt-image-1.5', profileId: 'default',
  size: '1024x1024', quality: 'auto', n: 1, outputFormat: 'png',
  background: 'auto', references: [], extra: {},
};
const connection = { apiKey: 'test-only-secret', baseUrl: 'https://api.openai.com/v1', timeout: 300 };
const fakeResult = () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });

test('generation sends official JSON fields without the unsupported response_format parameter', async () => {
  let request;
  const images = await requestImages(validateTask(task), connection, {
    fetchImpl: async (url, init) => { request = { url, ...init }; return fakeResult(); },
  });
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'gpt-image-1.5');
  assert.equal(body.n, 1);
  assert.equal(body.output_format, 'png');
  assert.equal(body.response_format, undefined);
  assert.equal(request.headers.Authorization, 'Bearer test-only-secret');
  assert.equal(images[0].b64_json, 'aGVsbG8=');
});

test('generation uses the versioned API when a connection contains only an origin', async () => {
  let endpoint;
  await requestImages(task, { ...connection, baseUrl: 'https://gateway.example/' }, {
    fetchImpl: async url => { endpoint = url; return fakeResult(); },
  });
  assert.equal(endpoint, 'https://gateway.example/v1/images/generations');
});

test('an address entered as the API key is rejected before submitting generation', async () => {
  let calls = 0;
  await assert.rejects(
    requestImages(task, { ...connection, apiKey: 'https://gateway.example/' }, {
      fetchImpl: async () => { calls++; return fakeResult(); },
    }),
    /API Key.*网址/,
  );
  assert.equal(calls, 0);
});

test('multiple reference images use multipart edits with independent actual file bytes', async () => {
  let request;
  await requestImages(validateTask({ ...task, references: ['ref-a.png', 'ref-b.webp'] }), connection, {
    readReference: async id => ({ buffer: Buffer.from(id), name: id, mime: id.endsWith('.webp') ? 'image/webp' : 'image/png' }),
    fetchImpl: async (url, init) => { request = { url, ...init }; return fakeResult(); },
  });
  assert.equal(request.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(request.body.get('prompt'), 'A green glass bottle');
  const files = request.body.getAll('image[]');
  assert.equal(files.length, 2);
  assert.equal(await files[0].text(), 'ref-a.png');
  assert.equal(await files[1].text(), 'ref-b.webp');
  assert.equal(request.headers['Content-Type'], undefined);
});

test('invalid output combinations and protected extra parameters are rejected before billing', () => {
  assert.throws(() => validateTask({ ...task, background: 'transparent', outputFormat: 'jpeg' }), /透明|transparent/i);
  assert.throws(() => validateTask({ ...task, size: '1800x1000' }), /尺寸|size/i);
  assert.throws(() => validateTask({ ...task, extra: { model: 'something-else' } }), /保留|protected/i);
  assert.throws(() => validateTask({ ...task, extra: { stream: true } }), /保留|protected/i);
  assert.throws(() => validateTask({ ...task, n: 0 }), /数量|count/i);
  assert.throws(() => validateTask({ ...task, prompt: '   ' }), /提示词|prompt/i);
  assert.throws(() => validateTask({ ...task, extra: [] }), /JSON|object/i);
});

test('modern models accept 16 pixel aligned custom sizes and upstream errors redact the API key', async () => {
  assert.equal(validateTask({ ...task, model: 'gpt-image-2', size: '1536x864' }).size, '1536x864');
  assert.throws(() => validateTask({ ...task, model: 'gpt-image-2', size: '1537x864' }), /尺寸|size/i);
  await assert.rejects(
    requestImages(task, connection, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Invalid test-only-secret' } }), { status: 401 }),
    }),
    error => !error.message.includes('test-only-secret') && error.message.includes('401'),
  );
});

test('GPT Image 2 rejects unsupported transparency before an upstream request can be made', () => {
  assert.throws(() => validateTask({ ...task, model: 'gpt-image-2', background: 'transparent' }), /透明|transparent/i);
  assert.equal(validateTask({ ...task, model: 'gpt-image-1.5', background: 'transparent' }).background, 'transparent');
});
