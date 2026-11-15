import test from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../src/lib.js';
import { validateTask } from '../server/provider.mjs';
const { fromJob, makeDraft, reconcileDraftModels } = lib;

test('restoring a task whose profile was removed uses the remaining available connection', () => {
  const settings = { profiles: [{ id: 'replacement', models: ['gpt-image-2'] }] };
  const draft = fromJob(settings, {
    title: 'Previous task', profileId: 'deleted-connection', model: 'gpt-image-1.5',
    prompt: 'A plant', size: '1024x1024', n: 1, quality: 'auto',
    references: ['outputs/a.png'], extra: {},
  });
  assert.equal(draft.profileId, 'replacement');
  assert.equal(draft.model, 'gpt-image-2');
  assert.equal(draft.jobId, null);
  assert.equal(draft.references[0].id, 'outputs/a.png');
});

test('new and copied drafts only select a model from their actual connection and stay empty when none exist', () => {
  const settings = { profiles: [{ id: 'gateway', models: ['gateway-art', 'gpt-image-2.5'] }] };
  assert.equal(makeDraft(settings).model, 'gateway-art');
  assert.equal(makeDraft(settings, { model: 'gpt-image-1.5' }).model, 'gateway-art');
  assert.equal(makeDraft(settings, { model: 'gpt-image-2.5' }).model, 'gpt-image-2.5');
  assert.equal(makeDraft({ profiles: [{ id: 'empty', models: [] }] }).model, '');
  assert.equal(makeDraft(null).model, '');
});

test('model synchronization reconciles stale drafts per connection without changing in-flight tasks or other draft content', () => {
  assert.equal(typeof reconcileDraftModels, 'function');
  const settings = { profiles: [
    { id: 'gateway', models: ['gateway-art', 'sunburst-art'] },
    { id: 'other', models: ['other-art'] },
    { id: 'empty', models: [] },
  ] };
  const drafts = [
    { id: 'stale', profileId: 'gateway', model: 'retired-image', prompt: 'Keep my prompt', references: [{ id: 'a.png' }], jobId: 'finished-job' },
    { id: 'valid', profileId: 'gateway', model: 'sunburst-art' },
    { id: 'other', profileId: 'other', model: 'other-art' },
    { id: 'empty', profileId: 'empty', model: 'gpt-image-2' },
    { id: 'active', profileId: 'gateway', model: 'retired-image', jobId: 'running-job' },
  ];
  const next = reconcileDraftModels(settings, drafts, new Set(['active']));
  assert.equal(next[0].model, 'gateway-art');
  assert.equal(next[0].prompt, 'Keep my prompt');
  assert.deepEqual(next[0].references, [{ id: 'a.png' }]);
  assert.equal(next[0].jobId, 'finished-job');
  assert.equal(next[1], drafts[1]);
  assert.equal(next[2], drafts[2]);
  assert.equal(next[3].model, '');
  assert.equal(next[4], drafts[4]);
  assert.equal(reconcileDraftModels(settings, next, new Set(['active'])), next);
});

test('automatic model replacement keeps background, size and quality valid for the selected model', () => {
  const old = makeDraft({ profiles: [{ id: 'gateway', models: ['gpt-image-1.5'] }] }, {
    model: 'gpt-image-1.5', prompt: 'A plant', background: 'transparent', extra: {},
  });
  const next = reconcileDraftModels({ profiles: [{ id: 'gateway', models: ['gpt-image-2'] }] }, [old])[0];
  assert.equal(next.background, 'auto');
  assert.doesNotThrow(() => validateTask(next));
  const copied = makeDraft({ profiles: [{ id: 'gateway', models: ['gpt-image-1.5'] }] }, {
    model: 'gpt-image-2.5-flare', prompt: 'A plant', size: '1536x864', quality: 'max', extra: {},
  });
  assert.equal(copied.model, 'gpt-image-1.5');
  assert.equal(copied.size, '1024x1024');
  assert.equal(copied.quality, 'high');
  assert.doesNotThrow(() => validateTask(copied));
});
