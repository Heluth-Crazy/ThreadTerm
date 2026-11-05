import { useEffect, useRef, useState } from 'react';
import type { RequestResult } from '@threadterm/protocol';
import { request } from '../bridge';
import { navigationError, type NavigationLocation } from '../editorNavigation';
import { SurfaceDialog } from './SurfaceDialog';
import './editor-navigation.css';

export function EditorNavigationChooser({ title, targets, truncated, zh, onClose, onSelect }: { title: string; targets: NavigationLocation[]; truncated: boolean; zh: boolean; onClose: () => void; onSelect: (value: NavigationLocation) => void }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const filtered = targets.filter(target => `${target.name ?? ''} ${target.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  return <SurfaceDialog title={title} onClose={onClose} size="sm" className="editor-navigation-dialog">
    <input className="editor-navigation-search" autoFocus aria-label={zh ? '筛选符号或路径' : 'Filter symbols or paths'} placeholder={zh ? '筛选符号或路径' : 'Filter symbols or paths'} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} role="combobox" aria-expanded="true" aria-controls="editor-navigation-targets" aria-activedescendant={filtered.length ? `editor-navigation-target-${selected}` : undefined} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => filtered.length ? (index + (event.key === 'ArrowDown' ? 1 : filtered.length - 1)) % filtered.length : 0); }
      if (event.key === 'Enter' && filtered[selected]) { event.preventDefault(); onSelect(filtered[selected]); }
    }} />
    <div ref={list} className="editor-navigation-targets" id="editor-navigation-targets" role="listbox" aria-label={title}>
      {filtered.map((target, index) => <button type="button" tabIndex={-1} role="option" aria-selected={index === selected} id={`editor-navigation-target-${index}`} key={`${target.path}:${target.line}:${target.column}:${index}`} onMouseMove={() => setSelected(index)} onClick={() => onSelect(target)}><strong>{target.name ?? target.path.split(/[\\/]/).at(-1)}</strong><small>{target.path}:{target.line}:{target.column}</small></button>)}
      {!filtered.length && <p>{zh ? '没有匹配项。' : 'No matches.'}</p>}
    </div>
    {truncated && <p className="note">{zh ? '结果过多，仅显示前一部分。' : 'Only the first results are shown.'}</p>}
  </SurfaceDialog>;
}

type Configuration = RequestResult<'editorNavigation.configuration'>;
const toolNames = { typescript: 'TypeScript / JavaScript', rust: 'Rust', python: 'Python', java: 'Java', jdtls: 'JDT Language Server' };
export function EditorNavigationSettings({ zh, onClose, onChanged }: { zh: boolean; onClose: () => void; onChanged: () => void }) {
  const [value, setValue] = useState<Configuration>(), [error, setError] = useState<string>(), [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const load = async () => {
    setError(undefined);
    try { const next = await request('editorNavigation.configuration', {}); if (mounted.current) setValue(next); }
    catch (failure) { if (mounted.current) setError(navigationError(failure, zh)); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (!value) return;
    setSaving(true); setError(undefined);
    try { const next = await request('editorNavigation.configure', { enabled: value.enabled, tools: value.tools }); if (mounted.current) { setValue(next); onChanged(); } }
    catch (failure) { if (mounted.current) setError(navigationError(failure, zh)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <SurfaceDialog title={zh ? '代码跳转 · 语言服务' : 'Code navigation · Language services'} onClose={onClose} className="editor-navigation-dialog" footer={<><button className="btn" onClick={() => void load()} disabled={saving}>{zh ? '重新检测' : 'Detect again'}</button><button className="btn btn-primary" onClick={() => void save()} disabled={!value || saving}>{zh ? '保存设置' : 'Save settings'}</button></>}>
    <p className="note">{zh ? '首次跳转或查看符号时启动，闲置 5 分钟后停止。最多同时运行 2 个服务；不会自动安装工具。设置属于当前电脑。' : 'Services start on the first lookup and stop after 5 idle minutes. At most 2 run at once. Tools are never installed automatically. These settings belong to the current computer.'}</p>
    {error && <p role="alert">{error}</p>}
    {!value && !error && <p>{zh ? '正在检测…' : 'Detecting…'}</p>}
    {value && <div className="editor-navigation-settings"><label><input type="checkbox" checked={value.enabled} onChange={event => setValue({ ...value, enabled: event.target.checked })} />{zh ? '启用按需代码跳转' : 'Enable on-demand code navigation'}</label>
      {(Object.keys(toolNames) as Array<keyof typeof toolNames>).map(id => <label key={id}><span>{toolNames[id]}</span><input type="text" value={value.tools[id] ?? ''} placeholder={id === 'jdtls' ? (zh ? '语言服务目录' : 'Language server directory') : (zh ? '自动检测，或填写可执行文件路径' : 'Auto-detect, or enter executable path')} onChange={event => setValue({ ...value, tools: { ...value.tools, [id]: event.target.value } })} /><small>{value.detected.find(tool => tool.id === id)?.message ?? value.detected.find(tool => tool.id === id)?.path ?? (zh ? '未检测到' : 'Not detected')}</small></label>)}
      <p className="note">{zh ? 'Java 需要兼容的 JDK 和 JDT LS；当前以源码跳转为主，未启用 Maven/Gradle 项目导入。Rust 不运行构建脚本或过程宏，部分生成代码无法跳转。大型项目首次索引可能较慢。' : 'Java needs a compatible JDK and JDT LS. Navigation focuses on source files; Maven/Gradle project import is disabled. Rust build scripts and procedural macros are disabled, so some generated targets are unavailable. Initial indexing may take time for large projects.'}</p>
      <p className="note">{zh ? '语言服务按自身权限读取项目；文件兼容模式不会授予它们访问权限。' : 'Language services use their own file access permissions; file compatibility mode does not grant them access.'}</p>
    </div>}
  </SurfaceDialog>;
}
