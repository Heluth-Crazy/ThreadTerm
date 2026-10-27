import { Select } from "./ui/Select";
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Settings } from '@threadterm/protocol';
import { type ThemeTokens } from '../themes';
import { SurfaceDialog } from './SurfaceDialog';
import { exportFile, request } from '../bridge';
import { THEME_PRESETS, type ThemePreset } from '../themePresets';
import { appearanceModeForSelection, familyForSelection, isPresetSelected, selectionForFamilyMode, selectionForPreset } from '../themeSelection';
import './theme-picker.css';
import { SettingsColorEditor, SettingsThemeDelete } from './SettingsColorEditor';
import { SettingsBackgrounds } from './SettingsBackgrounds';
import { importThemePack } from '../appearance/themePack';
import { appearanceErrorMessage } from '../appearance/backgroundSettings';
import { listBackgroundImages } from '../appearance/backgroundPipeline';
import { discardUnreferencedImports, pruneRemovedBackgrounds, withBackgroundMutation } from '../appearance/backgroundMutation';

const base:ThemeTokens={background:'#f7f8f8',surface:'#ffffff',text:'#282a30',muted:'#6b6f76',accent:'#5655d9',border:'#e3e4e8'};
function useSystemDark(){
 const [systemDark,setSystemDark]=useState(()=>typeof window!=="undefined"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
 useEffect(()=>{const query=window.matchMedia("(prefers-color-scheme: dark)"),change=()=>setSystemDark(query.matches);change();query.addEventListener("change",change);return()=>query.removeEventListener("change",change);},[]);
 return systemDark;
}
function ThemeCard({preset,selected,zh,disabled,onSelect}:{preset:ThemePreset;selected:boolean;zh:boolean;disabled:boolean;onSelect:()=>void}){
 const vars={"--theme-frame":preset.c.frame,"--theme-sidebar":preset.c.sidebar,"--theme-panel":preset.c.panel,"--theme-text":preset.c.text,"--theme-accent":preset.c.accent} as CSSProperties;
 const current=zh?'当前':'Current';
 return <button type="button" className="theme-gallery-card" style={vars} aria-pressed={selected} aria-label={`${preset.name}${selected?`, ${current}`:''}`} disabled={disabled} onClick={onSelect}>
  <span className="theme-gallery-swatch" aria-hidden="true"><i className="theme-gallery-sidebar"/><i className="theme-gallery-panel"><b className="theme-gallery-accent"/></i></span>
  <span className="theme-gallery-label"><span>{preset.name}</span>{selected&&<span className="theme-gallery-current">{current}</span>}</span>
 </button>;
}
export function SettingsAppearance({settings,zh,update}:{settings:Settings;zh:boolean;update:(patch:Record<string,unknown>)=>Promise<void>}){
 const fileInput=useRef<HTMLInputElement>(null);
 const [importOpen,setImportOpen]=useState(false),[source,setSource]=useState(''),[issue,setIssue]=useState<string>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string>();
 const theme=settings.theme??'system',selection=typeof settings.themeSelection==='string'?settings.themeSelection:theme;
 const themes=settings.customThemes&&typeof settings.customThemes==='object'?settings.customThemes as Record<string,ThemeTokens>:{};
 const systemDark=useSystemDark(),mode=appearanceModeForSelection(selection),family=familyForSelection(selection,themes);
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setIssue(undefined);try{await action();}catch(error){setIssue(appearanceErrorMessage(error,zh));}finally{setBusy(false);}};
 const updateThemes=(patch:Record<string,unknown>)=>{const next=patch.customThemes as Record<string,ThemeTokens>|undefined;if(!next||!Object.keys(themes).some(name=>!next[name]))return update(patch);return withBackgroundMutation(async()=>{await update(patch);await pruneRemovedBackgrounds(themes,next);});};
 const importPack=()=>withBackgroundMutation(async()=>{
  let value:unknown;try{value=JSON.parse(source.replace(/^\uFEFF/,''));}catch{throw Error('theme_pack_unreadable');}
  if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Record<string,unknown>).name==='string'&&!('threadtermThemePack' in value)){const legacy=value as Record<string,unknown>;value={...legacy,colors:{...base,...(typeof legacy.colors==='object'&&legacy.colors?legacy.colors:legacy)}};}
  const before=new Set((await listBackgroundImages()).map(record=>record.id)),imported=await importThemePack(value);
  try{const current=(await request('runtime.snapshot',{})).settings;await update({customThemes:{...current.customThemes as Record<string,ThemeTokens>,...imported.themes}});}catch(error){await discardUnreferencedImports(imported.records.filter(record=>!before.has(record.id)).map(record=>record.id));throw error;}
  const stored=new Set((await listBackgroundImages()).map(record=>record.id)),missing=imported.missing.filter(id=>!stored.has(id));
  const rejected=[...new Set([...imported.rejected,...missing])];
  setNotice(zh?`已导入 ${Object.keys(imported.themes).length} 个主题；已存储 ${imported.records.length} 张图片，拒绝或缺失 ${rejected.length} 张。${rejected.length?` 图片：${rejected.join(', ')}`:''}`:`Imported ${Object.keys(imported.themes).length} themes; stored ${imported.records.length} pictures, rejected or missing ${rejected.length}.${rejected.length?` Pictures: ${rejected.join(', ')}`:''}`);
  setImportOpen(false);setSource('');
 });
 const saveSelection=(next:string)=>run(()=>update({theme:appearanceModeForSelection(next)??theme,themeSelection:next}));
 return <>
  <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{zh?'外观模式':'Appearance mode'}</div><p>{zh?'主题会即时应用到所有窗口。':'Themes apply immediately across your windows.'}</p></div><div className="theme-mode-switch">{(['system','light','dark']as const).map(value=><button type="button" className={`theme-choice ${mode===value?'selected':''}`} key={value} aria-pressed={mode===value} disabled={busy} onClick={()=>void saveSelection(selectionForFamilyMode(family?.id,value))}><span>{value==='system'?(zh?'跟随系统':'System'):value==='light'?(zh?'浅色':'Light'):(zh?'深色':'Dark')}</span></button>)}</div></div>
   <div className="theme-gallery" aria-label={zh?'现成主题':'Ready-made themes'}>{(['light','dark']as const).map(group=><section className="theme-gallery-section" key={group} aria-label={group==='light'?(zh?'浅色主题':'Light themes'):(zh?'深色主题':'Dark themes')}><div className="theme-gallery-title">{group==='light'?(zh?'浅色':'Light'):(zh?'深色':'Dark')}</div><div className="theme-gallery-grid">{THEME_PRESETS.filter(preset=>preset.mode===group).map(preset=><ThemeCard key={preset.id} preset={preset} selected={isPresetSelected(selection,preset,systemDark)} zh={zh} disabled={busy} onSelect={()=>void saveSelection(selectionForPreset(preset,mode??preset.mode))}/>)}</div></section>)}</div>
  </div>
  <SettingsColorEditor key={selection} settings={settings} zh={zh} update={updateThemes}/>
  <SettingsBackgrounds settings={settings} zh={zh} update={update}/>
  <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{zh?'主题包':'Theme packs'}</div><p>{zh?'导入主题包，或将自定义主题及图片一起导出。':'Import theme packs or export custom themes with their pictures.'}</p></div><div className="inline-actions"><button className="btn" onClick={()=>{setIssue(undefined);setImportOpen(true);}}>{zh?'导入主题':'Import theme'}</button><button className="btn" disabled={busy||!Object.keys(themes).length} title={!Object.keys(themes).length?(zh?'没有可导出的自定义主题。':'There are no custom themes to export.'):undefined} onClick={()=>void run(async()=>{setNotice(undefined);const saved=await exportFile('theme');if(saved)setNotice(`${zh?'主题已保存到':'Themes saved to'}: ${saved.path}${saved.missingImages?.length?`${zh?'。已跳过缺失图片':'. Skipped missing pictures'}: ${saved.missingImages.join(', ')}`:''}`);})}>{zh?'导出主题':'Export theme'}</button></div></div><ul className="theme-list">{Object.entries(themes).map(([name,tokens])=><li className={`theme-pack${selection===`custom:${name}`?' is-on':''}`} key={name}><button className="theme-pack-main" aria-pressed={selection===`custom:${name}`} disabled={busy} onClick={()=>void run(()=>update({themeSelection:`custom:${name}`}))}><i style={{background:tokens.accent}}/><span>{name}</span></button><SettingsThemeDelete name={name} themes={themes} selection={selection} zh={zh} disabled={busy} update={updateThemes}/></li>)}{!Object.keys(themes).length&&<li className="theme-pack is-empty">{zh?'尚无自定义主题':'No custom themes'}</li>}</ul></div>
  <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{zh?'显示语言':'Display language'}</div><p>{zh?'切换所有窗口的界面语言。':'Change the interface language across your windows.'}</p></div><Select className="settings-select" disabled={busy} value={zh?'zh-CN':'en'} onChange={event=>void run(()=>update({language:event.target.value}))}><option value="zh-CN">中文</option><option value="en">English</option></Select></div></div>
  {notice&&!importOpen&&<p className="hint background-pack-notice" data-testid="background-import-result" role="status">{notice}</p>}
  {issue&&!importOpen&&<p className="surface-error" role="alert">{issue}</p>}
  {importOpen&&<SurfaceDialog className="settings-theme-import" title={zh?'导入主题':'Import theme'} onClose={()=>{if(!busy)setImportOpen(false);}} size="sm" footer={<><button className="btn" disabled={busy} onClick={()=>setImportOpen(false)}>{zh?'取消':'Cancel'}</button><button className="btn btn-primary" disabled={busy} onClick={()=>void run(importPack)}>{zh?'验证并导入':'Validate & import'}</button></>}><label>{zh?'主题 JSON':'Theme JSON'}<textarea className="settings-theme-json" value={source} disabled={busy} onChange={event=>setSource(event.target.value)} rows={9} placeholder='{"name":"Ocean","accent":"#5db9ff"}'/></label><button type="button" className="btn" disabled={busy} onClick={()=>fileInput.current?.click()}>{zh?'从文件读取':'Read from a file'}</button><input ref={fileInput} className="theme-file-input" hidden aria-label={zh?'从文件读取主题 JSON':'Read theme JSON from a file'} type="file" accept="application/json" onChange={event=>{const file=event.target.files?.[0];if(file)void file.text().then(setSource).catch(error=>setIssue(appearanceErrorMessage(error,zh)));event.target.value='';}}/>{issue&&<p className="surface-error" role="alert">{issue}</p>}</SurfaceDialog>}
 </>;
}
