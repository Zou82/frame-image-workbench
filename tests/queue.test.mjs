import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../server/queue.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const waitFor = (predicate, message, timeout = 2000) => new Promise((resolve, reject) => {
  const startedAt = Date.now();
  const check = () => {
    if (predicate()) return resolve();
    if (Date.now() - startedAt >= timeout) return reject(new Error(message));
    setTimeout(check, 5);
  };
  check();
});

test('concurrency limits execution and releasing a slot starts the next independent task', async () => {
  const releases = new Map();
  const started = [];
  const queue = new TaskQueue({
    concurrency: 2,
    worker: job => new Promise(resolve => {
      started.push(job.prompt);
      releases.set(job.id, resolve);
    }),
  });
  const a = queue.add({ prompt: 'A' });
  const b = queue.add({ prompt: 'B' });
  const c = queue.add({ prompt: 'C' });
  await tick();
  assert.deepEqual(started, ['A', 'B']);
  assert.equal(queue.list().find(job => job.id === c.id).status, 'queued');
  releases.get(a.id)([{ url: '/media/a.png' }]);
  await tick();
  assert.deepEqual(started, ['A', 'B', 'C']);
  assert.equal(queue.list().find(job => job.id === a.id).results[0].url, '/media/a.png');
  releases.get(b.id)([]);
  releases.get(c.id)([]);
  await tick();
});

test('cancellation skips queued work and an active slot stays occupied until its worker exits', async () => {
  const started = [];
  let exit;
  let aborted = false;
  const queue = new TaskQueue({
    concurrency: 1,
    worker: (job, signal) => {
      started.push(job.prompt);
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(resolve => { exit = resolve; });
    },
  });
  const a = queue.add({ prompt: 'A' });
  const b = queue.add({ prompt: 'B' });
  const c = queue.add({ prompt: 'C' });
  await tick();
  queue.cancel(b.id);
  queue.cancel(a.id);
  await tick();
  assert.equal(aborted, true);
  assert.deepEqual(started, ['A']);
  exit([]);
  await tick();
  assert.deepEqual(started, ['A', 'C']);
  assert.equal(queue.list().find(job => job.id === b.id).status, 'cancelled');
  assert.equal(queue.list().find(job => job.id === a.id).status, 'cancelled');
  exit([]);
  await tick();
});

test('a failed task does not stall later work, and restarts never resubmit unfinished paid requests', async () => {
  const queue = new TaskQueue({
    concurrency: 1,
    initialJobs: [{ id: 'old', status: 'running', prompt: 'old', createdAt: '2026-01-01' }],
    worker: async job => {
      if (job.prompt === 'bad') throw new Error('Upstream unavailable');
      return [{ url: '/media/ok.png' }];
    },
  });
  const bad = queue.add({ prompt: 'bad' });
  const good = queue.add({ prompt: 'good' });
  await tick();
  const jobs = queue.list();
  assert.equal(jobs.find(job => job.id === 'old').status, 'interrupted');
  assert.equal(jobs.find(job => job.id === bad.id).status, 'failed');
  assert.equal(jobs.find(job => job.id === good.id).status, 'completed');
});

test('a deferred job cannot start until the server has durably accepted it', async () => {
  const started = [];
  const queue = new TaskQueue({ concurrency: 2, worker: async job => { started.push(job.prompt); return []; } });
  const job = queue.add({ prompt: 'durable first' }, { deferred: true });
  queue.add({ prompt: 'normal' });
  await tick();
  assert.deepEqual(started, ['normal']);
  queue.start(job.id);
  await tick();
  assert.deepEqual(started, ['normal', 'durable first']);
});

test('100 independent workers can wait concurrently and releasing them starts the next task in order', async t => {
  const releases = new Map();
  const started = [];
  const queue = new TaskQueue({
    concurrency: 100,
    worker: job => new Promise(resolve => {
      started.push(job.prompt);
      releases.set(job.id, resolve);
    }),
  });
  const jobs = Array.from({ length: 101 }, (_, index) => queue.add({ prompt: `Task ${index}` }));
  t.after(() => {
    for (const release of releases.values()) release([]);
    for (const job of jobs) queue.cancel(job.id);
  });
  await waitFor(() => started.length === 100, '100 workers did not start within 2 seconds');
  assert.equal(queue.active.size, 100);
  assert.deepEqual(started, Array.from({ length: 100 }, (_, index) => `Task ${index}`));
  assert.equal(queue.list().find(job => job.id === jobs[100].id).status, 'queued');
  releases.get(jobs[0].id)([]);
  await waitFor(() => started.length === 101, 'queued worker did not start within 2 seconds');
  assert.equal(started[100], 'Task 100');
  assert.equal(queue.active.size, 100);
});
