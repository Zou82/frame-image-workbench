import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-browser-qa-'));
const fixture = express();
fixture.use(express.json());
const parseImages = multer({ storage: multer.memoryStorage() }).any();
const records = [];
let active = 0;
let maxActive = 0;
let modelIds = ['gateway-art-v2', 'gpt-image-2.5-sunburst'];
let modelStatus = 200;
let generationDelay = 2200;
fixture.put('/fixture/delay', (req, res) => {
  generationDelay = Math.max(0, Math.min(15000, Number(req.body.ms) || 0));
  res.json({ ok: true });
});
fixture.put('/fixture/models', (req, res) => {
  modelIds = req.body.models;
  modelStatus = req.body.status || 200;
  res.json({ ok: true });
});
fixture.get('/v1/models', (req, res) => res.status(modelStatus).json(modelStatus === 200
  ? { data: modelIds.map(id => ({ id })) }
  : { error: { message: 'QA model discovery unavailable' } }));
fixture.get('/observations', (req, res) => res.json({ records, active, maxActive }));
const handle = async (req, res) => {
  active++;
  maxActive = Math.max(active, maxActive);
  records.push({ endpoint: req.path, model: req.body.model, prompt: req.body.prompt, n: Number(req.body.n), size: req.body.size, quality: req.body.quality, references: req.files?.length || 0 });
  await new Promise(resolve => setTimeout(resolve, generationDelay));
  if (String(req.body.prompt).includes('[fail]')) { active--; return res.status(500).json({ error: { message: 'Browser QA intentional upstream error' } }); }
  const image = String(req.body.prompt).includes('nature') ? 'nature' : 'product';
  const png = await sharp(path.join(root, 'public', 'assets', `${image}.jpg`)).resize(640, 640, { fit: 'cover' }).png().toBuffer();
  active--;
  res.json({ data: Array.from({ length: Number(req.body.n) || 1 }, () => ({ b64_json: png.toString('base64') })) });
};
fixture.post('/v1/images/generations', handle);
fixture.post('/v1/images/edits', parseImages, handle);
const upstream = fixture.listen(8766, '127.0.0.1');
const { app, queue } = await createApp({ dataDir });
const server = app.listen(4312, '127.0.0.1', () => console.log(`QA workbench: http://127.0.0.1:4312 (data: ${dataDir})`));
const shutdown = () => {
  queue.list().filter(job => ['queued', 'running'].includes(job.status)).forEach(job => queue.cancel(job.id));
  server.close();
  upstream.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
