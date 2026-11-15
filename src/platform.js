export function createNativeClient(native, timeout = 120000) {
  const pending = new Map();
  const session = crypto.randomUUID();
  let sequence = 0;
  return {
    request(route, options = {}) {
      const id = `${session}-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('手机服务响应超时，请检查任务记录后再决定是否重新提交。'));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        try {
          native.request(JSON.stringify({ id, route, method: options.method || 'GET', body: options.body ?? {} }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    resolve(response) {
      const item = pending.get(response.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(response.id);
      if (response.ok) item.resolve(response.data);
      else item.reject(new Error(response.error || '手机服务请求失败。'));
    },
  };
}

let uploadLane = Promise.resolve();
export function uploadNativeFiles(files, request) {
  const operation = uploadLane.then(() => transferFiles(files, request));
  uploadLane = operation.catch(() => {});
  return operation;
}

async function transferFiles(files, request) {
  const uploaded = [];
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) throw new Error('单张参考图不能超过 20 MB。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    const response = await request('/uploads', {
      method: 'POST',
      body: { files: [{ name: file.name, type: file.type, data: btoa(binary) }] },
    });
    uploaded.push(...response.files);
  }
  return { files: uploaded };
}

export const isAndroid = typeof window !== 'undefined' && Boolean(window.FrameNative?.request);
const client = isAndroid ? createNativeClient(window.FrameNative) : null;
if (client) {
  window.__frameNativeResolve = response => client.resolve(response);
  document.documentElement.classList.add('android-app');
}
export const nativeRequest = (route, options) => client.request(route, options);

export function saveText(name, text, type) {
  if (isAndroid) return nativeRequest('/export', { method: 'POST', body: { name, text, type } });
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Promise.resolve();
}

export function copyText(text) {
  return isAndroid ? nativeRequest('/clipboard', { method: 'POST', body: { text } }) : navigator.clipboard.writeText(text);
}
