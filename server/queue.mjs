import { randomUUID } from 'node:crypto';

export class TaskQueue {
  constructor({ concurrency = 3, worker, onChange = () => {}, initialJobs = [] }) {
    this.concurrency = concurrency;
    this.worker = worker;
    this.onChange = onChange;
    this.active = new Map();
    this.deferred = new Set();
    this.jobs = initialJobs.map(job => ['running', 'queued'].includes(job.status)
      ? { ...job, status: 'interrupted', error: '程序已重启，请重新提交任务。', finishedAt: new Date().toISOString() }
      : job);
  }

  list() {
    return structuredClone(this.jobs);
  }

  add(input, { deferred = false } = {}) {
    const job = {
      ...structuredClone(input), id: randomUUID(), status: 'queued',
      createdAt: new Date().toISOString(), results: [], error: null,
    };
    if (deferred) this.deferred.add(job.id);
    this.jobs.unshift(job);
    this.notify();
    queueMicrotask(() => this.pump());
    return structuredClone(job);
  }

  start(id) {
    this.deferred.delete(id);
    this.pump();
  }

  cancel(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !['queued', 'running'].includes(job.status)) return false;
    job.status = 'cancelled';
    this.deferred.delete(id);
    job.finishedAt = new Date().toISOString();
    this.active.get(id)?.abort();
    this.notify();
    return true;
  }

  setConcurrency(value) {
    this.concurrency = value;
    this.pump();
  }

  notify() {
    this.onChange(this.list());
  }

  pump() {
    const pending = this.jobs.filter(job => job.status === 'queued' && !this.deferred.has(job.id)).reverse();
    for (const job of pending) {
      if (this.active.size >= this.concurrency) break;
      const controller = new AbortController();
      this.active.set(job.id, controller);
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      this.notify();
      Promise.resolve()
        .then(() => this.worker(structuredClone(job), controller.signal))
        .then(results => {
          if (job.status === 'cancelled') return;
          job.status = 'completed';
          job.results = results;
        })
        .catch(error => {
          if (job.status === 'cancelled') return;
          job.status = 'failed';
          job.error = error.message || '生成失败，请检查连接设置。';
        })
        .finally(() => {
          this.active.delete(job.id);
          job.finishedAt = new Date().toISOString();
          this.notify();
          this.pump();
        });
    }
  }
}
