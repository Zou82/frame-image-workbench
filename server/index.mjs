import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { createStorage } from './storage.mjs';
import { TaskQueue } from './queue.mjs';
import { validateTask, requestImages, normalizeBaseUrl, validateApiKey, redact } from './provider.mjs';
import { MAX_CONCURRENCY } from '../shared/batch.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INITIAL_SETTINGS = {
  concurrency: 3,
  profiles: [{
    id: 'default', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1',
    apiKey: '', models: [], timeout: 600,
  }],
};
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const pendingStates = new Set(['running', 'queued']);

export async function createApp({ dataDir = path.join(projectRoot, 'data') } = {}) {
  const storage = await createStorage(dataDir);
  let settings = await storage.read('settings', INITIAL_SETTINGS);
  settings = {
    ...settings,
    profiles: settings.profiles.map(profile => ({ ...profile, baseUrl: normalizeBaseUrl(profile.baseUrl) })),
  };
  const credentials = new Map();
  let storageError = '';
  const publicSettings = () => ({
    concurrency: settings.concurrency,
    profiles: settings.profiles.map(({ apiKey, ...profile }) => ({ ...profile, hasKey: Boolean(apiKey) })),
  });
  let settingsWrites = Promise.resolve();
  const updateSettings = mutate => {
    const operation = settingsWrites.then(async () => {
      const next = mutate(settings);
      await storage.write('settings', next);
      settings = next;
    });
    settingsWrites = operation.catch(() => {});
    return operation;
  };
  const persistJobs = jobs => storage.write('jobs', jobs).catch(error => {
    storageError = '历史记录写入失败，请检查磁盘空间和 data 文件夹权限。';
    console.error('Task persistence failed:', error.code || 'unknown');
  });
  const resolveMedia = id => {
    if (!/^(uploads|outputs)\/[a-f0-9-]+\.(png|jpeg|webp)$/.test(id)) throw new Error('参考图片路径无效。');
    return path.join(dataDir, id);
  };
  const queue = new TaskQueue({
    concurrency: settings.concurrency,
    initialJobs: await storage.read('jobs', []),
    onChange: persistJobs,
    worker: async (job, signal) => {
      const connection = credentials.get(job.id);
      if (!connection) throw new Error('连接配置不可用，请重新提交任务。');
      const written = [];
      try {
        const data = await requestImages(job, connection, {
          signal,
          readReference: async id => {
            const buffer = await readFile(resolveMedia(id));
            return { buffer, name: path.basename(id), mime: MIME[path.extname(id).slice(1)] };
          },
        });
        const results = [];
        for (const item of data) {
          signal.throwIfAborted();
          let buffer;
          if (item.b64_json) {
            if (item.b64_json.length > 100 * 1024 * 1024) throw new Error('返回图片过大。');
            buffer = Buffer.from(item.b64_json, 'base64');
          } else {
            const url = new URL(item.url);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 返回了无效的图片地址。');
            const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: 'error' });
            if (!response.ok) throw new Error(`结果图片下载失败（HTTP ${response.status}）。`);
            if (Number(response.headers.get('content-length')) > 75 * 1024 * 1024) throw new Error('返回图片过大。');
            const chunks = [];
            let length = 0;
            for await (const chunk of response.body) {
              length += chunk.byteLength;
              if (length > 75 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('返回图片过大。'); }
              chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
          }
          const meta = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata();
          if (!MIME[meta.format]) throw new Error('API 返回的图片不是 PNG、JPEG 或 WebP。');
          const id = `outputs/${randomUUID()}.${meta.format}`;
          await writeFile(resolveMedia(id), buffer);
          written.push(id);
          results.push({
            id, url: `/media/${id}`, width: meta.width, height: meta.height,
            bytes: buffer.length, format: meta.format, revisedPrompt: item.revised_prompt || '',
          });
        }
        signal.throwIfAborted();
        return results;
      } catch (error) {
        await Promise.all(written.map(id => unlink(resolveMedia(id)).catch(() => {})));
        throw new Error(redact(error.message, connection.apiKey));
      } finally {
        credentials.delete(job.id);
      }
    },
  });
  await storage.write('jobs', queue.list());
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return res.status(403).json({ error: '只允许本机访问。' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({ error: '请求来源无效。' }); }
      const ownOrigin = `${req.protocol}://${req.get('host')}`;
      const devOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost):5173$/.test(origin.origin);
      if (origin.origin !== ownOrigin && !(process.env.NODE_ENV === 'development' && devOrigin)) {
        return res.status(403).json({ error: '请求来源不被允许。' });
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (req, res) => res.json({ app: 'frame-image-workbench', pid: process.pid, ok: true, storageError }));
  app.get('/api/settings', (req, res) => res.json(publicSettings()));
  app.put('/api/settings', async (req, res) => {
    await updateSettings(current => {
      const input = req.body;
      const concurrency = Number(input.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error(`并发数必须是 1 到 ${MAX_CONCURRENCY}。`);
      if (!Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > 20) throw new Error('请保留 1 到 20 个 API 连接。');
      const ids = new Set();
      const profiles = input.profiles.map(profile => {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(profile.id || '') || ids.has(profile.id)) throw new Error('API 连接标识无效或重复。');
        ids.add(profile.id);
        const previous = current.profiles.find(item => item.id === profile.id);
        const apiKey = profile.clearKey ? '' : (String(profile.apiKey || '').trim() || previous?.apiKey || '');
        validateApiKey(apiKey);
        const timeout = Number(profile.timeout || 600);
        if (!Number.isInteger(timeout) || timeout < 30 || timeout > 1800) throw new Error('超时时间必须为 30 到 1800 秒。');
        if (!Array.isArray(profile.models) || profile.models.length > 1000
          || profile.models.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
          throw new Error('模型列表最多包含 1000 个有效模型 ID。');
        }
        return {
          id: profile.id, name: String(profile.name || 'API 连接').slice(0, 60),
          baseUrl: normalizeBaseUrl(profile.baseUrl), apiKey, timeout,
          models: [...new Set(profile.models.map(id => id.trim()))],
        };
      });
      return { concurrency, profiles };
    });
    queue.setConcurrency(settings.concurrency);
    res.json(publicSettings());
  });
  app.post(['/api/profiles/:id/test', '/api/profiles/:id/models'], async (req, res) => {
    const profile = settings.profiles.find(item => item.id === req.params.id);
    if (!profile?.apiKey) throw new Error('请先保存 API Key。');
    validateApiKey(profile.apiKey);
    try {
      const endpoint = `${normalizeBaseUrl(profile.baseUrl)}/models`;
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${profile.apiKey}` },
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = data.error?.code || data.error?.type || data.code;
        const message = data.error?.message || data.message || response.statusText || '连接失败。';
        const hint = response.status === 401
          ? '。模型列表接口拒绝了当前保存的密钥，请在服务商的 API 密钥页面核对调用密钥及其权限。'
          : '';
        throw new Error(`GET ${endpoint}（HTTP ${response.status}${code ? `，${code}` : ''}）：${message}${hint}`);
      }
      if (!Array.isArray(data.data)) throw new Error(`GET ${endpoint}：接口没有返回有效模型列表。`);
      const ids = data.data.map(item => item?.id);
      if (ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200) || ids.length > 1000) {
        throw new Error(`GET ${endpoint}：模型列表包含无效 ID 或超过 1000 个模型，原列表已保留。`);
      }
      const models = [...new Set(ids.map(id => id.trim()))];
      if (req.path.endsWith('/models')) {
        await updateSettings(current => {
          const connection = current.profiles.find(item => item.id === profile.id);
          if (!connection || connection.apiKey !== profile.apiKey || connection.baseUrl !== profile.baseUrl) {
            throw new Error('连接配置已更改，请重新获取模型。');
          }
          return {
            ...current,
            profiles: current.profiles.map(item => item.id === profile.id ? { ...item, models } : item),
          };
        });
        return res.json({ ok: true, endpoint, models, settings: publicSettings() });
      }
      res.json({ ok: true, endpoint, models });
    } catch (error) { throw new Error(redact(error.message, profile.apiKey)); }
  });
  const upload = multer({
    dest: path.join(dataDir, 'temp'),
    limits: { fileSize: 20 * 1024 * 1024, files: 16, fields: 0 },
    fileFilter: (req, file, cb) => {
      if (!Object.values(MIME).includes(file.mimetype)) return cb(new Error('参考图仅支持 PNG、JPEG、WebP。'));
      cb(null, true);
    },
  });
  app.post('/api/uploads', (req, res, next) => {
    upload.array('images', 16)(req, res, async error => {
      const saved = [];
      try {
        if (error) throw error;
        if (!req.files?.length) throw new Error('请选择参考图片。');
        for (const file of req.files) {
          const buffer = await readFile(file.path);
          let meta;
          try { meta = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata(); }
          catch { throw new Error('文件不是有效图片，或像素尺寸过大。'); }
          if (!MIME[meta.format]) throw new Error('图片格式不受支持。');
          const id = `uploads/${randomUUID()}.${meta.format}`;
          await writeFile(resolveMedia(id), buffer);
          saved.push({ id, url: `/media/${id}`, name: path.basename(file.originalname).slice(0, 120), width: meta.width, height: meta.height, bytes: buffer.length });
        }
        res.json({ files: saved });
      } catch (err) {
        await Promise.all(saved.map(file => unlink(resolveMedia(file.id)).catch(() => {})));
        next(err);
      } finally {
        await Promise.all((req.files || []).map(file => unlink(file.path).catch(() => {})));
      }
    });
  });
  app.get('/api/jobs', (req, res) => res.json({ jobs: queue.list(), storageError }));
  app.post('/api/jobs', async (req, res) => {
    if (storageError) throw new Error(storageError);
    const task = validateTask(req.body);
    const profile = settings.profiles.find(item => item.id === task.profileId);
    if (!profile?.apiKey) throw new Error('请先在 API 连接中配置并保存密钥。');
    validateApiKey(profile.apiKey);
    if (!profile.models.includes(task.model)) throw new Error('所选模型不在此 API 连接的模型列表中，请获取模型后重新选择。');
    for (const ref of task.references) {
      try { await stat(resolveMedia(ref)); } catch { throw new Error('参考图片已不存在，请重新上传。'); }
    }
    const job = queue.add({ ...task, profileName: profile.name }, { deferred: true });
    // Capture the chosen connection now so later settings changes cannot reroute queued work.
    credentials.set(job.id, structuredClone(profile));
    try { await storage.write('jobs', queue.list()); }
    catch {
      queue.cancel(job.id);
      credentials.delete(job.id);
      throw new Error('任务未能写入本地记录，请检查磁盘空间。此任务未提交给 API。');
    }
    queue.start(job.id);
    res.status(201).json(job);
  });
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const changed = queue.cancel(req.params.id);
    if (!changed) return res.status(409).json({ error: '任务已结束或不存在。' });
    if (!queue.active.has(req.params.id)) credentials.delete(req.params.id);
    res.json({ ok: true });
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    const job = queue.jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在。' });
    if (pendingStates.has(job.status)) return res.status(409).json({ error: '请先取消任务。' });
    queue.jobs = queue.jobs.filter(item => item.id !== job.id);
    await storage.write('jobs', queue.list());
    // Keep files: other drafts or historical jobs may use them as references.
    res.json({ ok: true });
  });
  app.use('/media/uploads', express.static(path.join(dataDir, 'uploads'), { dotfiles: 'deny', maxAge: '1d' }));
  app.use('/media/outputs', express.static(path.join(dataDir, 'outputs'), { dotfiles: 'deny', maxAge: '1d' }));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(express.static(path.join(projectRoot, 'dist')));
  app.get('/{*page}', (req, res) => res.sendFile(path.join(projectRoot, 'dist', 'index.html')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const message = error.code === 'LIMIT_FILE_SIZE' ? '单张参考图不能超过 20 MB。'
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? '一次最多上传 16 张参考图。'
        : error.type === 'entity.too.large' ? '请求内容过大。'
          : error instanceof SyntaxError ? '请求 JSON 格式无效。'
            : error.message || '请求失败。';
    const clean = settings.profiles.reduce((text, profile) => redact(text, profile.apiKey), message);
    res.status(400).json({ error: clean });
  });
  return { app, queue, storage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { app, storage } = await createApp();
  let port = Number(process.env.PORT || 4311);
  const listen = () => {
    const server = app.listen(port, '127.0.0.1', async () => {
      const url = `http://127.0.0.1:${port}`;
      await storage.write('runtime', { pid: process.pid, port, url }).catch(() => {});
      console.log(`FRAME Image Workbench: ${url}`);
    });
    server.on('error', error => {
      if (error.code === 'EADDRINUSE' && port < 4331) { port++; listen(); }
      else { console.error('Unable to start local server:', error.message); process.exitCode = 1; }
    });
  };
  listen();
}
