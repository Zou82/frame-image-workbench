import React, { useState } from 'react';
import { ArrowUpRight, Download, Image as ImageIcon, RotateCcw, Search, Trash2 } from 'lucide-react';
import { STATUS, ACTIVE, download, formatTime } from '../lib.js';

export default function Gallery({ jobs, onReuse, onPreview, onDelete }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [deleting, setDeleting] = useState('');
  const filtered = jobs.filter(job => (!query || `${job.title} ${job.prompt} ${job.model}`.toLowerCase().includes(query.toLowerCase()))
    && (filter === 'all' || job.status === filter));
  return <>
    <div className="gallery-toolbar"><div className="search-input"><Search size={16} /><input placeholder="搜索提示词、任务或模型…" aria-label="搜索历史" value={query} onChange={event => setQuery(event.target.value)} /></div><select className="filter-select" aria-label="筛选任务状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="completed">已完成</option><option value="running">生成中</option><option value="queued">排队中</option><option value="failed">生成失败</option><option value="cancelled">已取消</option><option value="interrupted">已中断</option></select><span className="muted">{filtered.length} 个任务</span></div>
    {!filtered.length ? <div className="gallery-empty"><ImageIcon size={42} strokeWidth={1} /><h3>{query || filter !== 'all' ? '没有匹配的记录' : '这里，收藏每一次创作'}</h3><p>{query || filter !== 'all' ? '试试其他关键词或状态' : '完成的图片和任务记录会保存在这里'}</p></div>
      : <div className="history-grid">{filtered.map(job => <article className="history-card" key={job.id}>
        <div className="history-images">{job.results?.length ? job.results.map(result => <button key={result.id} onClick={() => onPreview({ ...result, prompt: job.prompt })}><img src={result.url} alt={job.prompt} loading="lazy" /><ArrowUpRight size={18} /></button>) : <div className="history-no-image"><ImageIcon size={32} strokeWidth={1} /><span className={`status status-${job.status}`}><i />{STATUS[job.status]}</span></div>}</div>
        <div className="history-body"><div className="history-title"><h3>{job.title}</h3><span>{formatTime(job.createdAt)}</span></div><p>{job.prompt}</p><div className="history-model">{job.model}<span>{job.results?.length || 0} 张</span></div>{job.error && <div className="history-error">{job.error}</div>}</div>
        <div className="history-footer"><button className="text-button" onClick={() => onReuse(job)}><RotateCcw size={14} />复用任务</button><div>{job.results?.length > 0 && <button className="icon-button" title="下载全部结果" aria-label="下载全部结果" onClick={() => job.results.forEach(download)}><Download size={15} /></button>}<button className="icon-button" title="移除历史记录" aria-label="移除历史记录" disabled={ACTIVE.has(job.status)} onClick={() => setDeleting(job.id)}><Trash2 size={15} /></button></div></div>
        {deleting === job.id && <div className="delete-confirm"><span>移除此条历史记录？</span><button className="text-button" onClick={() => setDeleting('')}>保留</button><button className="text-button danger-text" onClick={async () => { await onDelete(job.id); setDeleting(''); }}>移除</button></div>}
      </article>)}</div>}
  </>;
}
