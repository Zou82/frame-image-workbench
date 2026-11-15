import React, { useState } from 'react';
import { Check, Save, Settings2, X } from 'lucide-react';
import { applyBulkSettings } from '../../shared/batch.mjs';
import { modelChange } from '../lib.js';

const FIELDS = [
  ['profileId', 'API 连接'], ['model', '模型'], ['size', '尺寸 / 比例'], ['quality', '画质'],
  ['n', '每任务张数'], ['outputFormat', '输出格式'], ['background', '背景'], ['extra', '额外参数 JSON'],
];
const SIZES = [['1024x1024', '1:1 · 1024 × 1024'], ['1536x1024', '3:2 · 1536 × 1024'], ['1024x1536', '2:3 · 1024 × 1536'], ['1536x864', '16:9 · 1536 × 864'], ['864x1536', '9:16 · 864 × 1536'], ['auto', '自动']];
const QUALITY = [['auto', '自动'], ['low', '标准 · Low'], ['medium', '精细 · Medium'], ['high', '高清 · High'], ['xhigh', '超清 · XHigh'], ['max', '极致 · Max']];

export default function BatchSettings({ settings, defaults, selectedCount, editableCount, onSaveDefaults, onApply, onClose, notify }) {
  const [values, setValues] = useState({ ...defaults });
  const [enabled, setEnabled] = useState(new Set(['model', 'size', 'quality']));
  const [scope, setScope] = useState(selectedCount ? 'selected' : 'all');
  const [errors, setErrors] = useState([]);
  const profile = settings.profiles.find(item => item.id === values.profileId);
  const patch = (key, value) => {
    setErrors([]);
    if (key === 'profileId') {
      const next = settings.profiles.find(item => item.id === value);
      setValues(current => ({ ...current, profileId: value, ...modelChange(current, next?.models[0] || '') }));
      setEnabled(current => new Set([...current, 'model']));
    } else if (key === 'model') setValues(current => ({ ...current, ...modelChange(current, value) }));
    else setValues(current => ({ ...current, [key]: value }));
  };
  const save = () => {
    const probe = { ...values, id: 'defaults', prompt: '校验默认设置', title: '默认设置', references: [] };
    const checked = applyBulkSettings([probe], values, settings);
    if (checked.errors.length) return setErrors(checked.errors);
    onSaveDefaults(values);
    notify('已保存新任务默认参数');
  };
  const apply = () => {
    const chosen = Object.fromEntries([...enabled].map(key => [key, values[key]]));
    const result = onApply(chosen, scope);
    setErrors(result.errors);
    if (!result.errors.length) onClose();
  };
  const control = key => {
    if (key === 'extra') return <textarea className="json-input" aria-label="统一额外参数" value={values.extra} spellCheck="false" onChange={event => patch(key, event.target.value)} />;
    if (key === 'n') return <input aria-label="统一每任务张数" type="number" min="1" max="10" value={values.n} onChange={event => patch(key, Number(event.target.value))} />;
    const options = key === 'profileId' ? settings.profiles.map(item => [item.id, item.name])
      : key === 'model' ? (profile?.models || []).map(model => [model, model])
      : key === 'size' ? [...SIZES, ...(!SIZES.some(([size]) => size === values.size) ? [[values.size, values.size]] : [])]
      : key === 'quality' ? QUALITY.filter(([value]) => !['xhigh', 'max'].includes(value) || /^gpt-image-2\.[56]-/.test(values.model))
      : key === 'outputFormat' ? [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']]
      : [['auto', '自动'], ['opaque', '不透明'], ...(!/^gpt-image-2/.test(values.model) ? [['transparent', '透明']] : [])];
    return <><select aria-label={`统一${FIELDS.find(([field]) => field === key)[1]}`} value={values[key]} onChange={event => patch(key, event.target.value)}>{key === 'model' && !options.length && <option value="">暂无可用模型</option>}{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{key === 'size' && <input aria-label="统一自定义尺寸" placeholder="自定义宽x高，如 1536x864" value={values.size} onChange={event => patch(key, event.target.value)} />}</>;
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal batch-settings" role="dialog" aria-modal="true" aria-labelledby="batch-settings-title">
      <div className="modal-head"><div className="modal-title"><Settings2 size={20} /><h2 id="batch-settings-title">统一参数</h2></div><button className="icon-button" title="关闭统一参数" aria-label="关闭统一参数" onClick={onClose}><X size={20} /></button></div>
      <div className="batch-dialog-body">
        <div className="batch-settings-fields">{FIELDS.map(([key, label]) => <div className="batch-parameter" key={key}><label className="batch-check"><input type="checkbox" aria-label={`批量修改${label}`} checked={enabled.has(key)} onChange={event => setEnabled(previous => { const next = new Set(previous); if (event.target.checked) next.add(key); else next.delete(key); return next; })} />{label}</label><div className="batch-control">{control(key)}</div></div>)}</div>
        {errors.length > 0 && <div className="validation-errors" role="alert"><ul>{errors.slice(0, 10).map((error, i) => <li key={i}>{error}</li>)}</ul></div>}
        <div className="bulk-scope"><span>应用范围</span><label className="batch-check"><input type="radio" name="bulk-scope" value="selected" checked={scope === 'selected'} disabled={!selectedCount} onChange={() => setScope('selected')} />已选 {selectedCount} 个</label><label className="batch-check"><input type="radio" name="bulk-scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />全部可编辑 {editableCount} 个</label></div>
      </div>
      <div className="modal-footer"><button className="button secondary defaults-save" onClick={save}><Save size={15} />保存为新任务默认值</button><button className="button primary" disabled={!enabled.size || (scope === 'all' ? !editableCount : !selectedCount)} onClick={apply}><Check size={15} />应用勾选参数</button></div>
    </section>
  </div>;
}

