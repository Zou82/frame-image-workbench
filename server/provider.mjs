export { validateTask } from '../shared/task-validation.mjs';

export function redact(message, key) {
  const clean = String(message).replace(/sk-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]');
  return key ? clean.split(key).join('[密钥已隐藏]') : clean;
}

export function validateApiKey(value) {
  const key = String(value || '');
  if (key.length > 2000 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效。');
  if (/^https?:\/\//i.test(key.trim())) {
    throw new Error('API Key 中填写的是网址。请将网址填入 API 地址，并从该服务的“API 密钥”页面复制调用密钥到 API Key。');
  }
}

export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || 'https://api.openai.com/v1').trim()); } catch { throw new Error('API 地址无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址应为不含用户名、查询参数的 HTTP(S) 地址。');
  }
  if (url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

export async function requestImages(task, connection, { signal, readReference, fetchImpl = fetch } = {}) {
  validateApiKey(connection.apiKey);
  const timeout = AbortSignal.timeout((connection.timeout || 600) * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const body = {
    ...task.extra, model: task.model, prompt: task.prompt, n: task.n,
    size: task.size, quality: task.quality, output_format: task.outputFormat,
    background: task.background,
  };
  const headers = { Authorization: `Bearer ${connection.apiKey}` };
  let payload;
  const editing = task.references.length > 0;
  if (editing) {
    payload = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) payload.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const id of task.references) {
      const reference = await readReference(id);
      payload.append(task.references.length > 1 ? 'image[]' : 'image', new Blob([reference.buffer], { type: reference.mime }), reference.name);
    }
  } else {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  try {
    const response = await fetchImpl(`${normalizeBaseUrl(connection.baseUrl)}/images/${editing ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body: payload, signal: combined, redirect: 'error',
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`API 返回了非 JSON 响应（HTTP ${response.status}），请检查接口地址。`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}：${data.error?.message || data.message || response.statusText}`);
    if (!Array.isArray(data.data) || !data.data.length || data.data.some(item => !item.b64_json && !item.url)) {
      throw new Error('API 没有返回有效图片，请确认模型支持 Images API。');
    }
    return data.data;
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error('生成请求超时，请在连接设置中增加超时时间后手动重试。');
    throw new Error(redact(error.message, connection.apiKey));
  }
}
