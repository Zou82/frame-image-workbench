async (page) => {
  const base = 'http://127.0.0.1:4312';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  const initial = await (await page.request.get(`${base}/api/settings`)).json();
  const response = await page.request.put(`${base}/api/settings`, { data: {
    ...initial, concurrency: 100,
    profiles: [{ ...initial.profiles[0], name: 'Browser fixture', baseUrl: 'http://127.0.0.1:8766/v1',
      apiKey: 'fixture-only-key', models: ['gateway-art-v2', 'gpt-image-2.5-sunburst'] }],
  } });
  check(response.ok(), 'Fixture settings failed');
  await page.reload();
  await page.getByRole('button', { name: 'JSON 批量导入', exact: true }).click();
  const input = page.getByRole('textbox', { name: '任务 JSON', exact: true });
  await input.fill(JSON.stringify({ version: 1, tasks: [{ prompt: 'Valid' }, { prompt: 'Invalid', model: 'invented-model' }] }));
  await page.getByRole('alert').waitFor();
  check(await page.getByRole('button', { name: '导入草稿', exact: true }).isDisabled(), 'Invalid batch must not import');
  check((await page.getByRole('alert').innerText()).includes('tasks[1].model'), 'Invalid row must be located');
  const tasks = Array.from({ length: 100 }, (_, i) => ({
    title: `批量任务 ${String(i + 1).padStart(3, '0')}`,
    prompt: `Batch image ${String(i + 1).padStart(3, '0')}: distinct product photograph`,
    ...(i === 99 ? { model: 'gpt-image-2.5-sunburst', size: '1024x1536', quality: 'medium' } : {}),
  }));
  const json = JSON.stringify({ version: 1, defaults: { model: 'gateway-art-v2', size: '1536x1024', quality: 'high', n: 1 }, tasks });
  await input.fill(json);
  await page.getByRole('tab', { name: '给 AI 的提示词', exact: true }).click();
  const aiText = await page.getByRole('textbox', { name: '给 AI 的 JSON 生成提示词' }).inputValue();
  check(aiText.includes('gateway-art-v2') && aiText.includes('gpt-image-2.5-sunburst'), 'AI prompt must contain actual models');
  await page.getByRole('tab', { name: 'JSON 数据', exact: true }).click();
  await page.getByRole('button', { name: '导入草稿 (100)', exact: true }).click();
  await page.getByRole('table', { name: '批量任务列表' }).waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('frame-workbench-drafts-v1') || '[]').length === 100);
  check(await page.locator('.task-table-row').count() === 25, 'List must render25 rows');
  check((await page.locator('.batch-pagination').innerText()).includes('1 / 4 页'), 'List must have4 pages');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  check((await page.locator('.task-row-copy').first().innerText()).includes('026'), 'Page2 must start26');
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('批量任务 100');
  check(await page.locator('.task-table-row').count() === 1, 'Search must match one task');
  check((await page.locator('.task-row-parameters').innerText()).includes('1024x1536'), 'Task override must survive import');
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('');
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  check(await page.locator('.task-card').count() === 6, 'Cards must paginate6');
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  console.log('PASS: atomic validation,100 task import, model prompt, overrides, pagination, search, card mode.');
}
