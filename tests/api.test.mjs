import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { createApp } from '../server/index.mjs';

test('model discovery normalizes root URLs in existing and newly saved profiles while preserving custom prefixes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-models-'));
  const calls = [];
  const upstream = http.createServer((req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (!['/v1/models', '/gateway/v2/models'].includes(req.url)) {
      res.writeHead(401);
      return res.end(JSON.stringify({ code: 'INVALID_API_KEY', message: 'Invalid API key' }));
    }
    res.end(JSON.stringify({ data: [{ id: 'gpt-image-1.5' }, { id: 'text-model' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    concurrency: 3,
    profiles: [{ id: 'default', name: 'Existing connection', baseUrl: origin, apiKey: 'probe-private-key', models: ['gpt-image-1.5'], timeout: 600 }],
  }));
  const { app } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const publicSettings = await fetch(`${base}/api/settings`).then(response => response.json());
  const probe = async expected => {
    const response = await fetch(`${base}/api/profiles/default/test`, { method: 'POST' });
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    assert.equal(data.endpoint, `${origin}${expected}/models`);
    assert.deepEqual(data.models, ['gpt-image-1.5', 'text-model']);
    assert.deepEqual(calls.at(-1), { path: `${expected}/models`, authorization: 'Bearer probe-private-key' });
  };
  await probe('/v1');
  assert.equal(publicSettings.profiles[0].baseUrl, `${origin}/v1`);
  for (const [entered, expected] of [[`${origin}/`, '/v1'], [`${origin}/gateway/v2/`, '/gateway/v2']]) {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...publicSettings, profiles: [{ ...publicSettings.profiles[0], baseUrl: entered, apiKey: '' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profiles[0].baseUrl, `${origin}${expected}`);
    await probe(expected);
  }
  assert.equal(calls.length, 3);
});

test('model discovery reports the upstream endpoint and authentication code without leaking keys or retrying', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-models-auth-'));
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'INVALID_API_KEY', message: 'Invalid API key: probe-private-key' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1/models`;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    concurrency: 3,
    profiles: [{ id: 'default', name: 'Gateway', baseUrl: endpoint.replace('/models', ''), apiKey: 'probe-private-key', models: ['gpt-image-1.5'], timeout: 600 }],
  }));
  const { app } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/profiles/default/test`, { method: 'POST' });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.ok(data.error.includes(endpoint), data.error);
  assert.ok(data.error.includes('401'), data.error);
  assert.ok(data.error.includes('INVALID_API_KEY'), data.error);
  assert.ok(data.error.includes('Invalid API key:'), data.error);
  assert.equal(data.error.includes('probe-private-key'), false);
  assert.equal(calls, 1);
});

test('an API URL pasted as a key is rejected for existing profiles and settings updates before contacting upstream', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-key-url-'));
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gpt-image-1.5' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    concurrency: 3,
    profiles: [{ id: 'default', name: 'Gateway', baseUrl: `${origin}/v1`, apiKey: `${origin}/`, models: ['gpt-image-1.5'], timeout: 600 }],
  }));
  const { app } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${base}/api/settings`).then(response => response.json());
  for (const [route, method, body] of [
    ['/api/settings', 'PUT', { ...initial, profiles: [{ ...initial.profiles[0], apiKey: ' https://gateway.example/ ' }] }],
    ['/api/profiles/default/test', 'POST', {}],
    ['/api/jobs', 'POST', { prompt: 'A bottle', model: 'gpt-image-1.5', profileId: 'default' }],
  ]) {
    const response = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, route);
    const data = await response.json();
    assert.match(data.error, /API Key.*网址/);
    assert.equal(data.error.includes(origin), false);
  }
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/api/jobs`).then(response => response.json())).jobs.length, 0);
  const saved = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(saved.profiles[0].apiKey, `${origin}/`);
});

test('fetching models replaces and persists only the chosen connection list, including aliases and empty results', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-model-sync-'));
  let modelData = [{ id: 'gateway-art-v2' }, { id: 'gpt-image-2.5-sunburst' }, { id: 'gateway-art-v2' }];
  let status = 200;
  const upstream = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { data: modelData } : { error: { message: 'Model discovery unavailable' } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    concurrency: 3,
    profiles: [
      { id: 'default', name: 'Gateway', baseUrl: `${origin}/v1`, apiKey: 'private-sync-key', models: ['gpt-image-1.5', 'retired-image'], timeout: 600 },
      { id: 'other', name: 'Other connection', baseUrl: `${origin}/other/v1`, apiKey: 'other-private-key', models: ['other-art'], timeout: 300 },
    ],
  }));
  const { app } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = () => fetch(`${base}/api/settings`).then(response => response.json());
  const getModels = () => fetch(`${base}/api/profiles/default/models`, { method: 'POST' });
  const initial = await settings();
  await fetch(`${base}/api/profiles/default/test`, { method: 'POST' });
  assert.deepEqual(await settings(), initial, 'connection testing must not change configured models');
  const response = await getModels();
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  assert.deepEqual(data.models, ['gateway-art-v2', 'gpt-image-2.5-sunburst']);
  assert.deepEqual(data.settings, await settings());
  assert.deepEqual(data.settings.profiles[0].models, ['gateway-art-v2', 'gpt-image-2.5-sunburst']);
  assert.deepEqual(data.settings.profiles[1], initial.profiles[1]);
  assert.equal(JSON.stringify(data).includes('private-sync-key'), false);
  let disk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(disk.profiles[0].models, data.models);
  assert.equal(disk.profiles[0].apiKey, 'private-sync-key');
  assert.equal(disk.profiles[1].apiKey, 'other-private-key');
  status = 503;
  const failed = await getModels();
  assert.equal(failed.status, 400);
  assert.deepEqual(await settings(), data.settings, 'failed discovery must preserve the last working list');
  status = 200;
  modelData = [];
  const emptyResponse = await getModels();
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual((await emptyResponse.json()).settings.profiles[0].models, []);
  const current = await settings();
  const save = await fetch(`${base}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(current),
  });
  assert.equal(save.status, 200, 'an empty model list must be saveable');
  const invalidJob = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A bottle', model: 'retired-image', profileId: 'default' }),
  });
  assert.equal(invalidJob.status, 400, 'a removed model must not reach the generation queue');
  assert.equal((await fetch(`${base}/api/jobs`).then(response => response.json())).jobs.length, 0);
  disk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(disk.profiles[0].models, []);
});

test('overlapping model syncs keep the fresh lists of both connections', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-model-overlap-'));
  const responses = [];
  const upstream = http.createServer((req, res) => {
    responses.push({ req, res });
    if (responses.length !== 2) return;
    for (const pending of responses) {
      pending.res.setHeader('content-type', 'application/json');
      pending.res.end(JSON.stringify({ data: [{ id: pending.req.url.includes('/second/') ? 'fresh-second-art' : 'fresh-first-art' }] }));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    concurrency: 3,
    profiles: ['first', 'second'].map(id => ({
      id, name: id, baseUrl: `${origin}/${id}/v1`, apiKey: `${id}-key`, models: ['old-art'], timeout: 600,
    })),
  }));
  const { app } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = await Promise.all(['first', 'second'].map(id =>
    fetch(`${base}/api/profiles/${id}/models`, { method: 'POST' })));
  for (const result of results) assert.equal(result.status, 200);
  const current = await fetch(`${base}/api/settings`).then(response => response.json());
  assert.deepEqual(current.profiles.map(profile => profile.models), [['fresh-first-art'], ['fresh-second-art']]);
  const disk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(disk.profiles.map(profile => profile.models), [['fresh-first-art'], ['fresh-second-art']]);
});

test('settings accept concurrency 100 and reject 101 without changing the saved value', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-concurrency-'));
  const { app } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${base}/api/settings`).then(response => response.json());
  const save = value => fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...initial, concurrency: value }),
  });
  const accepted = await save(100);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).concurrency, 100);
  const rejected = await save(101);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /1.*100/);
  assert.equal((await fetch(`${base}/api/settings`).then(response => response.json())).concurrency, 100);
  assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).concurrency, 100);
});

test('local API preserves private keys, validates uploads, saves actual generated files and rejects cross-origin writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-test-'));
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#00856b' } }).png().toBuffer();
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    calls.push({ path: req.url, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/models')
      ? { data: [{ id: 'gpt-image-1.5' }] }
      : { data: [{ b64_json: png.toString('base64') }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { app, queue, storage } = await createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await storage.write('jobs', queue.list());
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, method = 'GET', data) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  const initial = (await json('/api/settings')).data;
  assert.equal(initial.profiles[0].apiKey, undefined);
  assert.equal(initial.profiles[0].hasKey, false);
  assert.deepEqual(initial.profiles[0].models, [], 'a new connection must not advertise hard-coded models');
  const job = { prompt: 'A bottle', model: 'gpt-image-1.5', profileId: 'default', size: '1024x1024', n: 1 };
  assert.equal((await json('/api/jobs', 'POST', job)).status, 400);
  const config = {
    ...initial,
    profiles: [{ ...initial.profiles[0], apiKey: 'test-private-value', models: ['gpt-image-1.5'], baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }],
  };
  assert.equal((await json('/api/settings', 'PUT', config)).status, 200);
  const publicConfig = (await json('/api/settings')).data;
  assert.equal(JSON.stringify(publicConfig).includes('test-private-value'), false);
  assert.equal(publicConfig.profiles[0].hasKey, true);
  await json('/api/settings', 'PUT', { ...publicConfig, profiles: publicConfig.profiles.map(profile => ({ ...profile, apiKey: '' })) });
  assert.equal((await json('/api/settings')).data.profiles[0].hasKey, true);
  const probe = await json('/api/profiles/default/test', 'POST', {});
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.data.models, ['gpt-image-1.5']);
  const form = new FormData();
  form.append('images', new Blob([png], { type: 'image/png' }), 'sample.png');
  const upload = await fetch(base + '/api/uploads', { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  const refs = (await upload.json()).files;
  assert.equal(refs[0].width, 32);
  const invalid = new FormData();
  invalid.append('images', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  assert.equal((await fetch(base + '/api/uploads', { method: 'POST', body: invalid })).status, 400);
  const submitted = await json('/api/jobs', 'POST', { ...job, references: [refs[0].id] });
  assert.equal(submitted.status, 201);
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = (await json('/api/jobs')).data.jobs.find(item => item.id === submitted.data.id);
    if (['completed', 'failed'].includes(saved.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal(saved.results.length, 1);
  assert.equal(calls.at(-1).path, '/v1/images/edits');
  assert.equal(calls.at(-1).authorization, 'Bearer test-private-value');
  const image = await fetch(base + saved.results[0].url);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const diskJobs = JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8'));
  assert.equal(JSON.stringify(diskJobs).includes('test-private-value'), false);
  const blocked = await fetch(base + '/api/jobs', {
    method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: JSON.stringify(job),
  });
  assert.equal(blocked.status, 403);
});
