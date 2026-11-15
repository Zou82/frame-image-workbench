import http from 'node:http';
import sharp from 'sharp';

const png = await sharp({
  create: { width: 256, height: 256, channels: 3, background: '#348b6a' },
}).png().toBuffer();
const counts = { active: 0, peak: 0, generated: 0, edits: 0, failed: 0, errors: [], models: 0 };
const accepted = ['fixture-image-a', 'fixture-image-b'];
const server = http.createServer(async (request, response) => {
  const json = (code, data) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (request.url === '/stats') return json(200, counts);
  if (request.url === '/reset') { Object.assign(counts, { peak: counts.active, generated: 0, edits: 0, failed: 0, errors: [], models: 0 }); return json(200, { ok: true }); }
  if (request.url === '/image.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(png); }
  if (request.headers.authorization !== 'Bearer fixture-key-local') return json(401, { error: { message: 'Fixture key rejected', code: 'invalid_api_key' } });
  if (request.url === '/v1/models') { counts.models++; return json(200, { data: accepted.map(id => ({ id, object: 'model' })) }); }
  if (!['/v1/images/generations', '/v1/images/edits'].includes(request.url)) return json(404, { error: { message: 'Unknown fixture route' } });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  let fields;
  try {
    if (request.url.endsWith('edits')) {
      counts.edits++;
      const form = await new Response(buffer, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
      fields = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'));
      fields.n = Number(fields.n);
      const files = [...form].filter(([key]) => key === 'image' || key === 'image[]');
      if (!files.length || files.some(([, file]) => file.size === 0)) throw new Error('Missing reference bytes');
      if (files.length > 1 && files.some(([key]) => key !== 'image[]')) throw new Error('Multiple references require image[]');
    } else fields = JSON.parse(buffer.toString('utf8'));
    if (!accepted.includes(fields.model)) throw new Error('Unexpected model');
    if (!fields.prompt || !Number.isInteger(fields.n) || fields.n < 1 || fields.n > 10) throw new Error('Bad prompt/count');
    if (fields.response_format || !fields.size || !fields.output_format || !fields.background || !fields.quality) throw new Error('Bad generation contract');
  } catch (error) { counts.errors.push(error.message); return json(400, { error: { message: error.message } }); }
  if (fields.prompt.includes('FAIL')) { counts.failed++; return json(429, { error: { message: 'Fixture rate limit fixture-key-local' } }); }
  counts.active++;
  counts.peak = Math.max(counts.peak, counts.active);
  let settled = false;
  const settle = () => { if (!settled) { settled = true; counts.active--; } };
  response.on('close', settle);
  const delay = fields.prompt.includes('SLOW') ? 20000 : 1500;
  setTimeout(() => {
    settle();
    if (response.destroyed) return;
    counts.generated++;
    const image = fields.prompt.includes('URL') ? { url: 'http://10.0.2.2:4329/image.png' } : { b64_json: png.toString('base64') };
    json(200, { created: Math.floor(Date.now() / 1000), data: Array.from({ length: fields.n }, () => ({ ...image, revised_prompt: fields.prompt })) });
  }, delay);
});
server.listen(4329, '0.0.0.0', () => console.log('Android test fixture on :4329 (mock requests only)'));
