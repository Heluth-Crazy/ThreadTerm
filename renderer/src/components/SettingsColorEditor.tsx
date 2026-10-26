import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Settings } from '@threadterm/protocol';
import { accentForegroundContrast, colorContrastWarnings, colorDraftPatch, colorRoles, createColorDraft, deleteColorTheme, normalizeColor, type ColorDraft, type ColorRole } from '../colorEditor';
import type { ThemeTokens } from '../themes';
import { endColorPreview, previewColors } from '../themePreview';
import './color-editor.css';

const labels: Record<ColorRole, [string, string]> = {
 background: ['Window background', '窗口背景'], sidebar: ['Sidebar background', '侧栏背景'], surface: ['Panel background', '面板背景'], editor: ['Editor background', '编辑器背景'],
 text: ['Text', '文字'], muted: ['Secondary text', '次要文字'], border: ['Border', '边框'], accent: ['Accent', '强调色'],
};
export function SettingsThemeDelete({name,themes,selection,zh,disabled,update}:{name:string;themes:Record<string,ThemeTokens>;selection:string;zh:boolean;disabled:boolean;update:(patch:Record<string,unknown>)=>Promise<void>}) {
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>();
 return <div className="color-editor-pack-delete">{confirm?<><span>{zh?'删除主题？':'Delete theme?'}</span><button type="button" className="btn" disabled={disabled||busy} onClick={()=>setConfirm(false)}>{zh?'保留主题':'Keep theme'}</button><button type="button" className="btn btn-danger" disabled={disabled||busy} onClick={()=>{setBusy(true);void update(deleteColorTheme(name,themes,selection,window.matchMedia('(prefers-color-scheme: dark)').matches)).catch(error=>setIssue(String(error))).finally(()=>setBusy(false));}}>{zh?'确认删除':'Confirm delete'}</button></>:<button type="button" className="btn btn-danger" disabled={disabled||busy} onClick={()=>setConfirm(true)}>{zh?'删除':'Delete'}</button>}{issue&&<span className="surface-error" role="alert">{issue}</span>}</div>;
}
export function SettingsColorEditor({settings,zh,update}:{settings:Settings;zh:boolean;update:(patch:Record<string,unknown>)=>Promise<void>}) {
 const [draft,setDraft]=useState<ColorDraft>();
 const themes=(settings.customThemes??{}) as Record<string,ThemeTokens>;
 const selection=String(settings.themeSelection??settings.theme??'system');
 return <div className="settings-card settings-color-editor">
  {draft?<ColorEditorForm key={selection} initial={draft} themes={themes} selection={selection} zh={zh} update={update} onClose={()=>setDraft(undefined)}/>:<div className="settings-card-row"><div><div className="settings-card-title">{zh?'主题颜色':'Theme colours'}</div><p>{zh?'调整当前主题的颜色，实时预览所有窗口。':'Adjust the current theme with a live preview across your windows.'}</p></div><button type="button" className="btn" onClick={()=>setDraft(createColorDraft(selection,themes,window.matchMedia('(prefers-color-scheme: dark)').matches))}>{zh?'自定义颜色':'Customize colours'}</button></div>}
 </div>;
}
function ColorEditorForm({initial,themes,selection,zh,update,onClose}:{initial:ColorDraft;themes:Record<string,ThemeTokens>;selection:string;zh:boolean;update:(patch:Record<string,unknown>)=>Promise<void>;onClose:()=>void}) {
 const [draft,setDraft]=useState(initial),[fields,setFields]=useState(()=>Object.fromEntries(colorRoles.map(role=>[role,initial.tokens[role]!] )) as Record<ColorRole,string>);
 const [busy,setBusy]=useState(false),[issue,setIssue]=useState<string>(),[confirmDelete,setConfirmDelete]=useState(false);
 const id=useId(),owner=useRef(crypto.randomUUID()),root=useRef<HTMLDivElement>(null);
 const text=(role:ColorRole)=>labels[role][zh?1:0];
 const invalid=colorRoles.some(role=>!normalizeColor(fields[role]));
 const name=draft.name.trim(),nameInvalid=!name||name.length>60||(!draft.originalName&&Boolean(themes[name]));
 useEffect(()=>()=>endColorPreview(owner.current),[]);
 useEffect(()=>{root.current?.focus();},[]);
 const change=(role:ColorRole,value:string)=>{
  setFields(old=>({...old,[role]:value}));setIssue(undefined);
  const normalized=normalizeColor(value);
  if(normalized){const next={...draft,tokens:{...draft.tokens,[role]:normalized}};setDraft(next);previewColors(owner.current,next.tokens);}
 };
 const reset=()=>{const next={...draft,tokens:{...draft.tokens,...Object.fromEntries(colorRoles.map(role=>[role,draft.base[role]]))}};setDraft(next);setFields(Object.fromEntries(colorRoles.map(role=>[role,next.tokens[role]!])) as Record<ColorRole,string>);previewColors(owner.current,next.tokens);};
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setIssue(undefined);try{await action();endColorPreview(owner.current);onClose();}catch(error){setIssue(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
 const save=(asNew=false)=>void run(async()=>{try{await update(colorDraftPatch(draft,themes,asNew));}catch(error){if(error instanceof Error&&['Invalid colours','Invalid name','Duplicate name'].includes(error.message))throw Error(zh?'请输入有效且未使用的主题名称和颜色。':'Enter valid colours and an unused theme name.');throw error;}});
 const warnings=colorContrastWarnings(draft.tokens);
 return <div ref={root} tabIndex={-1} role="group" data-testid="color-editor" className="color-editor-form" aria-labelledby={`${id}-title`}>
  <div className="settings-card-title" id={`${id}-title`}>{zh?'自定义颜色':'Customize colours'}</div>
  <p className="hint">{zh?'悬停、选择、强调色文字及状态、语法和终端颜色随主题自动生成。':'Hover, selection and accent text are automatic; status, syntax and terminal colours follow the theme.'}</p>
  <div className="color-editor-name"><label htmlFor={`${id}-name`}>{zh?'主题名称':'Theme name'}</label><input id={`${id}-name`} value={draft.name} maxLength={60} disabled={busy} aria-invalid={nameInvalid||undefined} aria-describedby={nameInvalid?`${id}-name-error`:undefined} onChange={event=>setDraft(old=>({...old,name:event.target.value}))}/></div>
  {draft.originalName&&<p className="hint">{zh?`“保存”更新 ${draft.originalName}；“另存为新主题”使用上方名称。`:`Save updates ${draft.originalName}; Save as new uses the name above.`}</p>}
  {nameInvalid&&<p className="surface-error" id={`${id}-name-error`}>{zh?'请使用 1–60 个字符的未使用名称。':'Use an unused name of 1–60 characters.'}</p>}
  <div className="color-editor-rows">{colorRoles.map(role=>{const invalid=!normalizeColor(fields[role]);return <div className="color-editor-row" key={role}>
   <label htmlFor={`${id}-${role}`}>{text(role)}</label>
   <input type="color" className="btn color-editor-swatch" data-testid={`color-editor-swatch-${role}`} aria-label={`${text(role)} ${zh?'选色器':'colour picker'}`} value={draft.tokens[role]} disabled={busy} onChange={event=>change(role,event.target.value)} style={{'--color-swatch':draft.tokens[role]} as CSSProperties}/>
   <input id={`${id}-${role}`} data-testid={`color-editor-${role}`} className="color-editor-hex" aria-invalid={invalid||undefined} aria-describedby={invalid?`${id}-${role}-error`:undefined} value={fields[role]} spellCheck={false} autoComplete="off" disabled={busy} onChange={event=>change(role,event.target.value)} onBlur={()=>{const value=normalizeColor(fields[role]);if(value)setFields(old=>({...old,[role]:value}));}}/>
   <button type="button" className="btn" data-testid={`color-editor-reset-${role}`} aria-label={`${zh?'重置':'Reset'} ${text(role)}`} disabled={busy} onClick={()=>change(role,draft.base[role]!)}>{zh?'重置':'Reset'}</button>
   {invalid&&<span id={`${id}-${role}-error`} className="surface-error color-editor-field-error">{zh?'请输入 #rrggbb 或 #rgb。':'Enter #rrggbb or #rgb.'}</span>}
  </div>;})}</div>
  {!!warnings.length&&<div className="hint color-editor-warnings" role="status" data-testid="color-editor-contrast-warning">{warnings.map(warning=><p key={`${warning.foreground}-${warning.surface}`}>{zh?`${text(warning.foreground)}在${text(warning.surface)}上的对比度为 ${warning.ratio.toFixed(2)}:1（建议 ≥ ${warning.minimum}:1）。`:`${text(warning.foreground)} on ${text(warning.surface)}: ${warning.ratio.toFixed(2)}:1 (recommended ≥ ${warning.minimum}:1).`}</p>)}</div>}
  {accentForegroundContrast(draft.tokens)<4.5&&<p className="hint color-editor-warnings">{zh?'强调色文字已自动选择；黑色和白色均未达到 4.5:1。':'Accent text is chosen automatically; neither black nor white reaches 4.5:1.'}</p>}
  {issue&&<p className="surface-error" role="alert">{issue}</p>}
  <div className="color-editor-actions"><button type="button" className="btn" disabled={busy} onClick={reset}>{zh?'全部重置':'Reset all'}</button>{draft.originalName&&<button type="button" className="btn btn-danger" disabled={busy} onClick={()=>setConfirmDelete(true)}>{zh?'删除':'Delete'}</button>}<span className="color-editor-action-gap"/><button type="button" className="btn" disabled={busy} onClick={onClose}>{zh?'取消':'Cancel'}</button>{draft.originalName&&<button type="button" className="btn" disabled={busy||invalid||!name||name.length>60} onClick={()=>save(true)}>{zh?'另存为新主题':'Save as new'}</button>}<button type="button" className="btn btn-primary" disabled={busy||invalid||nameInvalid} onClick={()=>save()}>{zh?'保存':'Save'}</button></div>
  {confirmDelete&&<div className="color-editor-delete" role="group" aria-label={zh?'确认删除主题':'Confirm theme deletion'}><p>{zh?'删除此自定义主题？当前主题将回退到基础预设。':'Delete this custom theme? The active theme will return to its base preset.'}</p><div className="inline-actions"><button type="button" className="btn" disabled={busy} onClick={()=>setConfirmDelete(false)}>{zh?'保留主题':'Keep theme'}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={()=>void run(()=>update(deleteColorTheme(draft.originalName!,themes,selection,window.matchMedia('(prefers-color-scheme: dark)').matches)))}>{zh?'确认删除':'Confirm delete'}</button></div></div>}
 </div>;
}
