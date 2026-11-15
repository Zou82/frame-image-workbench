async (page) => {
  await page.reload();
  await page.getByRole('button', { name: 'API 连接与设置', exact: true }).click();
  const concurrency = page.getByRole('spinbutton', { name: '最大并行任务精确值', exact: true });
  if (await concurrency.inputValue() !== '100') throw new Error('Numeric concurrency must reflect saved100');
  if (await concurrency.getAttribute('max') !== '100') throw new Error('Numeric concurrency max must100');
  await concurrency.fill('50');
  if (await page.locator('#global-concurrency').inputValue() !== '50') throw new Error('Slider and numeric input must synchronize');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))) throw new Error('API settings overflow mobile');
  await page.screenshot({ path: 'output/playwright/batch-api-settings-mobile.png' });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))) throw new Error('Workbench overflows320px');
  await page.getByRole('button', { name: '统一参数', exact: true }).click();
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))) throw new Error('Defaults dialog overflows320px');
  await page.getByRole('button', { name: '关闭统一参数', exact: true }).click();
  await page.getByRole('button', { name: 'JSON 批量导入', exact: true }).click();
  await page.getByRole('textbox', { name: '任务 JSON', exact: true }).fill('{"defaults":null,"tasks":[{"prompt":"test"}]}');
  if (!(await page.getByRole('button', { name: '导入草稿', exact: true }).isDisabled())) throw new Error('Explicit null defaults must fail');
  await page.getByRole('textbox', { name: '任务 JSON', exact: true }).fill('{"tasks":[{"prompt":"test","quality":""}]}');
  if (!(await page.getByRole('button', { name: '导入草稿', exact: true }).isDisabled())) throw new Error('Explicit empty quality must fail');
  await page.getByRole('button', { name: '关闭导入', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS: final bundle, numeric concurrency50/100 synchronization,320px layouts, strict empty/null batch validation.');
}
