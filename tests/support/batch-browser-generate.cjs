async (page) => {
  const base = 'http://127.0.0.1:4312';
  const fixture = 'http://127.0.0.1:8766';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let { jobs } = await (await page.request.get(`${base}/api/jobs`)).json();
  check(jobs.length === 0 || jobs.length === 100, 'Run against the isolated100-task fixture');
  if (!jobs.length) {
    await page.request.put(`${fixture}/fixture/delay`, { data: { ms: 8000 } });
    await page.getByRole('button', { name: /^全部生成/ }).click();
    for (let attempt = 0; attempt < 100; attempt++) {
      ({ jobs } = await (await page.request.get(`${base}/api/jobs`)).json());
      if (jobs.length === 100) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check(jobs.length === 100, 'All100 tasks must reach the local queue');
    await page.getByRole('button', { name: '统一参数', exact: true }).click();
    check(await page.getByRole('button', { name: '应用勾选参数', exact: true }).isDisabled(), 'Running tasks must be protected from bulk edits');
    await page.getByRole('button', { name: '关闭统一参数', exact: true }).click();
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    ({ jobs } = await (await page.request.get(`${base}/api/jobs`)).json());
    if (jobs.length === 100 && jobs.every(job => ['completed', 'failed'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  check(jobs.every(job => job.status === 'completed'), 'All100 fixture tasks must complete: ' + jobs.filter(job => job.status !== 'completed').map(job => job.error).join('; '));
  const observations = await (await page.request.get(`${fixture}/observations`)).json();
  check(observations.records.length === 100, 'Exactly100 upstream requests expected');
  check(new Set(observations.records.map(item => item.prompt)).size === 100, 'Distinct prompts must not duplicate');
  check(observations.maxActive === 100, `Expected100 actual simultaneous requests, got${observations.maxActive}`);
  const last = observations.records.find(item => item.prompt.startsWith('Batch image 100:'));
  check(last.model === 'gateway-art-v2' && last.size === '1024x1536' && last.quality === 'medium', 'Last task must send individual overrides');
  const first = observations.records.find(item => item.prompt.startsWith('Batch image 001:'));
  check(first.model === 'gpt-image-2.5-sunburst' && first.size === '1536x864' && first.references > 0, 'Shared parameters and references must reach multipart editing API');
  const result = await page.request.get(base + jobs[0].results[0].url);
  check(result.ok() && result.headers()['content-type'].startsWith('image/'), 'Output file must be downloadable');
  await page.getByRole('combobox', { name: '筛选任务状态', exact: true }).selectOption('completed');
  await page.waitForFunction(() => document.querySelector('.filter-count')?.textContent.includes('100 / 100'));
  await page.screenshot({ path: 'output/playwright/batch-results-desktop.png' });
  await page.locator('.task-row-thumb').first().click();
  await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor();
  check(await page.locator('.preview-image img').evaluate(image => image.complete && image.naturalWidth > 0), 'Generated image preview must render');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile result list must fit');
  await page.screenshot({ path: 'output/playwright/batch-results-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(JSON.stringify({ passed: true, jobs: jobs.length, upstreamRequests: observations.records.length, actualPeakConcurrency: observations.maxActive, outputs: jobs.reduce((sum, job) => sum + job.results.length, 0) }));
}
