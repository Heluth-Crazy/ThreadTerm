import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Settings } from '@threadterm/protocol';
import type { BackgroundRecord } from '../../../desktop/src/backgroundImagesCore';
import { resolveTheme, type ThemeBackgroundLayer, type ThemeBackgroundRegion, type ThemeBackgrounds, type ThemeTokens } from '../themes';
import { backgroundRegions, referencedImageIds, resolveBackgrounds } from '../appearance/backgrounds';
import { backgroundImageUrl, ensureBlurVariant, importBackgroundFromPath, importBackgroundFromPicker, listBackgroundImages, removeBackgroundImage } from '../appearance/backgroundPipeline';
import { appearanceErrorMessage, applyBackgroundEdit, backgroundSettingsPatch, defaultBackgroundLayer } from '../appearance/backgroundSettings';
import { endBackgroundPreview, previewBackgrounds } from '../appearance/backgroundPreview';
import { discardUnreferencedImports, pruneRemovedBackgrounds, withBackgroundMutation } from '../appearance/backgroundMutation';
import { request } from '../bridge';
import { Icon } from './PrototypeIcon';
import './settings-backgrounds.css';

const regionLabels: Record<ThemeBackgroundRegion, [string, string]> = { window: ['Window', '窗口'], sidebar: ['Project sidebar', '项目侧栏'], sidebar2: ['Side bar', '侧边栏'], chat: ['Chat', '聊天'], editor: ['Editor', '编辑器'], terminal: ['Terminal', '终端'], browser: ['Browser', '浏览器'] };
const positions = [['top-left','Top left','左上'],['top','Top','上'],['top-right','Top right','右上'],['left','Left','左'],['center','Center','居中'],['right','Right','右'],['bottom-left','Bottom left','左下'],['bottom','Bottom','下'],['bottom-right','Bottom right','右下']] as const;
type SliderKey = 'opacity' | 'blur' | 'overlay' | 'scale';
const sliderLabels: Record<SliderKey, [string, string]> = { opacity: ['Opacity', '不透明度'], blur: ['Blur', '模糊'], overlay: ['Overlay', '遮罩'], scale: ['Scale', '缩放'] };

export function SettingsBackgrounds({settings,zh,update}:{settings:Settings;zh:boolean;update:(patch:Record<string,unknown>)=>Promise<void>}) {
 const [region,setRegion]=useState<ThemeBackgroundRegion>('window'),[records,setRecords]=useState<BackgroundRecord[]>([]),[draft,setDraft]=useState<ThemeBackgrounds>();
 const [busy,setBusy]=useState(false),[issue,setIssue]=useState<string>(),[created,setCreated]=useState<string>(),[raised,setRaised]=useState(false),[dragging,setDragging]=useState(false);
 const owner=useRef(crypto.randomUUID()),pending=useRef<ThemeBackgrounds|undefined>(undefined),tasks=useRef(Promise.resolve()),blocks=useRef(0),version=useRef(0),alive=useRef(true),id=useId();
 const pendingFields=useRef(new Set<keyof ThemeBackgroundLayer>());
 const selection=String(settings.themeSelection??settings.theme??'system'),themes=(settings.customThemes??{}) as Record<string,ThemeTokens>;
 const systemDark=window.matchMedia('(prefers-color-scheme: dark)').matches;
 const theme=useMemo(()=>resolveTheme(selection,{systemDark,customThemes:themes}),[selection,systemDark,settings.customThemes]);
 const saved=themes[theme.custom?theme.name:'']?.backgrounds;
 const backgrounds=draft??saved??{},resolved=useMemo(()=>resolveBackgrounds(theme,backgrounds,records),[theme,backgrounds,records]);
 const value=resolved[region],own=backgrounds[region],layer=own??defaultBackgroundLayer('inherit');
 const inherited=region!=='window'&&(!own||own.image==='inherit'),hasImage=Boolean(value.source),floor=Math.ceil(value.floor*100),effective=Math.round(value.overlay*100);
 const shownLayer=inherited?(value.layer??layer):layer;
 const referenced=referencedImageIds(themes);
 const label=(name:ThemeBackgroundRegion)=>regionLabels[name][zh?1:0];
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;endBackgroundPreview(owner.current);};},[]);
 useEffect(()=>{let live=true;void listBackgroundImages().then(value=>{if(live)setRecords(value);}).catch(error=>{if(live)setIssue(appearanceErrorMessage(error,zh));});return()=>{live=false;};},[settings.customThemes]);
 useEffect(()=>{version.current++;pending.current=undefined;pendingFields.current.clear();setDraft(undefined);setRaised(false);setCreated(name=>selection===`custom:${name}`?name:undefined);endBackgroundPreview(owner.current);},[selection]);
 const run=(action:()=>Promise<void>,block=true)=>{
  const editVersion=version.current;if(block){blocks.current++;setBusy(true);}
  tasks.current=tasks.current.then(async()=>{
   if(alive.current)setIssue(undefined);
   try{await withBackgroundMutation(action);}catch(error){if(alive.current)setIssue(appearanceErrorMessage(error,zh));}
   finally{if(block)blocks.current--;if(version.current===editVersion){endBackgroundPreview(owner.current);if(alive.current)setDraft(undefined);}if(alive.current)setBusy(blocks.current>0);}
  });
  return tasks.current;
 };
 const persist=async(next:ThemeBackgrounds,prune=false,fields?:readonly (keyof ThemeBackgroundLayer)[])=>{
  const current=(await request('runtime.snapshot',{})).settings;
  if(String(current.themeSelection??current.theme??'system')!==selection)throw Error('Background theme changed');
  const currentThemes=(current.customThemes??{}) as Record<string,ThemeTokens>;
  const merged=applyBackgroundEdit(currentThemes[theme.custom?theme.name:'']?.backgrounds,region,next[region],fields);
  const patch=backgroundSettingsPatch(selection,currentThemes,systemDark,merged);
  await update({customThemes:patch.customThemes,themeSelection:patch.themeSelection});
  if(patch.createdName&&alive.current)setCreated(patch.createdName);
  if(prune){await pruneRemovedBackgrounds(currentThemes,patch.customThemes);if(alive.current)setRecords(await listBackgroundImages());}
 };
 const apply=(next:ThemeBackgrounds,prune=false,fields?:readonly (keyof ThemeBackgroundLayer)[])=>{version.current++;setDraft(next);previewBackgrounds(owner.current,next);void run(()=>persist(next,prune,fields),false);};
 const attach=async(importer:()=>Promise<BackgroundRecord|null>)=>{const before=new Set((await listBackgroundImages()).map(record=>record.id));const record=await importer();if(!record)return;setRecords(old=>[...old.filter(item=>item.id!==record.id),record]);try{await persist({...backgrounds,[region]:defaultBackgroundLayer(record.id)});}catch(error){if(!before.has(record.id))await discardUnreferencedImports([record.id]);setRecords(await listBackgroundImages());throw error;}};
 const choose=()=>void run(()=>attach(importBackgroundFromPicker));
 const removeFromLibrary=(record:BackgroundRecord)=>void run(async()=>{const current=(await request('runtime.snapshot',{})).settings.customThemes as Record<string,ThemeTokens>|undefined;if(referencedImageIds(current).has(record.id))throw Error('Picture is in use');await removeBackgroundImage(record.id);setRecords(old=>old.filter(item=>item.id!==record.id));});
 const commit=()=>{
  const next=pending.current;if(!next)return;pending.current=undefined;
  const fields=[...pendingFields.current];pendingFields.current.clear();
  const changed=next[region],record=records.find(item=>item.id===changed?.image),baking=Boolean(changed&&record&&changed.blur>0&&!record.variants[String(changed.blur)]);
  void run(async()=>{if(changed&&record&&baking){const baked=await ensureBlurVariant(record,changed.blur);if(alive.current)setRecords(old=>old.map(item=>item.id===baked.id?baked:item));}await persist(next,false,fields);},baking);
 };
 const edit=(key:SliderKey,number:number)=>{
  const chosen=key==='overlay'?Math.max(floor,number):number;
  if(key==='overlay')setRaised(floor>0&&number<=floor);
  const next={...backgrounds,[region]:{...layer,[key]:chosen}};
  version.current++;
  pendingFields.current.add(key);
  pending.current=next;setDraft(next);
  // Blur is baked once on release. During the gesture the existing cached picture stays visible.
  const preview=key==='blur'?{...next,[region]:{...next[region],blur:own?.blur??0}}:next;
  previewBackgrounds(owner.current,preview);
 };
 const imageName=(name:ThemeBackgroundRegion)=>{const row=resolved[name];return row.source==='window'?(zh?'窗口图片':'Window picture'):records.find(item=>item.id===row.layer?.image)?.name??(zh?'无':'None');};
 const focusKey=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
  const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:event.key==='ArrowDown'?3:event.key==='ArrowUp'?-3:0;
  if(!delta&&event.key!=='Home'&&event.key!=='End')return;
  event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?8:Math.max(0,Math.min(8,index+delta));
  const button=event.currentTarget.parentElement?.children[next] as HTMLButtonElement|undefined;button?.focus();button?.click();
 };
 const slider=(key:SliderKey)=>{const title=sliderLabels[key][zh?1:0],number=key==='overlay'?effective:shownLayer[key],unit=key==='blur'?'px':'%';return <div className="background-slider-row" key={key}>
  <label htmlFor={`${id}-${key}`}>{title}</label><input id={`${id}-${key}`} data-testid={`background-${key}`} type="range" min={key==='scale'?50:key==='overlay'?floor:0} max={key==='blur'?40:key==='scale'?200:100} step={1} value={number} disabled={busy||!hasImage||(inherited&&key!=='overlay')} aria-valuetext={`${number} ${unit}`} aria-describedby={key==='overlay'?`${id}-floor`:undefined} onInput={event=>edit(key,Number(event.currentTarget.value))} onPointerUp={commit} onPointerCancel={commit} onBlur={commit} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Enter'].includes(event.key))commit();}}/><output htmlFor={`${id}-${key}`}>{number} {unit}</output>
 </div>;};
 return <section className={`settings-card settings-backgrounds${dragging?' is-dragging':''}`} data-testid="settings-backgrounds" aria-labelledby={`${id}-title`} aria-busy={busy} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.stopPropagation();setDragging(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false);}} onDrop={event=>{event.preventDefault();event.stopPropagation();setDragging(false);const file=event.dataTransfer.files[0];if(!file||busy)return;void run(()=>attach(async()=>{const native=window.threadterm as typeof window.threadterm&{getPathForFile?:(file:File)=>string};const path=native.getPathForFile?.(file);if(!path)throw Error('background_image_unreadable');return importBackgroundFromPath(path);}));}}>
  <div className="settings-card-title" id={`${id}-title`}>{zh?'背景图片':'Background images'}</div>
  <p className="hint">{zh?'图片随主题保存。选择区域或将图片拖到此处。':'Pictures save with your theme. Select a region or drop an image here.'}</p>
  {created&&<p className="background-notice" role="status" data-testid="background-custom-copy-notice">{zh?`已创建并选中 ${created}。`:`Created and selected ${created}.`}</p>}
  <div className="background-layout"><div className="background-region-list" role="group" aria-label={zh?'背景区域':'Background regions'}>{backgroundRegions.map(name=><div key={name} data-bg-region={name}><button type="button" data-testid={`background-region-${name}`} className="background-region" aria-pressed={region===name} disabled={busy} onClick={()=>{commit();setRegion(name);setRaised(false);}}><span className="background-thumbnail" aria-hidden="true">{resolved[name].layer&&<img src={backgroundImageUrl(resolved[name].layer!.image)} alt=""/>}</span><span className="background-region-copy"><b>{label(name)}</b><small>{imageName(name)}</small><small>{zh?'遮罩':'Overlay'} {Math.round(resolved[name].overlay*100)} %</small></span></button></div>)}</div>
   <div className="background-controls" role="group" aria-label={label(region)}>
    <div className="background-controls-heading"><b>{label(region)}</b>{busy&&<span role="status">{zh?'正在处理…':'Processing…'}</span>}</div>
    <div className="background-actions"><button type="button" className="btn" data-testid="background-choose" disabled={busy} onClick={choose}>{zh?'选择图片…':'Choose image…'}</button>{region!=='window'&&<button type="button" className="btn" data-testid="background-inherit" disabled={busy||own?.image==='inherit'} onClick={()=>apply({...backgrounds,[region]:defaultBackgroundLayer('inherit')},Boolean(own&&own.image!=='inherit'))}>{zh?'使用窗口图片':'Use window picture'}</button>}<button type="button" className="btn" data-testid="background-remove" disabled={busy||!own} onClick={()=>{const next={...backgrounds};delete next[region];apply(next,true);}}>{zh?'移除':'Remove'}</button></div>
    {slider('opacity')}{slider('blur')}{slider('overlay')}
    <p id={`${id}-floor`} className={`background-floor${value.raised||raised?' is-raised':''}`} data-testid="background-floor-note" role="status">{hasImage?(value.raised||raised?(zh?`已提高至 ${effective} %，以保持文字清晰可读。`:`Raised to ${effective} % so text stays readable`):(zh?`可读性最低遮罩：${floor} %。`:`Readability minimum: ${floor} % overlay.`)):(zh?'选择图片后将自动保护文字对比度。':'Choose an image to automatically protect text contrast.')}</p>
    <div className="background-fit-row"><span id={`${id}-fit`}>{zh?'适配':'Fit'}</span><div className="background-segmented" role="group" aria-labelledby={`${id}-fit`}>{(['cover','contain','tile']as const).map((fit,index)=><button type="button" className="btn" key={fit} data-testid={`background-fit-${['fill','fit','tile'][index]}`} aria-pressed={shownLayer.fit===fit} disabled={busy||!hasImage||inherited} onClick={()=>apply({...backgrounds,[region]:{...layer,fit}},false,['fit'])}>{(zh?['填充','适应','平铺']:['Fill','Fit','Tile'])[index]}</button>)}</div></div>
    <div className="background-focus-row"><span id={`${id}-focus`}>{zh?'焦点':'Focus'}</span><div className="background-focus-grid" role="group" aria-labelledby={`${id}-focus`}>{positions.map(([key,en,cn],index)=>{const x=index%3*50,y=Math.floor(index/3)*50,selected=shownLayer.focusX===x&&shownLayer.focusY===y;return <button type="button" className="btn" key={key} data-testid={`background-focus-${key}`} aria-label={zh?cn:en} title={zh?cn:en} aria-pressed={selected} disabled={busy||!hasImage||inherited} onKeyDown={event=>focusKey(event,index)} onClick={()=>apply({...backgrounds,[region]:{...layer,focusX:x,focusY:y}},false,['focusX','focusY'])}><span aria-hidden="true"/></button>;})}</div>{inherited&&<small>{zh?'图片位置与模糊跟随窗口。':'Placement and blur follow the window.'}</small>}</div>
    {slider('scale')}
    {region==='browser'&&<p className="hint">{zh?'覆盖浏览器工具栏和空白页面；网站会绘制自己的背景。':'Covers the browser toolbar and blank pages; websites draw their own background.'}</p>}
   </div>
  </div>
  <div className="background-library"><b>{zh?'图片库':'Image library'}</b><div className="background-library-strip">{records.map(record=><div className="background-library-item" key={record.id}><button type="button" className="btn" data-testid={`background-library-image-${record.id}`} disabled={busy} aria-label={`${zh?'使用':'Use'} ${record.name}`} title={record.name} aria-pressed={own?.image===record.id} onClick={()=>apply({...backgrounds,[region]:defaultBackgroundLayer(record.id)})}><img src={backgroundImageUrl(record.id)} alt="" loading="lazy" decoding="async"/><span>{record.name}</span></button><button type="button" className="icon-btn" disabled={busy||referenced.has(record.id)} aria-label={`${zh?'从图片库移除':'Remove from library'} ${record.name}`} title={referenced.has(record.id)?(zh?'主题仍在使用此图片。':'A theme still uses this picture.'):(zh?'从图片库移除':'Remove from library')} onClick={()=>removeFromLibrary(record)}><Icon name="close"/></button></div>)}</div>{!records.length&&<p className="hint">{zh?'导入的图片会显示在此处，可供其他区域使用。':'Imported pictures appear here to reuse in other regions.'}</p>}</div>
  {issue&&<p className="surface-error" role="alert">{issue}</p>}
 </section>;
}
