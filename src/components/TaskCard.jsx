import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight, ChevronDown, Copy, Download, ImagePlus, Image as ImageIcon,
  LoaderCircle, Plus, ScanLine, Settings2, Sparkles, Square, Trash2, X,
  RectangleHorizontal, RectangleVertical, CircleAlert, Check,
} from 'lucide-react';
import { api, STATUS, ACTIVE, elapsed, download, modelChange } from '../lib.js';

const PRESETS = [
  { value: '1024x1024', label: '1:1', Icon: Square },
  { value: '1536x1024', label: '3:2', Icon: RectangleHorizontal },
  { value: '1024x1536', label: '2:3', Icon: RectangleVertical },
  { value: 'auto', label: '自动', Icon: ScanLine },
];

export default function TaskCard({ draft, index, settings, job, onChange, onSubmit, onDuplicate, onRemove, onCancel, onPreview, onUploadState, notify, submitting, uploadingExternal = false }) {
  const [advanced, setAdvanced] = useState(false);
  const [localUploading, setUploading] = useState(false);
  const uploading = localUploading || uploadingExternal;
  const [dragging, setDragging] = useState(false);
  const [custom, setCustom] = useState(!PRESETS.some(item => item.value === draft.size));
  useEffect(() => { setCustom(!PRESETS.some(item => item.value === draft.size)); }, [draft.size]);
  const fileInput = useRef(null);
  const referencesRef = useRef(draft.references);
  referencesRef.current = draft.references;
  const locked = ACTIVE.has(job?.status) || submitting || uploading;
  const profile = settings.profiles.find(item => item.id === draft.profileId);
  const models = profile?.models || [];
  const validModel = models.includes(draft.model);
  const status = job?.status || 'draft';
  const set = (key, value) => onChange({ [key]: value });
  const setModel = value => onChange(modelChange(draft, value));
  const uploadFiles = async files => {
    if (!files.length || locked || uploading) return;
    if (referencesRef.current.length + files.length > 16) return notify('每个任务最多使用 16 张参考图片。', 'error');
    if (files.some(file => file.size > 20 * 1024 * 1024)) return notify('单张参考图不能超过 20 MB。', 'error');
    setUploading(true);
    onUploadState(true);
    const form = new FormData();
    files.forEach(file => form.append('images', file));
    try {
      const { files: uploaded } = await api('/uploads', { method: 'POST', body: form });
      set('references', [...referencesRef.current, ...uploaded]);
    } catch (error) { notify(error.message, 'error'); }
    finally { setUploading(false); onUploadState(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const results = job?.results || [];
  return (
    <article className={`task-card ${status === 'running' ? 'is-running' : ''}`}>
      <div className="task-head">
        <span className="task-number">{String(index + 1).padStart(2, '0')}</span>
        <input className="task-title" aria-label={`任务 ${index + 1} 名称`} value={draft.title} disabled={locked} maxLength={80} onChange={event => set('title', event.target.value)} />
        <span className={`status status-${status}`}><i />{STATUS[status]}</span>
        <button className="icon-button small" title="复制任务" aria-label={`复制任务 ${index + 1}`} onClick={onDuplicate}><Copy size={15} /></button>
        <button className="icon-button small" title="移除任务窗口" aria-label={`移除任务 ${index + 1}`} onClick={onRemove} disabled={locked || uploading}><X size={17} /></button>
      </div>
      <div className="task-body">
        <div className="field-top"><label htmlFor={`prompt-${draft.id}`}>提示词</label><span>{draft.prompt.length} / 32000</span></div>
        <textarea id={`prompt-${draft.id}`} className="prompt-input" placeholder="描述你想看见的画面，写下主体、场景、风格和光线…" value={draft.prompt} disabled={locked} maxLength={32000} onChange={event => set('prompt', event.target.value)} />
        <div className="field-top reference-label"><label>参考图片</label><span>{draft.references.length} / 16</span></div>
        <div className={`reference-drop ${dragging ? 'dragging' : ''}`}
          onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); uploadFiles([...event.dataTransfer.files]); }}>
          {draft.references.map(ref => (
            <div className="reference-thumb" key={ref.id}>
              <button className="reference-preview" title={ref.name || '预览参考图'} onClick={() => onPreview({ ...ref, prompt: '' })}><img src={ref.url} alt={ref.name || '参考图'} /></button>
              {!locked && <button className="remove-reference" title="移除参考图" aria-label="移除参考图" onClick={() => set('references', draft.references.filter(item => item.id !== ref.id))}><X size={11} /></button>}
            </div>
          ))}
          <button className={`upload-button ${draft.references.length ? 'compact' : ''}`} title="添加参考图片" aria-label={draft.references.length ? '添加参考图片' : undefined} disabled={locked || uploading || draft.references.length >= 16} onClick={() => fileInput.current?.click()}>
            {uploading ? <LoaderCircle size={19} className="spin" /> : <ImagePlus size={19} />}
            {!draft.references.length && <span>{uploading ? '正在上传…' : '添加图片'}<small>或拖放到这里</small></span>}
          </button>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label={`任务 ${index + 1} 参考图片`} onChange={event => uploadFiles([...event.target.files])} />
        </div>
        <div className="field-row model-row">
          <label className="field grow">模型
            <div className="select-wrap model-select"><Sparkles size={15} /><select aria-label={`任务 ${index + 1} 模型`} value={validModel ? draft.model : ''} disabled={locked || !models.length} onChange={event => setModel(event.target.value)}>{!validModel && <option value="" disabled>{models.length ? '请选择可用模型' : '暂无可用模型'}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select><ChevronDown size={14} /></div>
          </label>
          {(settings.profiles.length > 1 || !profile) && <label className="field connection-field">API 连接
            <div className="select-wrap"><select aria-label={`任务 ${index + 1} API 连接`} value={draft.profileId} disabled={locked} onChange={event => {
              const next = settings.profiles.find(item => item.id === event.target.value);
              onChange({ profileId: next.id, ...modelChange(draft, next.models[0] || '') });
            }}>{!profile && <option value={draft.profileId} disabled>连接已移除</option>}{settings.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></div>
          </label>}
        </div>
        <div className="field-top"><label>画面比例</label><button className={`text-button ${custom ? 'selected-text' : ''}`} disabled={locked} onClick={() => {
          if (custom) { setCustom(false); set('size', '1024x1024'); }
          else { setCustom(true); set('size', '1536x864'); }
        }}>自定义</button></div>
        {custom ? <div className="dimension-inputs">
          <input aria-label={`任务 ${index + 1} 宽度`} type="number" min="16" max="3840" step="16" value={draft.size.split('x')[0] || ''} disabled={locked} onChange={event => set('size', `${event.target.value}x${draft.size.split('x')[1] || '1024'}`)} />
          <X size={13} /><input aria-label={`任务 ${index + 1} 高度`} type="number" min="16" max="3840" step="16" value={draft.size.split('x')[1] || ''} disabled={locked} onChange={event => set('size', `${draft.size.split('x')[0] || '1024'}x${event.target.value}`)} /><span>px</span>
        </div> : <div className="ratio-control">{PRESETS.map(({ value, label, Icon }) => (
          <button key={value} title={value} className={draft.size === value ? 'active' : ''} disabled={locked} onClick={() => set('size', value)}><Icon size={17} /><span>{label}</span></button>
        ))}</div>}
        <div className="field-row quality-row">
          <label className="field grow">画质
            <div className="select-wrap"><select value={draft.quality} aria-label={`任务 ${index + 1} 画质`} disabled={locked} onChange={event => set('quality', event.target.value)}>
              <option value="auto">自动</option><option value="low">标准 · Low</option><option value="medium">精细 · Medium</option><option value="high">高清 · High</option>
              {/^gpt-image-2\.[56]-/.test(draft.model) && <><option value="xhigh">超清 · XHigh</option><option value="max">极致 · Max</option></>}
            </select><ChevronDown size={14} /></div>
          </label>
          <div className="field count-field"><label htmlFor={`count-${draft.id}`}>生成数量</label><div className="stepper"><button title="减少数量" aria-label={`任务 ${index + 1} 减少数量`} disabled={locked || draft.n <= 1} onClick={() => set('n', draft.n - 1)}>−</button><input id={`count-${draft.id}`} aria-label={`任务 ${index + 1} 生成数量`} type="number" min="1" max="10" value={draft.n} disabled={locked} onChange={event => set('n', Math.max(1, Math.min(10, Number(event.target.value) || 1)))} /><button title="增加数量" aria-label={`任务 ${index + 1} 增加数量`} disabled={locked || draft.n >= 10} onClick={() => set('n', draft.n + 1)}><Plus size={14} /></button></div></div>
        </div>
        <button className="advanced-toggle" onClick={() => setAdvanced(value => !value)} aria-expanded={advanced}><Settings2 size={14} />高级设置<ChevronDown size={13} className={advanced ? 'rotate' : ''} /><span>{draft.outputFormat.toUpperCase()} · {draft.size === 'auto' ? '自动尺寸' : draft.size.replace('x', ' × ')}</span></button>
        {advanced && <div className="advanced-fields">
          <div className="field-row">
            <label className="field grow">输出格式<div className="select-wrap"><select value={draft.outputFormat} disabled={locked} onChange={event => onChange({ outputFormat: event.target.value, ...(event.target.value === 'jpeg' && draft.background === 'transparent' ? { background: 'auto' } : {}) })}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select><ChevronDown size={13} /></div></label>
            <label className="field grow">背景<div className="select-wrap"><select value={draft.background} disabled={locked} onChange={event => onChange({ background: event.target.value, ...(event.target.value === 'transparent' && draft.outputFormat === 'jpeg' ? { outputFormat: 'png' } : {}) })}><option value="auto">自动</option><option value="opaque">不透明</option>{!/^gpt-image-2/.test(draft.model) && <option value="transparent">透明</option>}</select><ChevronDown size={13} /></div></label>
          </div>
          <label className="field">额外参数（JSON）<textarea className="json-input" spellCheck="false" value={draft.extra} disabled={locked} onChange={event => set('extra', event.target.value)} placeholder={'{\n  "input_fidelity": "high"\n}'} /></label>
        </div>}
        {job?.error && <div className="task-error"><CircleAlert size={15} /><span>{job.error}</span></div>}
        <div className={`result-area ${results.length ? 'has-results' : ''} ${status === 'running' ? 'rendering' : ''}`}>
          {results.length ? <div className={`result-grid result-count-${results.length}`}>{results.map(result => <button className="result-thumb" key={result.id} title="预览图片" onClick={() => onPreview({ ...result, prompt: job.prompt })}><img src={result.url} alt={job.prompt} /><span><ArrowUpRight size={17} /></span></button>)}</div> : <div className="result-placeholder">
            {status === 'running' ? <LoaderCircle size={25} className="spin" /> : status === 'queued' ? <LoaderCircle size={24} /> : <ImageIcon size={26} strokeWidth={1.3} />}
            <span>{status === 'running' ? '正在生成画面' : status === 'queued' ? '等待可用的生成位置' : status === 'failed' ? '调整参数后再次生成' : '画面，即将在这里发生'}</span>
            {ACTIVE.has(status) && <small>{elapsed(job.startedAt || job.createdAt)}</small>}
          </div>}
        </div>
      </div>
      <div className="task-footer">
        <span className="task-meta">{results.length ? <><Check size={13} />{results.length} 张 · {elapsed(job.startedAt, job.finishedAt)}</> : <><span className={`connection-dot ${profile?.hasKey ? 'online' : ''}`} />{profile?.name || '连接已移除'}</>}</span>
        {results.length > 0 && <button className="icon-button" title="下载本次全部图片" aria-label="下载本次全部图片" onClick={() => results.forEach(download)}><Download size={16} /></button>}
        {ACTIVE.has(status) ? <button className="button cancel-button" onClick={onCancel}><Square size={13} />取消任务</button>
          : <button className="button primary generate-button" onClick={onSubmit} disabled={submitting || uploading || !draft.prompt.trim() || !validModel}>{submitting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{submitting ? '提交中' : results.length ? '再次生成' : '生成图片'}<span>{draft.n}</span></button>}
      </div>
    </article>
  );
}
