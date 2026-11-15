import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONCURRENCY,
  MAX_DRAFTS,
  MAX_IMPORT_TASKS,
  applyBulkSettings,
  buildAiPrompt,
  createBatchDefaults,
  getBatchTemplate,
  modelChange,
  parseBatchJson,
} from '../shared/batch.mjs';
import { validateTask as sharedValidateTask } from '../shared/task-validation.mjs';
import { validateTask as providerValidateTask } from '../server/provider.mjs';

const settings = {
  concurrency: 8,
  profiles: [
    { id: 'primary', name: 'Primary', models: ['gpt-image-2.5-flare', 'gpt-image-1.5'] },
    { id: 'other', name: 'Other', models: ['other-art'] },
    { id: 'empty', name: 'Empty', models: [] },
  ],
};

const defaults = createBatchDefaults(settings, {
  profileId: 'primary',
  model: 'gpt-image-2.5-flare',
  size: '1536x864',
  quality: 'max',
  n: 2,
  outputFormat: 'webp',
  background: 'opaque',
  extra: '{"seed":7}',
});

test('batch defaults and shared validation use only actual configured models', () => {
  assert.deepEqual(
    createBatchDefaults(settings, { profileId: 'missing', model: 'invented-model', quality: 'high' }),
    {
      profileId: 'primary',
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
      quality: 'high',
      n: 1,
      outputFormat: 'png',
      background: 'auto',
      extra: '{}',
    },
  );
  assert.equal(createBatchDefaults({ profiles: [{ id: 'empty', models: [] }] }).model, '');
  const input = {
    title: 'Shared validator',
    prompt: 'A glass object',
    profileId: 'primary',
    model: 'gpt-image-1.5',
    size: '1024x1024',
    quality: 'auto',
    n: 1,
    outputFormat: 'png',
    background: 'auto',
    references: [],
    extra: {},
  };
  assert.deepEqual(sharedValidateTask(input), providerValidateTask(input));
  assert.equal(MAX_DRAFTS, 500);
  assert.equal(MAX_IMPORT_TASKS, 500);
  assert.equal(MAX_CONCURRENCY, 100);
  assert.deepEqual(
    modelChange({ size: '1536x864', quality: 'max', background: 'transparent' }, 'gpt-image-1.5'),
    { model: 'gpt-image-1.5', size: '1024x1024', quality: 'high' },
  );
});

test('JSON import preserves 100 prompt rows and applies task overrides over JSON and UI defaults', () => {
  const source = {
    version: 1,
    defaults: { n: 3, outputFormat: 'png', extra: { style: 'catalog' } },
    tasks: Array.from({ length: 100 }, (_, index) => index === 37
      ? { title: 'Portrait override', prompt: `Distinct prompt ${index}`, size: '1024x1536', quality: 'high' }
      : { title: `Task ${index}`, prompt: `Distinct prompt ${index}` }),
  };
  const result = parseBatchJson(JSON.stringify(source), settings, defaults);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks.length, 100);
  assert.deepEqual(result.tasks.map(task => task.prompt), Array.from({ length: 100 }, (_, index) => `Distinct prompt ${index}`));
  assert.equal(result.tasks[0].model, 'gpt-image-2.5-flare');
  assert.equal(result.tasks[0].size, '1536x864');
  assert.equal(result.tasks[0].quality, 'max');
  assert.equal(result.tasks[0].n, 3);
  assert.equal(result.tasks[0].outputFormat, 'png');
  assert.deepEqual(result.tasks[0].extra, { style: 'catalog' });
  assert.deepEqual(result.tasks[0].references, []);
  assert.equal('id' in result.tasks[0], false);
  assert.equal('jobId' in result.tasks[0], false);
  assert.equal(result.tasks[37].title, 'Portrait override');
  assert.equal(result.tasks[37].size, '1024x1536');
  assert.equal(result.tasks[37].quality, 'high');
});

test('JSON import accepts prompt string shorthand and resolves profile changes without borrowing another profile model', () => {
  const source = {
    tasks: [
      'A short prompt',
      { prompt: 'Uses the other connection', profileId: 'other' },
      { prompt: 'Explicit other model', profileId: 'other', model: 'other-art' },
    ],
  };
  const result = parseBatchJson(JSON.stringify(source), settings, defaults);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].prompt, 'A short prompt');
  assert.equal(result.tasks[0].model, 'gpt-image-2.5-flare');
  assert.equal(result.tasks[1].profileId, 'other');
  assert.equal(result.tasks[1].model, 'other-art');
  assert.equal(result.tasks[2].model, 'other-art');

  const conflict = parseBatchJson(JSON.stringify({
    defaults: { model: 'gpt-image-1.5' },
    tasks: [{ prompt: 'Wrong connection for inherited explicit model', profileId: 'other' }],
  }), settings, defaults);
  assert.deepEqual(conflict.tasks, []);
  assert.match(conflict.errors.join('\n'), /tasks\[0\]\.model.*other/i);
});

test('JSON import normalizes only incompatible UI fields inherited across an explicit model change', () => {
  const inherited = parseBatchJson(JSON.stringify({
    tasks: [{ prompt: 'Old model with inherited modern options', model: 'gpt-image-1.5' }],
  }), settings, defaults);
  assert.deepEqual(inherited.errors, []);
  assert.equal(inherited.tasks[0].size, '1024x1024');
  assert.equal(inherited.tasks[0].quality, 'high');

  const explicit = parseBatchJson(JSON.stringify({
    defaults: { size: '1536x864' },
    tasks: [{ prompt: 'Old model with explicit incompatible size', model: 'gpt-image-1.5' }],
  }), settings, defaults);
  assert.deepEqual(explicit.tasks, []);
  assert.match(explicit.errors.join('\n'), /tasks\[0\]\.size|尺寸/);
});

test('JSON import reports located malformed fields and remains atomic across every invalid row', () => {
  const cases = [
    ['malformed JSON', '{', /JSON/],
    ['unknown root field', JSON.stringify({ tasks: ['ok'], surprise: true }), /surprise/],
    ['unsupported version', JSON.stringify({ version: 2, tasks: ['ok'] }), /version/],
    ['null defaults', JSON.stringify({ defaults: null, tasks: ['ok'] }), /defaults/],
    ['unknown task field', JSON.stringify({ tasks: [{ prompt: 'ok', surprise: true }] }), /tasks\[0\]\.surprise/],
    ['wrong parameter type', JSON.stringify({ tasks: [{ prompt: 'ok', n: '2' }] }), /tasks\[0\]\.n/],
    ['empty size', JSON.stringify({ tasks: [{ prompt: 'ok', size: '' }] }), /tasks\[0\]\.size/],
    ['empty quality', JSON.stringify({ tasks: [{ prompt: 'ok', quality: '' }] }), /tasks\[0\]\.quality/],
    ['empty output format', JSON.stringify({ tasks: [{ prompt: 'ok', outputFormat: '' }] }), /tasks\[0\]\.outputFormat/],
    ['empty background', JSON.stringify({ tasks: [{ prompt: 'ok', background: '' }] }), /tasks\[0\]\.background/],
    ['unknown profile', JSON.stringify({ tasks: [{ prompt: 'ok', profileId: 'missing' }] }), /tasks\[0\]\.profileId/],
    ['unknown model', JSON.stringify({ tasks: [{ prompt: 'ok', model: 'invented' }] }), /tasks\[0\]\.model/],
    ['empty prompt', JSON.stringify({ tasks: [{ prompt: '   ' }] }), /tasks\[0\]\.prompt/],
    ['overlong prompt', JSON.stringify({ tasks: [{ prompt: 'x'.repeat(32001) }] }), /tasks\[0\]\.prompt/],
    ['invalid extra', JSON.stringify({ tasks: [{ prompt: 'ok', extra: [] }] }), /tasks\[0\]\.extra/],
  ];
  for (const [name, text, pattern] of cases) {
    const result = parseBatchJson(text, settings, defaults);
    assert.deepEqual(result.tasks, [], name);
    assert.match(result.errors.join('\n'), pattern, name);
  }

  const multiple = parseBatchJson(JSON.stringify({
    tasks: [
      { prompt: 'valid first row' },
      { prompt: '', model: 'invented' },
      { prompt: 'valid last row' },
    ],
  }), settings, defaults);
  assert.deepEqual(multiple.tasks, []);
  assert.ok(multiple.errors.some(error => /tasks\[1\]\.prompt/.test(error)));
  assert.ok(multiple.errors.some(error => /tasks\[1\]\.model/.test(error)));
});

test('JSON import enforces task count and text-size limits without throwing', () => {
  for (const source of [
    { tasks: [] },
    { tasks: Array.from({ length: 501 }, () => 'prompt') },
  ]) {
    const result = parseBatchJson(JSON.stringify(source), settings, defaults);
    assert.deepEqual(result.tasks, []);
    assert.match(result.errors.join('\n'), /1.*500|500/);
  }
  const tooLarge = parseBatchJson(`{"tasks":["${'x'.repeat(20 * 1024 * 1024)}"]}`, settings, defaults);
  assert.deepEqual(tooLarge.tasks, []);
  assert.match(tooLarge.errors.join('\n'), /20 MB/i);
});

test('bulk settings selectively update editable drafts while preserving locked jobs, prompts and references', () => {
  const references = [{ id: 'uploads/a.png', url: '/media/uploads/a.png', name: 'A' }];
  const drafts = [
    {
      id: 'editable',
      title: 'Keep title',
      prompt: '',
      profileId: 'primary',
      model: 'gpt-image-2.5-flare',
      size: '1536x864',
      quality: 'max',
      n: 1,
      outputFormat: 'png',
      background: 'transparent',
      extra: '{"seed":1}',
      references,
      jobId: 'finished-job',
    },
    {
      id: 'locked',
      title: 'Locked',
      prompt: 'Do not touch',
      profileId: 'primary',
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
      quality: 'high',
      n: 1,
      outputFormat: 'webp',
      background: 'auto',
      extra: '{}',
      references: [],
      jobId: 'running-job',
    },
  ];
  const result = applyBulkSettings(drafts, { model: 'gpt-image-1.5', n: 4 }, settings, new Set(['locked']));
  assert.deepEqual(result.errors, []);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.drafts[1], drafts[1]);
  assert.equal(result.drafts[0].title, 'Keep title');
  assert.equal(result.drafts[0].prompt, '');
  assert.equal(result.drafts[0].jobId, 'finished-job');
  assert.equal(result.drafts[0].references, references);
  assert.equal(result.drafts[0].references[0], references[0]);
  assert.equal(result.drafts[0].extra, '{"seed":1}');
  assert.equal(result.drafts[0].model, 'gpt-image-1.5');
  assert.equal(result.drafts[0].size, '1024x1024');
  assert.equal(result.drafts[0].quality, 'high');
  assert.equal(result.drafts[0].background, 'transparent');
  assert.equal(result.drafts[0].n, 4);
});

test('bulk profile changes choose the new connection model and invalid explicit combinations fail atomically', () => {
  const drafts = [{
    id: 'a',
    title: 'A',
    prompt: 'Prompt A',
    profileId: 'primary',
    model: 'gpt-image-2.5-flare',
    size: '1536x864',
    quality: 'max',
    n: 1,
    outputFormat: 'png',
    background: 'transparent',
    extra: '{}',
    references: [],
    jobId: null,
  }, {
    id: 'b',
    title: 'B',
    prompt: 'Prompt B',
    profileId: 'primary',
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    quality: 'auto',
    n: 1,
    outputFormat: 'png',
    background: 'auto',
    extra: '{}',
    references: [],
    jobId: null,
  }];
  const moved = applyBulkSettings(drafts, { profileId: 'other' }, settings);
  assert.deepEqual(moved.errors, []);
  assert.equal(moved.updated, 2);
  assert.ok(moved.drafts.every(draft => draft.model === 'other-art' && draft.profileId === 'other'));

  for (const patch of [
    { model: 'invented' },
    { profileId: 'empty' },
    { model: 'gpt-image-1.5', size: '1536x864' },
    { model: 'gpt-image-2.5-flare', background: 'transparent', outputFormat: 'jpeg' },
    { n: 0 },
    { extra: '[]' },
  ]) {
    const failed = applyBulkSettings(drafts, patch, settings);
    assert.equal(failed.drafts, drafts);
    assert.equal(failed.updated, 0);
    assert.ok(failed.errors.length, JSON.stringify(patch));
  }
});

test('template and external-AI prompt expose the exact local contract without credentials', () => {
  const templateText = getBatchTemplate(defaults);
  const template = JSON.parse(templateText);
  assert.equal(template.version, 1);
  assert.equal(template.tasks.length, 2);
  assert.equal(template.tasks[1].size, '1024x1536');
  assert.match(template.tasks[0].prompt, /[\u4e00-\u9fff]/);
  assert.equal('apiKey' in template.defaults, false);
  assert.deepEqual(template.defaults.extra, { seed: 7 });

  const secretSettings = {
    profiles: settings.profiles.map((profile, index) => ({
      ...profile,
      apiKey: `private-secret-${index}`,
      baseUrl: `https://private-${index}.example/v1`,
    })),
  };
  const prompt = buildAiPrompt(secretSettings, defaults);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /任务覆盖.*JSON.*默认.*界面默认/s);
  assert.match(prompt, /profileId.*model.*size.*quality.*n.*outputFormat.*background.*extra/s);
  assert.match(prompt, /auto.*1024x1024.*1536x1024.*1024x1536/s);
  assert.match(prompt, /16.*3840.*3:1.*655360.*8294400/s);
  assert.match(prompt, /xhigh.*max.*gpt-image-2\.[56]-/s);
  assert.match(prompt, /png.*jpeg.*webp/s);
  assert.match(prompt, /transparent.*jpeg.*gpt-image-2/s);
  assert.match(prompt, /primary.*gpt-image-2\.5-flare.*gpt-image-1\.5/s);
  assert.match(prompt, /other.*other-art/s);
  assert.ok(prompt.includes(templateText));
  assert.equal(prompt.includes('private-secret'), false);
  assert.equal(prompt.includes('private-0.example'), false);
  assert.match(prompt, /不要.*凭据|不得.*凭据/);
  assert.match(prompt, /不要.*参考图|不得.*参考图/);
});
