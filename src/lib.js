import { modelChange } from '../shared/batch.mjs';
import { isAndroid, nativeRequest, uploadNativeFiles } from './platform.js';
import { validateTask } from '../shared/task-validation.mjs';
export { modelChange } from '../shared/batch.mjs';

export const STATUS = {
  draft: '草稿', queued: '排队中', running: '生成中', completed: '已完成',
  failed: '生成失败', cancelled: '已取消', interrupted: '已中断',
};
export const ACTIVE = new Set(['queued', 'running']);
export const INSPIRATIONS = [
  {
    id: 'product', name: '日常，另一种视角', category: '产品摄影', image: '/assets/product.jpg',
    prompt: '一张极简护肤品牌的产品摄影。一只磨砂玻璃精华瓶，搭配柔和的自然光与细腻的投影，浅灰背景，干净的构图，真实的玻璃材质和商业静物摄影质感。画面不出现文字。',
  },
  {
    id: 'nature', name: '留一点绿色', category: '自然光影', image: '/assets/nature.jpg',
    prompt: '茂盛的绿色植物叶片，午后的阳光穿过叶缘，清晰的叶脉，柔和的明暗层次，安静而充满生机的自然摄影，细节真实，电影感色彩。',
  },
  {
    id: 'architecture', name: '空间的秩序', category: '建筑空间', image: '/assets/architecture.jpg',
    prompt: '一张现代建筑的几何摄影，纯净的混凝土立面与重复的线条，明亮的天空，精确的透视，日光下有力的几何阴影，安静、克制、极简的建筑杂志摄影。',
  },
];

export async function api(route, options = {}) {
  if (isAndroid) {
    if (route === '/uploads' && options.body instanceof FormData) {
      return uploadNativeFiles(options.body.getAll('images'), nativeRequest);
    }
    if (route === '/jobs' && options.method === 'POST') {
      options = { ...options, body: validateTask(options.body) };
    }
    return nativeRequest(route, options);
  }
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api${route}`, {
    ...options,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    body: options.body === undefined || isForm ? options.body : JSON.stringify(options.body),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务响应异常，请检查程序是否仍在运行。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

export function makeDraft(settings, values = {}) {
  const profile = settings?.profiles?.find(item => item.id === values.profileId) || settings?.profiles?.[0];
  const draft = {
    id: crypto.randomUUID(), title: '未命名任务', prompt: '',
    profileId: profile?.id || 'default', size: '1024x1024', quality: 'auto', n: 1,
    outputFormat: 'png', background: 'auto', references: [], extra: '{}',
    ...values,
    model: profile?.models.includes(values.model) ? values.model : profile?.models[0] || '',
    profileId: profile?.id || 'default', jobId: null,
  };
  return { ...draft, ...modelChange(draft, draft.model) };
}

export function reconcileDraftModels(settings, drafts, lockedIds = new Set()) {
  let changed = false;
  const next = drafts.map(draft => {
    if (lockedIds.has(draft.id)) return draft;
    const profile = settings.profiles.find(item => item.id === draft.profileId);
    if (profile?.models.includes(draft.model)) return draft;
    const model = profile?.models[0] || '';
    if (draft.model === model) return draft;
    changed = true;
    return { ...draft, ...modelChange(draft, model) };
  });
  return changed ? next : drafts;
}

export function fromJob(settings, job) {
  return makeDraft(settings, {
    title: job.title, prompt: job.prompt, profileId: job.profileId,
    model: job.model, size: job.size, quality: job.quality, n: job.n,
    outputFormat: job.outputFormat, background: job.background,
    references: job.references.map(id => ({ id, url: `/media/${id}`, name: '参考图片' })),
    extra: JSON.stringify(job.extra || {}, null, 2),
  });
}

export function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function elapsed(start, end) {
  if (!start) return '';
  const seconds = Math.max(0, Math.floor(((end ? new Date(end) : new Date()) - new Date(start)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function download(result) {
  if (isAndroid) {
    nativeRequest('/export', {
      method: 'POST', body: { name: `frame-${result.id.split('/').pop()}`, mediaId: result.id },
    }).catch(error => alert(error.message));
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = result.url;
  anchor.download = `frame-${result.id.split('/').pop()}`;
  anchor.click();
}
