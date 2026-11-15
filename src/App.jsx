import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Boxes, Check, ChevronRight,
  CircleAlert, Download, ExternalLink, ImagePlus, Images, LayoutGrid, LoaderCircle,
  Menu, PanelRightClose, PanelRightOpen, Plus, Radio, Settings2, Sparkles, X,
} from 'lucide-react';
import Workbench from './components/Workbench.jsx';
import Settings from './components/Settings.jsx';
import Gallery from './components/Gallery.jsx';
import { api, makeDraft, fromJob, reconcileDraftModels, INSPIRATIONS, ACTIVE, download } from './lib.js';
import { applyBulkSettings, createBatchDefaults, MAX_DRAFTS } from '../shared/batch.mjs';

const DRAFT_KEY = 'frame-workbench-drafts-v1';
const DEFAULTS_KEY = 'frame-workbench-defaults-v1';
const readDefaults = () => {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY)) || {}; } catch { return {}; }
};
const initialDrafts = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (Array.isArray(saved) && saved.length && saved.length <= MAX_DRAFTS) return saved;
  } catch {}
  return [makeDraft(null, { title: '新的创作' }), makeDraft(null, { title: '另一个想法' })];
};

export default function App() {
  const [settings, setSettings] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [drafts, setDrafts] = useState(initialDrafts);
  const [view, setView] = useState('workbench');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [offline, setOffline] = useState('');
  const [rail, setRail] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [submitting, setSubmitting] = useState(new Set());
  const [uploading, setUploading] = useState(new Set());
  const [savedDefaults, setSavedDefaults] = useState(readDefaults);
  const reservations = useRef(new Set());
  const defaults = createBatchDefaults(settings, savedDefaults);
  const [clock, setClock] = useState(0);
  const notify = useCallback((message, type = 'success') => {
    const id = crypto.randomUUID();
    setToasts(items => [...items.slice(-3), { id, message, type }]);
    setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 5500);
  }, []);
  const reloadJobs = useCallback(async () => {
    try {
      const data = await api('/jobs');
      setJobs(data.jobs);
      setJobsLoaded(true);
      setOffline(data.storageError || '');
    } catch (error) { setOffline(error.message); }
  }, []);
  useEffect(() => {
    api('/settings').then(setSettings).catch(error => setOffline(error.message));
    reloadJobs();
    const poll = setInterval(reloadJobs, 1800);
    const timer = setInterval(() => setClock(value => value + 1), 1000);
    return () => { clearInterval(poll); clearInterval(timer); };
  }, [reloadJobs]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); }
      catch { notify('浏览器草稿空间已满，请减少任务或提示词长度；本次草稿暂未保存。', 'error'); }
    }, 350);
    return () => clearTimeout(timer);
  }, [drafts]);
  useEffect(() => {
    const save = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch {} };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [drafts]);
  useEffect(() => {
    if (!settings || !jobsLoaded) return;
    setDrafts(items => reconcileDraftModels(settings, items, new Set(items
      .filter(draft => submitting.has(draft.id) || uploading.has(draft.id) || ACTIVE.has(jobs.find(job => job.id === draft.jobId)?.status))
      .map(draft => draft.id))));
  }, [settings, jobs, jobsLoaded, submitting, uploading]);
  useEffect(() => {
    const handler = event => {
      if (event.key === 'Escape') { setPreview(null); setMobileNav(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    document.body.style.overflow = document.querySelector('[aria-modal="true"]') ? 'hidden' : '';
  }, [settingsOpen, preview]);
  const updateDraft = (id, patch) => setDrafts(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  const addDraft = values => {
    if (drafts.length >= MAX_DRAFTS) return notify(`最多保留 ${MAX_DRAFTS} 个任务，请先移除部分任务。`, 'error');
    const draft = makeDraft(settings, { ...defaults, ...values });
    setDrafts(items => [...items, draft]);
    setView('workbench');
    return draft;
  };
  const jobFor = draft => jobs.find(job => job.id === draft.jobId);
  const lockedIds = new Set(drafts.filter(draft => submitting.has(draft.id) || uploading.has(draft.id) || ACTIVE.has(jobFor(draft)?.status)).map(draft => draft.id));
  const saveDefaults = values => {
    setSavedDefaults(values);
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(values)); } catch {}
  };
  const importTasks = (tasks, replaceEmpty) => {
    const retained = replaceEmpty ? drafts.filter(draft => draft.prompt.trim() || draft.references.length || draft.jobId || lockedIds.has(draft.id)) : drafts;
    if (retained.length + tasks.length > MAX_DRAFTS) { notify(`任务总数不能超过 ${MAX_DRAFTS}。`, 'error'); return false; }
    const added = tasks.map(task => makeDraft(settings, { ...task, extra: JSON.stringify(task.extra || {}, null, 2) }));
    setDrafts([...retained, ...added]);
    notify(`已导入 ${added.length} 个任务草稿`);
    return true;
  };
  const bulkApply = (patch, selected) => {
    const targets = selected ? drafts.filter(draft => selected.has(draft.id)) : drafts;
    const result = applyBulkSettings(targets, patch, settings, lockedIds);
    if (!result.errors.length) {
      const updated = new Map(result.drafts.map(draft => [draft.id, draft]));
      setDrafts(items => items.map(draft => updated.get(draft.id) || draft));
      notify(`已修改 ${result.updated} 个任务${result.skipped ? `，跳过 ${result.skipped} 个处理中任务` : ''}`);
    }
    return result;
  };
  const removeTasks = ids => {
    setDrafts(items => {
      const retained = items.filter(draft => !ids.includes(draft.id) || lockedIds.has(draft.id));
      return retained.length ? retained : [makeDraft(settings, { ...defaults, title: '新的创作' })];
    });
  };
  const uploadState = (id, active) => setUploading(previous => { const next = new Set(previous); if (active) next.add(id); else next.delete(id); return next; });
  const submit = async (draft, reserved = false) => {
    if ((!reserved && reservations.current.has(draft.id)) || uploading.has(draft.id) || ACTIVE.has(jobFor(draft)?.status)) return;
    const profile = settings.profiles.find(item => item.id === draft.profileId);
    if (!profile?.hasKey) {
      setSettingsOpen(true);
      notify('请先配置并保存此任务使用的 API Key。', 'error');
      return;
    }
    if (!profile.models.includes(draft.model)) {
      setSettingsOpen(true);
      notify('请先获取此连接的模型列表并选择可用模型。', 'error');
      return;
    }
    reservations.current.add(draft.id);
    setSubmitting(previous => new Set(previous).add(draft.id));
    try {
      const job = await api('/jobs', {
        method: 'POST',
        body: { ...draft, references: draft.references.map(ref => ref.id) },
      });
      updateDraft(draft.id, { jobId: job.id });
      setJobs(items => [job, ...items.filter(item => item.id !== job.id)]);
    } catch (error) { notify(error.message, 'error'); }
    finally { reservations.current.delete(draft.id); setSubmitting(previous => { const next = new Set(previous); next.delete(draft.id); return next; }); }
  };
  const submitMany = async candidates => {
    if (uploading.size) return notify('请等待参考图上传完成。', 'error');
    const eligible = candidates.filter(draft => draft.prompt.trim()
      && settings.profiles.find(profile => profile.id === draft.profileId)?.models.includes(draft.model)
      && !ACTIVE.has(jobFor(draft)?.status) && !reservations.current.has(draft.id));
    if (!eligible.length) return notify('没有可提交的任务，请检查提示词和模型。', 'error');
    const missing = eligible.find(draft => !settings.profiles.find(profile => profile.id === draft.profileId)?.hasKey);
    if (missing) { setSettingsOpen(true); return notify('请先配置任务使用的 API 连接。', 'error'); }
    eligible.forEach(draft => reservations.current.add(draft.id));
    setSubmitting(previous => new Set([...previous, ...eligible.map(draft => draft.id)]));
    let next = 0;
    const worker = async () => { while (next < eligible.length) { const draft = eligible[next++]; await submit(draft, true); } };
    await Promise.all(Array.from({ length: Math.min(4, eligible.length) }, worker));
  };
  const cancel = async job => {
    try { await api(`/jobs/${job.id}/cancel`, { method: 'POST', body: {} }); await reloadJobs(); }
    catch (error) { notify(error.message, 'error'); }
  };
  const changeView = next => { setView(next); setMobileNav(false); };
  const reuse = job => {
    const draft = fromJob(settings, job);
    if (drafts.length >= MAX_DRAFTS) return notify('请先移除部分任务。', 'error');
    setDrafts(items => [...items, draft]); setView('workbench');
    notify('已创建可编辑的任务副本');
  };
  const running = jobs.filter(job => job.status === 'running').length;
  const queued = jobs.filter(job => job.status === 'queued').length;
  const resultCount = jobs.reduce((count, job) => count + (job.results?.length || 0), 0);
  const eligibleCount = drafts.filter(draft => draft.prompt.trim()
    && settings?.profiles.find(profile => profile.id === draft.profileId)?.models.includes(draft.model)
    && !ACTIVE.has(jobFor(draft)?.status)).length;
  const connected = settings?.profiles.some(profile => profile.hasKey);

  if (!settings) return <div className="startup-screen"><div className="brand-mark"><Boxes size={27} /></div><strong>FRAME</strong><span>{offline || '正在打开图像工作台'}</span>{!offline && <LoaderCircle size={20} className="spin" />}{offline && <button className="button secondary" onClick={() => location.reload()}>重新连接</button>}</div>;

  return <div className="app-shell">
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <a className="brand" href="/" onClick={event => { event.preventDefault(); changeView('workbench'); }}><div className="brand-mark"><Boxes size={24} strokeWidth={1.6} /></div><span>FRAME<small>图像工作台</small></span></a>
      <div className="workspace-name"><span className="workspace-avatar">F</span><span>我的创作空间<small>LOCAL WORKSPACE</small></span><ChevronRight size={14} /></div>
      <span className="nav-section-label">创作</span>
      <nav>
        <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={() => changeView('workbench')}><LayoutGrid size={18} /><span>生图工作台</span><span className="nav-count">{drafts.length}</span></button>
        <button className={`nav-item ${view === 'gallery' ? 'active' : ''}`} onClick={() => changeView('gallery')}><Images size={18} /><span>作品与历史</span>{resultCount > 0 && <span className="nav-count">{resultCount}</span>}</button>
      </nav>
      <span className="nav-section-label settings-label">管理</span>
      <nav><button className="nav-item" onClick={() => { setSettingsOpen(true); setMobileNav(false); }}><Radio size={18} /><span>API 连接</span><span className={`nav-status-dot ${connected ? 'online' : ''}`} /></button><button className="nav-item" onClick={() => { setSettingsOpen(true); setMobileNav(false); }}><Settings2 size={18} /><span>工作台设置</span></button></nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-queue"><div><span className="mini-pulse" />任务队列<span>{running + queued > 0 ? '处理中' : '空闲'}</span></div><div className="queue-meters">{Array.from({ length: Math.min(10, settings.concurrency) }, (_, i) => <i key={i} className={i < Math.ceil(running / settings.concurrency * Math.min(10, settings.concurrency)) ? 'busy' : ''} />)}</div><p><strong>{running}</strong> 正在生成<span>{queued} 排队</span></p></div>
      <button className="connection-summary" onClick={() => setSettingsOpen(true)}><div className={`connection-icon ${connected ? 'configured' : ''}`}><Radio size={18} /></div><span>{connected ? 'API 已配置' : '连接你的 API'}<small>{connected ? `${settings.profiles.filter(item => item.hasKey).length} 个可用连接` : '尚未配置 API Key'}</small></span><ArrowUpRight size={15} /></button>
      <div className="sidebar-footer"><span className="local-dot" />本地运行<span>v1.0</span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" title="打开导航" aria-label="打开导航" onClick={() => setMobileNav(true)}><Menu size={20} /></button><span>创作空间</span><ChevronRight size={13} /><strong>{view === 'gallery' ? '作品与历史' : '生图工作台'}</strong></div><div className="topbar-right"><span className="local-indicator"><i />本地工作台</span><button className="icon-button" title="API 连接与设置" aria-label="API 连接与设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button><span className="user-avatar">F</span></div></header>
      <main>
        <div className="page-heading"><div><div className="section-eyebrow">{view === 'gallery' ? 'YOUR COLLECTION' : 'IMAGE WORKSPACE'}</div><h1>{view === 'gallery' ? '作品与历史' : '生图工作台'}<span className="heading-period">.</span></h1><p>{view === 'gallery' ? `${jobs.length} 次创作，${resultCount} 张画面。` : `${drafts.length} 个任务 · ${resultCount} 张作品`}</p></div><div className="heading-actions">{view === 'workbench' ? <><button className="button secondary" onClick={() => addDraft({ title: `创作 ${drafts.length + 1}` })}><Plus size={16} />新建任务</button><button className="button primary" disabled={!eligibleCount || submitting.size > 0 || uploading.size > 0} onClick={() => submitMany(drafts)}><Sparkles size={16} />全部生成<span className="button-count">{eligibleCount}</span></button></> : <button className="button primary" onClick={() => { addDraft({ title: '新的创作' }); }}><Plus size={16} />新建创作</button>}</div></div>
        {offline && <div className="connection-banner error-banner"><CircleAlert size={17} /><span>{offline}</span><button className="text-button" onClick={() => { api('/settings').then(setSettings).catch(() => {}); reloadJobs(); }}>重新连接</button></div>}
        {!connected && !offline && <div className="connection-banner"><span className="banner-icon"><KeyIcon /></span><span>准备好开始了<small>连接你的 OpenAI API，开启第一张画面。</small></span><button className="text-button" onClick={() => setSettingsOpen(true)}>配置 API<ArrowRight size={15} /></button></div>}
        {view === 'workbench' ? <>
          <div className="workspace-toolbar"><div className="workspace-tabs"><button className="active" onClick={() => {}}>全部任务<span>{drafts.length}</span></button><button onClick={() => changeView('gallery')}>生成记录<ArrowUpRight size={13} /></button></div><div className="workspace-toolbar-right"><span><i className={running ? 'active-dot' : ''} />并行 {running} / {settings.concurrency}</span><button className="icon-button" title={rail ? '收起灵感栏' : '展开灵感栏'} aria-label={rail ? '收起灵感栏' : '展开灵感栏'} onClick={() => setRail(value => !value)}>{rail ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button></div></div>
          <div className={`workspace-layout ${rail && drafts.length < 8 ? '' : 'rail-hidden'}`}>
            <Workbench drafts={drafts} settings={settings} defaults={defaults} jobs={jobs} submitting={submitting} uploading={uploading} lockedIds={lockedIds} onDefaults={saveDefaults} onImport={importTasks} onBulk={bulkApply} onSubmit={submit} onSubmitMany={submitMany} onCancel={cancel} onRemove={removeTasks} onDuplicate={draft => addDraft({ ...draft, id: crypto.randomUUID(), title: `${draft.title} 副本`, jobId: null })} onChange={updateDraft} onUploadState={uploadState} onPreview={setPreview} notify={notify} />
            {rail && drafts.length < 8 && <aside className="inspiration-rail"><div className="rail-heading"><h2>灵感一隅</h2><Sparkles size={15} /></div><p className="rail-subtitle">从一个画面开始</p><div className="inspiration-list">{INSPIRATIONS.map(item => <button className="inspiration-item" key={item.id} onClick={() => {
              const empty = drafts.find(draft => !draft.prompt.trim() && !ACTIVE.has(jobFor(draft)?.status));
              if (empty) updateDraft(empty.id, { prompt: item.prompt, title: item.name });
              else addDraft({ prompt: item.prompt, title: item.name });
              notify('已填入灵感提示词');
            }}><div className="inspiration-photo"><img src={item.image} alt={item.category} /><span><ArrowUpRight size={16} /></span></div><div className="inspiration-copy"><strong>{item.name}</strong><span>{item.category}</span></div></button>)}</div><div className="rail-bottom"><span>随想，随时发生。</span><small>摄影参考 · Unsplash</small></div></aside>}
          </div>
        </> : <Gallery jobs={jobs} onReuse={reuse} onPreview={setPreview} onDelete={async id => { try { await api(`/jobs/${id}`, { method: 'DELETE' }); await reloadJobs(); } catch (error) { notify(error.message, 'error'); } }} />}
        <footer className="page-footer"><span>FRAME / 图像工作台</span><span>留住每一个值得成像的想法</span></footer>
      </main>
    </div>
    {settingsOpen && <Settings settings={settings} onSaved={setSettings} onClose={() => setSettingsOpen(false)} notify={notify} />}
    {preview && <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="图片预览" onClick={event => { if (event.target === event.currentTarget) setPreview(null); }}><div className="preview-top"><span>图像预览{preview.width ? ` · ${preview.width} × ${preview.height}` : ''}</span><div><button className="button preview-download" onClick={() => download(preview)}><Download size={16} />下载图片</button><button className="icon-button" title="关闭预览" aria-label="关闭预览" onClick={() => setPreview(null)}><X size={22} /></button></div></div><div className="preview-image"><img src={preview.url} alt={preview.prompt || '图片预览'} /></div><div className="preview-bottom"><p>{preview.prompt}</p><button className="button preview-download" onClick={() => { addDraft({ title: '参考图创作', references: [{ id: preview.id, url: preview.url, name: '参考图片' }] }); setPreview(null); notify('已添加为新任务的参考图'); }}><ImagePlus size={16} />用作参考图</button></div></div>}
    <div className="toast-stack" role="status" aria-live="polite">{toasts.map(toast => <div className={`toast ${toast.type}`} key={toast.id}>{toast.type === 'error' ? <CircleAlert size={17} /> : <Check size={17} />}<span>{toast.message}</span><button title="关闭消息" aria-label="关闭消息" onClick={() => setToasts(items => items.filter(item => item.id !== toast.id))}><X size={13} /></button></div>)}</div>
  </div>;
}

function KeyIcon() {
  return <Radio size={17} />;
}
