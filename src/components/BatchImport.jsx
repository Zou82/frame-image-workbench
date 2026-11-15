import React, { useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, FileJson, FileUp, X } from 'lucide-react';
import { buildAiPrompt, getBatchTemplate, MAX_DRAFTS, parseBatchJson } from '../../shared/batch.mjs';
import { copyText, saveText as platformSaveText } from '../platform.js';

export default function BatchImport({ settings, defaults, count, emptyCount, onImport, onClose, notify }) {
  const [text, setText] = useState('');
  const [replaceEmpty, setReplaceEmpty] = useState(true);
  const [tab, setTab] = useState('json');
  const fileInput = useRef(null);
  const result = useMemo(() => text.trim() ? parseBatchJson(text, settings, defaults) : { tasks: [], errors: [] }, [text, settings, defaults]);
  const aiPrompt = useMemo(() => buildAiPrompt(settings, defaults), [settings, defaults]);
  const remaining = MAX_DRAFTS - count + (replaceEmpty ? emptyCount : 0);
  const tooMany = result.tasks.length > remaining;
  const saveText = (name, value, type) => platformSaveText(name, value, type).catch(error => notify(error.message, 'error'));
  const copyPrompt = async () => {
    try { await copyText(aiPrompt); notify('已复制 JSON 生成提示词，可发送给你的 AI'); }
    catch { notify('复制失败，请在提示词文本框中选择并复制。', 'error'); }
  };
  const loadFile = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('JSON 文件不能超过 20 MB。');
      setText(await file.text());
      setTab('json');
    } catch (error) { notify(error.message, 'error'); }
    event.target.value = '';
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal batch-import" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="modal-head"><div className="modal-title"><FileJson size={20} /><h2 id="import-title">批量导入任务</h2></div><button className="icon-button" title="关闭导入" aria-label="关闭导入" onClick={onClose}><X size={20} /></button></div>
      <div className="dialog-tabs" role="tablist"><button role="tab" aria-selected={tab === 'json'} onClick={() => setTab('json')}>JSON 数据</button><button role="tab" aria-selected={tab === 'prompt'} onClick={() => setTab('prompt')}>给 AI 的提示词</button></div>
      <div className="batch-dialog-body">
        {tab === 'json' ? <>
          <div className="import-tools"><button className="button secondary" onClick={() => fileInput.current.click()}><FileUp size={15} />选择 JSON 文件</button><button className="text-button" onClick={() => setText(getBatchTemplate(defaults))}>填入示例</button><button className="icon-button" title="下载 JSON 示例" aria-label="下载 JSON 示例" onClick={() => saveText('frame-batch-example.json', getBatchTemplate(defaults), 'application/json')}><Download size={17} /></button><input hidden ref={fileInput} type="file" accept=".json,application/json" aria-label="导入 JSON 文件" onChange={loadFile} /></div>
          <label className="field">任务 JSON<textarea className="batch-json-input" aria-label="任务 JSON" spellCheck="false" value={text} onChange={event => setText(event.target.value)} placeholder={'{\n  "version": 1,\n  "defaults": { "quality": "high" },\n  "tasks": [\n    { "title": "任务 1", "prompt": "第一张图像的提示词" },\n    { "title": "任务 2", "prompt": "第二张图像的提示词" }\n  ]\n}'} /></label>
          {emptyCount > 0 && <label className="batch-check"><input type="checkbox" checked={replaceEmpty} onChange={event => setReplaceEmpty(event.target.checked)} />移除 {emptyCount} 个未使用的空白草稿</label>}
          {result.errors.length > 0 && <div className="validation-errors" role="alert"><strong>请修正 {result.errors.length} 处问题</strong><ul>{result.errors.slice(0, 20).map((error, i) => <li key={i}>{error}</li>)}</ul>{result.errors.length > 20 && <span>另有 {result.errors.length - 20} 处问题</span>}</div>}
          {tooMany && <div className="validation-errors" role="alert">当前还可导入 {remaining} 个任务，工作台最多保留 {MAX_DRAFTS} 个任务。</div>}
          {result.tasks.length > 0 && <div className="import-preview"><div><Check size={16} /><strong>校验通过 · {result.tasks.length} 个任务 · {result.tasks.reduce((sum, task) => sum + task.n, 0)} 张图片</strong></div><ol>{result.tasks.slice(0, 5).map((task, i) => <li key={i}><strong>{task.title}</strong><span>{task.prompt}</span><small>{task.model} · {task.size} · {task.quality}</small></li>)}</ol>{result.tasks.length > 5 && <p>还有 {result.tasks.length - 5} 个任务</p>}</div>}
        </> : <>
          <div className="import-tools"><button className="button secondary" onClick={copyPrompt}><Copy size={15} />复制提示词</button><button className="text-button" onClick={() => saveText('frame-ai-prompt.txt', aiPrompt, 'text/plain;charset=utf-8')}><Download size={15} />下载提示词</button></div>
          <textarea className="batch-json-input ai-prompt-input" aria-label="给 AI 的 JSON 生成提示词" readOnly value={aiPrompt} />
        </>}
      </div>
      <div className="modal-footer"><span className="footer-note">{result.tasks.length ? `${result.tasks.length} 个任务待导入` : `剩余 ${remaining} 个任务位置`}</span><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!result.tasks.length || result.errors.length > 0 || tooMany} onClick={() => onImport(result.tasks, replaceEmpty)}><FileJson size={15} />导入草稿{result.tasks.length > 0 ? ` (${result.tasks.length})` : ''}</button></div>
    </section>
  </div>;
}
