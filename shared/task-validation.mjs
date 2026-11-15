const PROTECTED = new Set([
  'model', 'prompt', 'n', 'size', 'quality', 'background', 'output_format',
  'response_format', 'stream', 'partial_images', 'image', 'images', 'mask',
  'api_key', 'apiKey', '__proto__', 'constructor', 'prototype',
]);
const OLD_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);

export function validateTask(input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 32000) throw new Error('提示词不能为空，且不能超过 32000 个字符。');
  const model = String(input.model || '').trim();
  if (!model || model.length > 200) throw new Error('请选择有效的模型。');
  const n = Number(input.n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('生成数量必须是 1 到 10 的整数。');
  const size = String(input.size || '1024x1024');
  if (!OLD_SIZES.has(size)) {
    const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
    const [w, h] = match ? match.slice(1).map(Number) : [0, 0];
    if (!match || w % 16 || h % 16 || Math.max(w, h) > 3840 || Math.max(w, h) / Math.min(w, h) > 3
      || w * h < 655360 || w * h > 8294400 || /^gpt-image-1(?:[.-]|$)/.test(model)) {
      throw new Error('尺寸不受支持：自定义宽高须为 16 的倍数，最长边 ≤3840，比例 ≤3:1，总像素 655360–8294400；旧模型仅支持预设尺寸。');
    }
  }
  const quality = input.quality || 'auto';
  const qualities = /^gpt-image-2\.[56]-/.test(model)
    ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
    : ['auto', 'low', 'medium', 'high'];
  if (!qualities.includes(quality)) throw new Error('当前模型不支持所选质量。');
  const outputFormat = input.outputFormat || 'png';
  const background = input.background || 'auto';
  if (!['png', 'jpeg', 'webp'].includes(outputFormat)) throw new Error('输出格式只支持 PNG、JPEG、WebP。');
  if (!['auto', 'opaque', 'transparent'].includes(background)) throw new Error('背景选项无效。');
  if (background === 'transparent' && outputFormat === 'jpeg') throw new Error('透明背景需要 PNG 或 WebP 格式。');
  if (background === 'transparent' && /^gpt-image-2/.test(model)) throw new Error('当前模型不支持透明背景，请选择自动或不透明。');
  const references = input.references || [];
  if (!Array.isArray(references) || references.length > 16 || references.some(id => typeof id !== 'string' || !/^(?:uploads|outputs)\/[a-zA-Z0-9._-]+$|^[a-zA-Z0-9._-]+$/.test(id))) {
    throw new Error('参考图无效或数量超过 16 张。');
  }
  let extra = input.extra ?? {};
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra || '{}'); } catch { throw new Error('高级参数必须是有效的 JSON 对象。'); }
  }
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new Error('高级参数必须是 JSON 对象。');
  if (Object.keys(extra).some(key => PROTECTED.has(key))) throw new Error('高级参数包含保留字段，请使用任务面板中的对应选项。');
  if (JSON.stringify(extra).length > 10000) throw new Error('高级参数过长。');
  if (extra.output_compression !== undefined && (!Number.isInteger(extra.output_compression) || extra.output_compression < 0 || extra.output_compression > 100)) {
    throw new Error('output_compression 必须是 0 到 100 的整数。');
  }
  return {
    title: String(input.title || '未命名任务').slice(0, 80),
    profileId: String(input.profileId || 'default'), model, prompt, size,
    quality, n, outputFormat, background, references, extra,
  };
}
