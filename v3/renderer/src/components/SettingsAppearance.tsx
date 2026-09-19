import { Select } from "./ui/Select";
import { useState } from 'react';
import type { Settings } from '@threadterm/protocol';
import { customTheme, type ThemeTokens } from '../themes';
import { SurfaceDialog } from './SurfaceDialog';

const base:ThemeTokens={background:'#f7f8f8',surface:'#ffffff',text:'#282a30',muted:'#6b6f76',accent:'#5655d9',border:'#e3e4e8'};
function download(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
function parsePack(value:unknown):Record<string,ThemeTokens>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请输入有效的主题对象 / Enter a valid theme object.');
 const source=value as Record<string,unknown>;
 const entries=typeof source.name==='string'?[[source.name,{...base,...(typeof source.colors==='object'?source.colors:source)}]]:Object.entries(source);
 const result:Record<string,ThemeTokens>={};
 for(const [name,tokens]of entries){if(typeof name!=='string'||!name.trim()||name.length>60)throw new Error('主题名称无效 / Invalid theme name.');const valid=customTheme({themeSelection:'custom:pack',customThemes:{pack:tokens}});if(!valid)throw new Error('主题颜色必须是六位十六进制值 / Theme colors must be six-digit hex values.');result[name]=valid;}
 if(!Object.keys(result).length)throw new Error('主题包为空 / The theme pack is empty.');
 return result;
}
export function SettingsAppearance({settings,zh,update}:{settings:Settings;zh:boolean;update:(patch:Record<string,unknown>)=>Promise<void>}){
 const [importOpen,setImportOpen]=useState(false),[source,setSource]=useState(''),[issue,setIssue]=useState<string>(),[busy,setBusy]=useState(false);
 const theme=settings.theme??'system',selection=typeof settings.themeSelection==='string'?settings.themeSelection:theme;
 const themes=settings.customThemes&&typeof settings.customThemes==='object'?settings.customThemes as Record<string,ThemeTokens>:{};
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setIssue(undefined);try{await action();}catch(error){setIssue(String(error instanceof Error?error.message:error));}finally{setBusy(false);}};
 return <>
  <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{zh?'外观模式':'Appearance mode'}</div><p>{zh?'主题会即时应用到所有窗口。':'Themes apply immediately across your windows.'}</p></div><div className="theme-mode-switch">{(['system','light','dark']as const).map(value=><button className={`theme-choice ${selection===value?'selected':''}`} key={value} aria-pressed={selection===value} disabled={busy} onClick={()=>void run(()=>update({theme:value,themeSelection:value}))}>{value==='system'?'◐':value==='light'?'☀':'☾'}<span>{value==='system'?(zh?'跟随系统':'System'):value==='light'?(zh?'浅色':'Light'):(zh?'深色':'Dark')}</span></button>)}</div></div></div>
  <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{zh?'主题包':'Theme packs'}</div><p>{zh?'导入 JSON 主题或导出当前自定义主题。':'Import a JSON theme or export the current custom themes.'}</p></div><div className="inline-actions"><button className="btn-subtle" onClick={()=>setImportOpen(true)}>{zh?'导入主题':'Import theme'}</button><button className="btn-subtle" onClick={()=>download('threadterm-themes.json',themes)}>{zh?'导出主题':'Export theme'}</button></div></div><ul className="theme-list">{Object.entries(themes).map(([name,tokens])=><li className={`theme-pack${selection===`custom:${name}`?' is-on':''}`} key={name}><button className="theme-pack-main" disabled={busy} onClick={()=>void run(()=>update({themeSelection:`custom:${name}`}))}><i style={{background:tokens.accent}}/><span>{name}</span></button><button className="btn-subtle" disabled={busy} onClick={()=>void run(async()=>{const next={...themes};delete next[name];await update({customThemes:next,...(selection===`custom:${name}`?{themeSelection:theme}:{})});})}>{zh?'删除':'Delete'}</button></li>)}{!Object.keys(themes).length&&<li className="theme-pack is-empty">{zh?'尚无自定义主题':'No custom themes'}</li>}</ul></div>
  <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{zh?'显示语言':'Display language'}</div><p>{zh?'切换所有窗口的界面语言。':'Change the interface language across your windows.'}</p></div><Select className="settings-select" disabled={busy} value={zh?'zh-CN':'en'} onChange={event=>void run(()=>update({language:event.target.value}))}><option value="zh-CN">中文</option><option value="en">English</option></Select></div></div>
  {issue&&!importOpen&&<p className="surface-error" role="alert">{issue}</p>}
  {importOpen&&<SurfaceDialog title={zh?'导入主题':'Import theme'} onClose={()=>setImportOpen(false)} size="sm" footer={<><button className="btn" onClick={()=>setImportOpen(false)}>{zh?'取消':'Cancel'}</button><button className="btn btn-primary" disabled={busy} onClick={()=>void run(async()=>{const imported=parsePack(JSON.parse(source));await update({customThemes:{...themes,...imported}});setImportOpen(false);setSource('');})}>{zh?'验证并导入':'Validate & import'}</button></>}><label>{zh?'主题 JSON':'Theme JSON'}<textarea className="settings-theme-json" value={source} onChange={event=>setSource(event.target.value)} rows={9} placeholder='{"name":"Ocean","accent":"#5db9ff"}'/></label><label className="btn-subtle">{zh?'从文件读取':'Read from a file'}<input className="theme-file-input" type="file" accept="application/json" onChange={event=>{const file=event.target.files?.[0];if(file)void file.text().then(setSource).catch(error=>setIssue(String(error)));}}/></label>{issue&&<p className="surface-error" role="alert">{issue}</p>}</SurfaceDialog>}
 </>;
}
