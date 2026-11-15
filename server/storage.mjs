import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function createStorage(root) {
  for (const dir of ['uploads', 'outputs', 'temp']) await mkdir(path.join(root, dir), { recursive: true });
  let writes = Promise.resolve();
  return {
    root,
    async read(name, fallback) {
      try { return JSON.parse(await readFile(path.join(root, `${name}.json`), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw new Error(`无法读取 data/${name}.json，请检查文件或从备份恢复。`);
      }
    },
    write(name, data) {
      const contents = JSON.stringify(data, null, 2);
      const operation = writes.then(async () => {
        const temp = path.join(root, `.${name}-${randomUUID()}.tmp`);
        await writeFile(temp, contents, { mode: 0o600 });
        await rename(temp, path.join(root, `${name}.json`));
      });
      writes = operation.catch(() => {});
      return operation;
    },
  };
}
