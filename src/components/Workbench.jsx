import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckSquare, Copy, Download, FileJson, LayoutGrid, List, Search, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react';
import { ACTIVE, download, STATUS } from '../lib.js';
import BatchImport from './BatchImport.jsx';
import BatchSettings from './BatchSettings.jsx';
import TaskCard from './TaskCard.jsx';

export default function Workbench({ drafts, settings, defaults, jobs, submitting, uploading, lockedIds, onDefaults, onImport, onBulk, onSubmit, onSubmitMany, onCancel, onRemove, onDuplicate, onChange, onUploadState, onPreview, notify }) {
  const [mode, setMode] = useState(() => localStorage.getItem('frame-task-view') || (drafts.length >= 8 ? 'list' : 'cards'));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [dialog, setDialog] = useState('');
  const [editing, setEditing] = useState(null);
  const allCheck = useRef(null);
  const modalRef = useRef(null);
  const jobsById = useMemo(() => new Map(jobs.map(job => [job.id, job])), [jobs]);
  const indices = useMemo(() => new Map(drafts.map((draft, index) => [draft.id, index])), [drafts]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return drafts.filter(draft => {
      const status = jobsById.get(draft.jobId)?.status || 'draft';
      return (filter === 'all' || status === filter || (filter === 'active' && ACTIVE.has(status)))
        && (!search || `${draft.title} ${draft.prompt} ${draft.model}`.toLowerCase().includes(search));
    });
  }, [drafts, jobsById, query, filter]);
  const pageSize = mode === 'list' ? 25 : 6;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedIds = [...selected].filter(id => indices.has(id));
  const allSelected = filtered.length > 0 && filtered.every(draft => selected.has(draft.id));
  const editingDraft = drafts.find(draft => draft.id === editing);
  const emptyCount = drafts.filter(draft => !draft.prompt.trim() && !draft.references.length && !draft.jobId && !lockedIds.has(draft.id)).length;
  const selectedEditable = selectedIds.filter(id => !lockedIds.has(id));
  const activeSelected = drafts.filter(draft => selected.has(draft.id) && ACTIVE.has(jobsById.get(draft.jobId)?.status));
  const modalOpen = Boolean(dialog || editingDraft);
  const close = () => { if (!uploading.size) { setDialog(''); setEditing(null); } };
  useEffect(() => { if (allCheck.current) allCheck.current.indeterminate = !allSelected && filtered.some(draft => selected.has(draft.id)); }, [filtered, selected, allSelected]);
  useEffect(() => { setPage(1); }, [query, filter, mode]);
  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.activeElement;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => modalRef.current?.querySelector('button, textarea, input, select')?.focus(), 0);
    const handler = event => {
      if (document.querySelector('.preview-backdrop')) return;
      if (event.key === 'Escape' && !uploading.size) { setDialog(''); setEditing(null); }
      if (event.key === 'Tab' && modalRef.current && !document.querySelector('.preview-backdrop')) {
        const elements = [...modalRef.current.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled)')].filter(element => element.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => { clearTimeout(timer); document.body.style.overflow = ''; window.removeEventListener('keydown', handler); previous?.focus(); };
  }, [modalOpen, uploading.size]);
  const chooseMode = value => { setMode(value); try { localStorage.setItem('frame-task-view', value); } catch {} };
  const toggle = id => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectAll = () => setSelected(previous => { const next = new Set(previous); filtered.forEach(draft => allSelected ? next.delete(draft.id) : next.add(draft.id)); return next; });
  const taskCard = draft => <TaskCard key={draft.id} draft={draft} index={indices.get(draft.id)} settings={settings} job={jobsById.get(draft.jobId)} onChange={patch => onChange(draft.id, patch)} onSubmit={() => onSubmit(draft)} onDuplicate={() => onDuplicate(draft)} onRemove={() => { onRemove([draft.id]); if (!lockedIds.has(draft.id)) setEditing(null); }} onCancel={() => onCancel(jobsById.get(draft.jobId))} onPreview={onPreview} onUploadState={active => onUploadState(draft.id, active)} notify={notify} submitting={submitting.has(draft.id)} uploadingExternal={uploading.has(draft.id)} />;
  return <section className="batch-workspace">
    <div className="batch-commandbar">
      <div className="batch-primary-actions"><button className="button secondary" onClick={() => setDialog('import')}><FileJson size={16} />JSON 批量导入</button><button className="button secondary" onClick={() => setDialog('settings')}><Settings2 size={16} />统一参数</button></div>
      <div className="view-switch" role="group" aria-label="任务显示方式"><button className={mode === 'list' ? 'active' : ''} title="紧凑列表" aria-label="紧凑列表" aria-pressed={mode === 'list'} onClick={() => chooseMode('list')}><List size={17} /></button><button className={mode === 'cards' ? 'active' : ''} title="卡片视图" aria-label="卡片视图" aria-pressed={mode === 'cards'} onClick={() => chooseMode('cards')}><LayoutGrid size={16} /></button></div>
    </div>
    <div className="defaults-summary"><Settings2 size={13} /><span>新任务默认</span><strong title={defaults.model}>{defaults.model || '未选择模型'}</strong><span>{defaults.size} · {defaults.quality} · {defaults.n} 张 · {defaults.outputFormat.toUpperCase()}</span><button className="text-button" onClick={() => setDialog('settings')}>修改</button></div>
    <div className="batch-filters"><label className="search-input"><Search size={16} /><input aria-label="搜索任务" placeholder="搜索名称、提示词、模型" value={query} onChange={event => setQuery(event.target.value)} /></label><select className="filter-select" aria-label="筛选任务状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="active">排队 / 生成中</option>{Object.entries(STATUS).filter(([value]) => value !== 'draft').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span className="filter-count">{filtered.length} / {drafts.length} 个任务</span></div>
    <div className={`batch-selection ${selectedIds.length ? 'has-selection' : ''}`}><label className="batch-check"><input ref={allCheck} type="checkbox" aria-label="全选筛选结果" checked={allSelected} onChange={selectAll} disabled={!filtered.length} /><span>{selectedIds.length ? `已选 ${selectedIds.length} 个` : '全选筛选结果'}</span></label><div className="selection-actions">
      <button className="icon-button" title="修改所选任务参数" aria-label="修改所选任务参数" disabled={!selectedEditable.length} onClick={() => setDialog('settings')}><Settings2 size={16} /></button>
      <button className="icon-button" title="生成所选任务" aria-label="生成所选任务" disabled={!selectedEditable.length || Boolean(submitting.size)} onClick={() => onSubmitMany(drafts.filter(draft => selected.has(draft.id)))}><Sparkles size={16} /></button>
      <button className="icon-button" title="取消所选排队或生成中的任务" aria-label="取消所选活动任务" disabled={!activeSelected.length} onClick={() => activeSelected.forEach(draft => onCancel(jobsById.get(draft.jobId)))}><Square size={15} /></button>
      <button className="icon-button danger-text" title="移除所选可编辑任务" aria-label="移除所选任务" disabled={!selectedEditable.length} onClick={() => { onRemove(selectedEditable); setSelected(previous => new Set([...previous].filter(id => !selectedEditable.includes(id)))); }}><Trash2 size={16} /></button>
      {selectedIds.length > 0 && <button className="icon-button" title="清除选择" aria-label="清除选择" onClick={() => setSelected(new Set())}><X size={16} /></button>}
    </div></div>
    {mode === 'list' ? <div className="task-table" role="table" aria-label="批量任务列表">
      <div className="task-table-head" role="row"><span /><span>任务 / 提示词</span><span>模型 / 参数</span><span>状态</span><span>操作</span></div>
      {visible.map(draft => {
        const job = jobsById.get(draft.jobId);
        const status = job?.status || 'draft';
        const result = job?.results?.[0];
        return <div key={draft.id} className={`task-table-row ${selected.has(draft.id) ? 'is-selected' : ''}`} role="row">
          <input type="checkbox" aria-label={`选择任务 ${indices.get(draft.id) + 1}`} checked={selected.has(draft.id)} onChange={() => toggle(draft.id)} />
          <div className="task-row-content"><button className="task-row-thumb" title={result ? '预览结果' : '编辑任务'} aria-label={`${result ? '预览' : '编辑'}任务 ${indices.get(draft.id) + 1}`} onClick={() => result ? onPreview({ ...result, prompt: job.prompt }) : setEditing(draft.id)}>{result ? <img loading="lazy" src={result.url} alt={draft.title} /> : <span>{String(indices.get(draft.id) + 1).padStart(2, '0')}</span>}</button><button className="task-row-copy" onClick={() => setEditing(draft.id)} title={draft.prompt || '编辑提示词'}><strong>{draft.title}</strong><span>{draft.prompt || '尚未填写提示词'}</span>{draft.references.length > 0 && <small>{draft.references.length} 张参考图</small>}</button></div>
          <button className="task-row-parameters" title="编辑此任务参数" onClick={() => setEditing(draft.id)}><strong title={draft.model}>{draft.model || '未选择模型'}</strong><span>{draft.size} · {draft.quality} · {draft.n} 张</span></button>
          <div className="task-row-status"><span className={`status status-${status}`}><i />{submitting.has(draft.id) ? '提交中' : STATUS[status]}</span>{job?.error && <small title={job.error}>{job.error}</small>}{job?.results?.length > 0 && <small>{job.results.length} 张图片</small>}</div>
          <div className="task-row-actions">{ACTIVE.has(status) ? <button className="icon-button" title="取消任务" aria-label={`取消任务 ${indices.get(draft.id) + 1}`} onClick={() => onCancel(job)}><Square size={14} /></button> : <button className="icon-button" title="生成图片" aria-label={`生成任务 ${indices.get(draft.id) + 1}`} disabled={lockedIds.has(draft.id) || !draft.prompt.trim() || !draft.model} onClick={() => onSubmit(draft)}><Sparkles size={16} /></button>}<button className="icon-button" title="编辑此任务" aria-label={`打开任务 ${indices.get(draft.id) + 1}`} onClick={() => setEditing(draft.id)}><Settings2 size={16} /></button><button className="icon-button" title={result ? '下载图片' : '复制任务'} aria-label={`${result ? '下载' : '复制'}任务 ${indices.get(draft.id) + 1}`} onClick={() => result ? job.results.forEach(download) : onDuplicate(draft)}>{result ? <Download size={16} /> : <Copy size={15} />}</button></div>
        </div>;
      })}
    </div> : <div className="tasks-grid batch-card-grid">{visible.map(draft => <div className="task-card-wrap" key={draft.id}><label className="batch-check card-selection"><input type="checkbox" aria-label={`选择任务 ${indices.get(draft.id) + 1}`} checked={selected.has(draft.id)} onChange={() => toggle(draft.id)} />选择任务 {indices.get(draft.id) + 1}</label>{taskCard(draft)}</div>)}</div>}
    {!filtered.length && <div className="batch-empty"><Search size={24} /><p>没有符合条件的任务</p><button className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button></div>}
    <div className="batch-pagination"><span>{filtered.length ? `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filtered.length)} / ${filtered.length}` : '0 个任务'}</span><div><button className="icon-button" title="上一页" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16} /></button><span>{currentPage} / {pages} 页</span><button className="icon-button" title="下一页" aria-label="下一页" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}><ArrowRight size={16} /></button></div></div>
    <div ref={modalRef}>
      {dialog === 'import' && <BatchImport settings={settings} defaults={defaults} count={drafts.length} emptyCount={emptyCount} onClose={close} notify={notify} onImport={(tasks, replaceEmpty) => { if (onImport(tasks, replaceEmpty)) { chooseMode('list'); setQuery(''); setFilter('all'); setPage(1); setDialog(''); } }} />}
      {dialog === 'settings' && <BatchSettings settings={settings} defaults={defaults} selectedCount={selectedIds.length} editableCount={drafts.length - lockedIds.size} onClose={close} notify={notify} onSaveDefaults={onDefaults} onApply={(patch, scope) => onBulk(patch, scope === 'selected' ? selected : null)} />}
      {editingDraft && <div className="modal-backdrop task-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section className="task-editor" role="dialog" aria-modal="true" aria-label="单个任务编辑"><div className="editor-heading"><strong>任务 {indices.get(editingDraft.id) + 1} · 独立参数</strong><button className="icon-button" title="关闭任务编辑" aria-label="关闭任务编辑" disabled={uploading.has(editingDraft.id)} onClick={close}><X size={20} /></button></div>{taskCard(editingDraft)}</section></div>}
    </div>
  </section>;
}
