import React, { useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, KeyRound, LoaderCircle, Plus, Radio, RefreshCw, Save, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { api } from '../lib.js';
import { MAX_CONCURRENCY } from '../../shared/batch.mjs';

export default function Settings({ settings, onSaved, onClose, notify }) {
  const [form, setForm] = useState(() => ({ ...settings, profiles: settings.profiles.map(profile => ({ ...profile, apiKey: '', modelText: profile.models.join('\n') })) }));
  const [selected, setSelected] = useState(form.profiles[0].id);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [probe, setProbe] = useState({});
  const profile = form.profiles.find(item => item.id === selected) || form.profiles[0];
  const patch = values => setForm(value => ({ ...value, profiles: value.profiles.map(item => item.id === profile.id ? { ...item, ...values } : item) }));
  const save = async () => {
    const result = await api('/settings', { method: 'PUT', body: {
      concurrency: Number(form.concurrency),
      profiles: form.profiles.map(({ modelText, ...item }) => ({ ...item, models: modelText.split(/[\n,]/).map(value => value.trim()).filter(Boolean) })),
    } });
    onSaved(result);
    setForm({ ...result, profiles: result.profiles.map(item => ({ ...item, apiKey: '', modelText: item.models.join('\n') })) });
    return result;
  };
  const handleSave = async () => {
    setBusy('save');
    try { await save(); notify('连接配置已保存'); onClose(); }
    catch (error) { notify(error.message, 'error'); }
    finally { setBusy(''); }
  };
  const testConnection = async sync => {
    setBusy(sync ? 'sync' : 'test');
    try {
      await save();
      const result = await api(`/profiles/${profile.id}/${sync ? 'models' : 'test'}`, { method: 'POST', body: {} });
      setProbe(previous => ({ ...previous, [profile.id]: { ok: true, text: `连接成功 · ${result.endpoint}` } }));
      if (sync) {
        onSaved(result.settings);
        setForm({
          ...result.settings,
          profiles: result.settings.profiles.map(item => ({ ...item, apiKey: '', modelText: item.models.join('\n') })),
        });
        notify(result.models.length ? `已同步 ${result.models.length} 个模型` : '接口返回空模型列表，已清空此连接的可选模型。');
      } else notify('连接成功');
    } catch (error) {
      setProbe(previous => ({ ...previous, [profile.id]: { ok: false, text: error.message } }));
      notify(error.message, 'error');
    } finally { setBusy(''); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-head"><div className="modal-title"><SlidersHorizontal size={20} /><h2 id="settings-title">API 连接与设置</h2></div><button className="icon-button" title="关闭设置" aria-label="关闭设置" onClick={onClose} disabled={Boolean(busy)}><X size={20} /></button></div>
        <div className="settings-content" inert={busy ? true : undefined}>
          <aside className="profile-list">
            <span className="section-eyebrow">API CONNECTIONS</span>
            {form.profiles.map(item => <button key={item.id} className={`profile-tab ${profile.id === item.id ? 'active' : ''}`} onClick={() => { setSelected(item.id); setShowKey(false); }}><Radio size={16} /><span>{item.name}</span><i className={item.hasKey && !item.clearKey ? 'online' : ''} /></button>)}
            <button className="add-profile" onClick={() => {
              const id = crypto.randomUUID();
              setForm(value => ({ ...value, profiles: [...value.profiles, { id, name: '新 API 连接', baseUrl: 'https://api.openai.com/v1', apiKey: '', hasKey: false, models: [], modelText: '', timeout: 600 }] }));
              setSelected(id);
              setShowKey(false);
            }} disabled={Boolean(busy) || form.profiles.length >= 20}><Plus size={15} />添加连接</button>
            <div className="concurrency-setting"><label htmlFor="global-concurrency">最大并行任务</label><div className="concurrency-display"><input aria-label="最大并行任务精确值" type="number" min="1" max={MAX_CONCURRENCY} value={form.concurrency} onChange={event => setForm(value => ({ ...value, concurrency: Number(event.target.value) }))} /><span>个任务</span></div><input id="global-concurrency" type="range" min="1" max={MAX_CONCURRENCY} value={form.concurrency} onChange={event => setForm(value => ({ ...value, concurrency: Number(event.target.value) }))} /><div className="range-labels"><span>1</span><span>{MAX_CONCURRENCY}</span></div></div>
          </aside>
          <div className="profile-form">
            <div className="profile-form-head"><h3>{profile.name}</h3>{form.profiles.length > 1 && <button className="icon-button danger-text" title="删除此连接" aria-label="删除此连接" disabled={Boolean(busy)} onClick={() => { setForm(value => ({ ...value, profiles: value.profiles.filter(item => item.id !== profile.id) })); setSelected(form.profiles.find(item => item.id !== profile.id).id); }}><Trash2 size={16} /></button>}</div>
            <label className="field">连接名称<input value={profile.name} maxLength={60} onChange={event => patch({ name: event.target.value })} /></label>
            <label className="field">API 地址<input value={profile.baseUrl} spellCheck="false" placeholder="https://api.openai.com/v1" onChange={event => patch({ baseUrl: event.target.value })} /></label>
            <label className="field">API Key<div className="key-input"><KeyRound size={16} /><input type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck="false" value={profile.apiKey} placeholder={profile.clearKey ? '密钥将在保存后移除' : profile.hasKey ? '已保存，留空以保留现有密钥' : 'sk-…'} onChange={event => patch({ apiKey: event.target.value, clearKey: false })} /><button className="icon-button" title={showKey ? '隐藏密钥' : '显示新输入的密钥'} aria-label="切换密钥可见性" onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            {profile.hasKey && <label className="checkbox-label"><input type="checkbox" checked={Boolean(profile.clearKey)} onChange={event => patch({ clearKey: event.target.checked, apiKey: '' })} />移除已保存的密钥</label>}
            <div className="field-top models-label"><label htmlFor="model-list">可选模型</label><button className="text-button" onClick={() => testConnection(true)} disabled={Boolean(busy)}>{busy === 'sync' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}获取模型</button></div>
            <textarea id="model-list" className="model-list-input" value={profile.modelText} spellCheck="false" onChange={event => patch({ modelText: event.target.value })} placeholder="每行一个模型 ID" />
            <label className="field timeout-field">请求超时（秒）<input type="number" min="30" max="1800" step="30" value={profile.timeout} onChange={event => patch({ timeout: Number(event.target.value) })} /></label>
            {probe[profile.id] && <div role="status" className={`probe-status ${probe[profile.id].ok ? 'success' : 'error'}`}>{probe[profile.id].ok && <Check size={15} />}{probe[profile.id].text}</div>}
          </div>
        </div>
        <div className="modal-footer"><button className="button secondary" disabled={Boolean(busy)} onClick={() => testConnection(false)}>{busy === 'test' ? <LoaderCircle size={15} className="spin" /> : <Radio size={15} />}测试连接</button><button className="button primary" disabled={Boolean(busy)} onClick={handleSave}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存配置</button></div>
      </section>
    </div>
  );
}
