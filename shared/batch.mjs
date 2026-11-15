import { validateTask } from './task-validation.mjs';

export const MAX_DRAFTS = 500;
export const MAX_IMPORT_TASKS = 500;
export const MAX_CONCURRENCY = 100;

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const PARAMETER_FIELDS = ['profileId', 'model', 'size', 'quality', 'n', 'outputFormat', 'background', 'extra'];
const PARAMETER_FIELD_SET = new Set(PARAMETER_FIELDS);
const TASK_FIELD_SET = new Set(['title', 'prompt', ...PARAMETER_FIELDS]);
const ROOT_FIELD_SET = new Set(['version', 'defaults', 'tasks']);
const STRING_FIELDS = new Set(['profileId', 'model', 'size', 'quality', 'outputFormat', 'background']);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function actualProfiles(settings) {
  return Array.isArray(settings?.profiles)
    ? settings.profiles.filter(isObject).map(profile => ({
      ...profile,
      id: typeof profile.id === 'string' ? profile.id : '',
      models: Array.isArray(profile.models)
        ? profile.models.filter(model => typeof model === 'string' && model.trim()).map(model => model.trim())
        : [],
    }))
    : [];
}

function parseExtra(value, fallback = {}) {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value || '{}');
    return isObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function stringifyExtra(value) {
  if (typeof value === 'string') {
    const parsed = parseExtra(value, null);
    return parsed ? value : '{}';
  }
  return JSON.stringify(isObject(value) ? value : {}, null, 2);
}

export function modelChange(values, model) {
  const patch = { model };
  if (/^gpt-image-1(?:[.-]|$)/.test(model) && !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(values.size)) {
    patch.size = '1024x1024';
  }
  if (/^gpt-image-2/.test(model) && values.background === 'transparent') patch.background = 'auto';
  if (!/^gpt-image-2\.[56]-/.test(model) && ['xhigh', 'max'].includes(values.quality)) patch.quality = 'high';
  return patch;
}

function normalizeInheritedModelFields(values, model, explicitFields) {
  const patch = modelChange(values, model);
  const next = { ...values, model };
  for (const field of ['size', 'quality', 'background']) {
    if (Object.hasOwn(patch, field) && !explicitFields.has(field)) next[field] = patch[field];
  }
  return next;
}

function fieldFromValidation(message) {
  if (/提示词/.test(message)) return 'prompt';
  if (/模型/.test(message) && !/质量|背景/.test(message)) return 'model';
  if (/数量/.test(message)) return 'n';
  if (/尺寸/.test(message)) return 'size';
  if (/质量/.test(message)) return 'quality';
  if (/输出格式/.test(message)) return 'outputFormat';
  if (/背景|透明/.test(message)) return 'background';
  if (/高级参数|output_compression|保留字段/.test(message)) return 'extra';
  return 'parameters';
}

function validateShape(value, allowedFields, location, { allowExtraString = false } = {}) {
  const errors = [];
  if (!isObject(value)) return [`${location}: 必须是 JSON 对象。`];
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) errors.push(`${location}.${field}: 不支持此字段。`);
  }
  for (const field of PARAMETER_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const fieldLocation = `${location}.${field}`;
    if (STRING_FIELDS.has(field) && typeof value[field] !== 'string') {
      errors.push(`${fieldLocation}: 必须是字符串。`);
    } else if (STRING_FIELDS.has(field) && !value[field].trim()) {
      errors.push(`${fieldLocation}: 不能为空字符串。`);
    } else if (field === 'n' && !Number.isInteger(value.n)) {
      errors.push(`${fieldLocation}: 必须是整数。`);
    } else if (field === 'extra') {
      if (!(isObject(value.extra) || (allowExtraString && typeof value.extra === 'string'))) {
        errors.push(`${fieldLocation}: 必须是 JSON 对象${allowExtraString ? '或对象 JSON 字符串' : ''}。`);
      } else if (typeof value.extra === 'string' && !isObject(parseExtra(value.extra, null))) {
        errors.push(`${fieldLocation}: 必须是有效的 JSON 对象字符串。`);
      }
    }
  }
  return errors;
}

function locateValidationError(location, error) {
  return `${location}.${fieldFromValidation(error.message)}: ${error.message}`;
}

function resolveParameters(settings, uiDefaults, jsonDefaults, task, location) {
  const profiles = actualProfiles(settings);
  const profileId = task.profileId ?? jsonDefaults.profileId ?? uiDefaults.profileId;
  const profile = profiles.find(item => item.id === profileId);
  const errors = [];
  if (!profile) errors.push(`${location}.profileId: 未找到 API 连接 "${profileId}"。`);

  let model;
  if (Object.hasOwn(task, 'model')) model = task.model;
  else if (Object.hasOwn(jsonDefaults, 'model')) model = jsonDefaults.model;
  else if (Object.hasOwn(task, 'profileId') || Object.hasOwn(jsonDefaults, 'profileId')) model = profile?.models[0] || '';
  else model = uiDefaults.model;

  if (profile && !profile.models.includes(model)) {
    errors.push(`${location}.model: 模型 "${model}" 不属于连接 "${profile.id}" 的实际可用模型列表。`);
  }

  const explicitFields = new Set([...Object.keys(jsonDefaults), ...Object.keys(task)]);
  let parameters = {
    ...uiDefaults,
    ...jsonDefaults,
    ...task,
    profileId,
    model,
    extra: task.extra ?? jsonDefaults.extra ?? parseExtra(uiDefaults.extra),
  };
  if (model !== uiDefaults.model) parameters = normalizeInheritedModelFields(parameters, model, explicitFields);
  return { parameters, errors };
}

export function createBatchDefaults(settings, saved = {}) {
  const profiles = actualProfiles(settings);
  const profile = profiles.find(item => item.id === saved?.profileId) || profiles[0];
  const model = profile?.models.includes(saved?.model) ? saved.model : profile?.models[0] || '';
  const values = {
    profileId: profile?.id || '',
    model,
    size: typeof saved?.size === 'string' && saved.size ? saved.size : '1024x1024',
    quality: typeof saved?.quality === 'string' && saved.quality ? saved.quality : 'auto',
    n: Number.isInteger(saved?.n) && saved.n >= 1 && saved.n <= 10 ? saved.n : 1,
    outputFormat: ['png', 'jpeg', 'webp'].includes(saved?.outputFormat) ? saved.outputFormat : 'png',
    background: ['auto', 'opaque', 'transparent'].includes(saved?.background) ? saved.background : 'auto',
    extra: stringifyExtra(saved?.extra ?? {}),
  };
  return { ...values, ...modelChange(values, model), extra: values.extra };
}

export function parseBatchJson(text, settings, defaults) {
  try {
    const sourceText = typeof text === 'string' ? text : String(text ?? '');
    if (new TextEncoder().encode(sourceText).byteLength > MAX_IMPORT_BYTES) {
      return { tasks: [], errors: ['root: JSON 文本不能超过 20 MB。'] };
    }
    let root;
    try {
      root = JSON.parse(sourceText);
    } catch (error) {
      return { tasks: [], errors: [`root: JSON 格式无效（${error.message}）。`] };
    }
    if (!isObject(root)) return { tasks: [], errors: ['root: 顶层必须是 JSON 对象。'] };
    const errors = [];
    for (const field of Object.keys(root)) {
      if (!ROOT_FIELD_SET.has(field)) errors.push(`root.${field}: 不支持此字段。`);
    }
    if (root.version !== undefined && root.version !== 1) errors.push('root.version: 只支持版本 1。');
    const jsonDefaults = Object.hasOwn(root, 'defaults') ? root.defaults : {};
    errors.push(...validateShape(jsonDefaults, PARAMETER_FIELD_SET, 'defaults'));
    if (!Array.isArray(root.tasks)) {
      errors.push('root.tasks: 必须是任务数组。');
      return { tasks: [], errors };
    }
    if (root.tasks.length < 1 || root.tasks.length > MAX_IMPORT_TASKS) {
      errors.push(`root.tasks: 任务数量必须是 1 到 ${MAX_IMPORT_TASKS}。`);
    }
    if (!isObject(jsonDefaults)) return { tasks: [], errors };

    const uiDefaults = createBatchDefaults(settings, defaults);
    const candidates = [];
    root.tasks.forEach((entry, index) => {
      const location = `tasks[${index}]`;
      const task = typeof entry === 'string' ? { prompt: entry } : entry;
      const rowErrors = validateShape(task, TASK_FIELD_SET, location);
      if (isObject(task)) {
        if (Object.hasOwn(task, 'title') && typeof task.title !== 'string') rowErrors.push(`${location}.title: 必须是字符串。`);
        if (!Object.hasOwn(task, 'prompt') || typeof task.prompt !== 'string') rowErrors.push(`${location}.prompt: 必须是字符串。`);
        else if (!task.prompt.trim() || task.prompt.trim().length > 32000) rowErrors.push(`${location}.prompt: 不能为空，且不能超过 32000 个字符。`);

        const resolved = resolveParameters(settings, uiDefaults, jsonDefaults, task, location);
        rowErrors.push(...resolved.errors);
        try {
          const validated = validateTask({
            ...resolved.parameters,
            title: task.title,
            prompt: task.prompt,
            references: [],
          });
          candidates.push(validated);
        } catch (error) {
          rowErrors.push(locateValidationError(location, error));
        }
      }
      errors.push(...rowErrors);
    });
    return errors.length ? { tasks: [], errors } : { tasks: candidates, errors: [] };
  } catch (error) {
    return { tasks: [], errors: [`root: 无法读取批量 JSON（${error.message || '未知错误'}）。`] };
  }
}

export function applyBulkSettings(drafts, patch, settings, lockedIds = new Set()) {
  const original = drafts;
  const skipped = Array.isArray(drafts) ? drafts.filter(draft => lockedIds.has(draft.id)).length : 0;
  if (!Array.isArray(drafts)) return { drafts: original, updated: 0, skipped, errors: ['drafts: 必须是草稿数组。'] };
  const errors = validateShape(patch, PARAMETER_FIELD_SET, 'patch', { allowExtraString: true });
  if (errors.length) return { drafts: original, updated: 0, skipped, errors };
  const profiles = actualProfiles(settings);
  const next = [];
  let updated = 0;

  drafts.forEach((draft, index) => {
    if (lockedIds.has(draft.id)) {
      next.push(draft);
      return;
    }
    const location = `drafts[${index}]`;
    const profileId = Object.hasOwn(patch, 'profileId') ? patch.profileId : draft.profileId;
    const profile = profiles.find(item => item.id === profileId);
    if (!profile) errors.push(`${location}.profileId: 未找到 API 连接 "${profileId}"。`);
    let model = Object.hasOwn(patch, 'model') ? patch.model : draft.model;
    if (Object.hasOwn(patch, 'profileId') && patch.profileId !== draft.profileId && !Object.hasOwn(patch, 'model')) {
      model = profile?.models[0] || '';
    }
    if (profile && !profile.models.includes(model)) {
      errors.push(`${location}.model: 模型 "${model}" 不属于连接 "${profile.id}" 的实际可用模型列表。`);
    }

    const explicitFields = new Set(Object.keys(patch));
    let candidate = { ...draft, ...patch, profileId, model };
    if (model !== draft.model) candidate = normalizeInheritedModelFields(candidate, model, explicitFields);
    const extraObject = Object.hasOwn(patch, 'extra') ? parseExtra(patch.extra, null) : parseExtra(draft.extra, null);
    if (!extraObject) {
      errors.push(`${location}.extra: 高级参数必须是有效的 JSON 对象。`);
      next.push(draft);
      return;
    }
    try {
      const validated = validateTask({
        ...candidate,
        prompt: '批量编辑参数',
        references: [],
        extra: extraObject,
      });
      const extra = Object.hasOwn(patch, 'extra')
        ? (typeof patch.extra === 'string' ? patch.extra : JSON.stringify(patch.extra, null, 2))
        : draft.extra;
      const result = {
        ...draft,
        profileId: validated.profileId,
        model: validated.model,
        size: validated.size,
        quality: validated.quality,
        n: validated.n,
        outputFormat: validated.outputFormat,
        background: validated.background,
        extra,
      };
      const changed = PARAMETER_FIELDS.some(field => result[field] !== draft[field]);
      next.push(changed ? result : draft);
      if (changed) updated++;
    } catch (error) {
      errors.push(locateValidationError(location, error));
      next.push(draft);
    }
  });

  return errors.length
    ? { drafts: original, updated: 0, skipped, errors }
    : { drafts: next, updated, skipped, errors: [] };
}

function templateDefaults(defaults) {
  const result = {};
  for (const field of PARAMETER_FIELDS) {
    if (!Object.hasOwn(defaults || {}, field)) continue;
    result[field] = field === 'extra' ? parseExtra(defaults.extra) : defaults[field];
  }
  return result;
}

export function getBatchTemplate(defaults) {
  return JSON.stringify({
    version: 1,
    defaults: templateDefaults(defaults),
    tasks: [
      {
        title: '晨光中的玻璃花瓶',
        prompt: '一只透明玻璃花瓶放在浅色木桌上，清晨自然光从侧面照入，真实摄影质感，画面中不要出现文字。',
      },
      {
        title: '雨夜城市人像',
        prompt: '雨夜城市街头的人像摄影，霓虹灯在湿润路面形成倒影，人物神态自然，电影感光影，细节清晰。',
        size: '1024x1536',
      },
    ],
  }, null, 2);
}

export function buildAiPrompt(settings, defaults) {
  const profiles = actualProfiles(settings);
  const modelLines = profiles.map(profile =>
    `- profileId "${profile.id}"：${profile.models.length ? profile.models.map(model => `"${model}"`).join('、') : '暂无可用模型'}`);
  const example = getBatchTemplate(defaults);
  return [
    '请把我随后提供的想法整理成 FRAME 图像工作台可导入的批量任务 JSON。',
    '只输出 JSON，不要使用 Markdown 代码围栏，也不要添加解释。',
    '顶层格式必须是 {"version":1,"defaults":{...},"tasks":[...]}。',
    `defaults 只允许这些字段：${PARAMETER_FIELDS.join('、')}。`,
    `tasks 中每项允许 title、prompt，以及这些覆盖字段：${PARAMETER_FIELDS.join('、')}；也可以直接使用提示词字符串。`,
    '字段优先级：任务覆盖 > JSON 默认 > 界面默认。',
    `任务数必须为 1 到 ${MAX_IMPORT_TASKS}，每个 prompt 必须是非空字符串且不超过 32000 个字符，n 必须是 1 到 10 的整数，extra 必须是 JSON 对象。`,
    'size 可用预设为 auto、1024x1024、1536x1024、1024x1536。非 gpt-image-1 系列还可用自定义宽高：宽高均为 16 的倍数、最长边不超过 3840、比例不超过 3:1、总像素在 655360 到 8294400 之间；gpt-image-1 系列只能使用预设尺寸。',
    'quality 可用 auto、low、medium、high；只有模型 ID 匹配 gpt-image-2.5- 或 gpt-image-2.6- 前缀时才能使用 xhigh、max。',
    'outputFormat 只能是 png、jpeg、webp。background 只能是 auto、opaque、transparent；transparent 不能与 jpeg 同用，gpt-image-2 系列也不支持 transparent。',
    '只能使用下面各连接真实列出的模型 ID；切换 profileId 时，不得沿用其他连接的模型：',
    ...modelLines,
    '不要编造模型、API Key 等任何凭据，也不要生成参考图路径或本地文件路径。',
    '请严格仿照下面这个完整 JSON 示例，并保留每个任务的独立提示词：',
    example,
    '我接下来会在这段说明后追加原始提示词或创意清单。',
  ].join('\n');
}
