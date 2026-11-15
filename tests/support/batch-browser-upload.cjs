async (page) => {
  const image = await (await page.request.get('http://127.0.0.1:4312/assets/product.jpg')).body();
  const originalCount = await page.evaluate(() => JSON.parse(localStorage.getItem('frame-workbench-drafts-v1'))[0].references.length);
  let release;
  let observed;
  const started = new Promise(resolve => { observed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/uploads', async route => { observed(); await gate; await route.continue(); });
  try {
    await page.locator('input[aria-label="任务 1 参考图片"]').setInputFiles({ name: 'fixture.jpg', mimeType: 'image/jpeg', buffer: image });
    await started;
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    const upload = page.locator('.task-card').first().locator('.upload-button');
    if (!(await upload.isDisabled())) throw new Error('Upload must remain locked after pagination and remount');
    if (!(await page.getByRole('button', { name: /^全部生成/ }).isDisabled())) throw new Error('Generate all must wait for upload');
    console.log('PASS: uploading state persists across card pagination; duplicate uploads blocked.');
  } finally {
    release();
    await page.waitForFunction(expected => {
      const drafts = JSON.parse(localStorage.getItem('frame-workbench-drafts-v1') || '[]');
      return drafts[0]?.references.length === expected;
    }, originalCount + 1);
    await page.unroute('**/api/uploads');
  }
}
