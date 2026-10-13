import { useState } from 'react';
import type { PiTrustState } from '@threadterm/protocol';
import { piTrustSource, showPiTrustBanner } from '../piTrust';
import { SurfaceDialog } from './SurfaceDialog';
import './pi-project-trust.css';

export function PiProjectTrust({ trust, disabled, disabledReason, onDecide, copy }: { trust?: PiTrustState; disabled: boolean; disabledReason?: string; onDecide: (decision: 'trusted'|'declined') => void; copy: (en:string,zh:string)=>string }) {
 const [open,setOpen]=useState(false);
 if(!showPiTrustBanner(trust) || !trust)return null;
 const outside=(trust as PiTrustState & {outsideProtectedResources?: Array<{path:string;target:string}>}).outsideProtectedResources??[];
 const blocked=disabled;
 return <><aside className="pi-project-trust" role="status"><span>{copy("This project's Pi settings and extensions are not loaded.", '此项目的 Pi 设置和扩展未加载。')}</span><button className="btn btn-sm" type="button" onClick={()=>setOpen(true)}>{copy('Review','查看')}</button></aside>{open&&<SurfaceDialog title={copy('Review Pi project resources','查看 Pi 项目资源')} onClose={()=>setOpen(false)} size="sm" className="pi-project-trust-dialog" footer={<><button className="btn btn-sm" onClick={()=>setOpen(false)}>{copy('Cancel','取消')}</button><button className="btn btn-sm" disabled={blocked} onClick={()=>onDecide('declined')}>{copy('Keep unloaded','保持未加载')}</button><button className="btn btn-sm btn-primary" disabled={blocked} onClick={()=>onDecide('trusted')}>{copy('Trust project','信任项目')}</button></>}><p>{copy('Extensions run code at startup with your account permissions. Trust does not sandbox the agent.', '扩展会在启动时使用您的账户权限运行代码。信任不会沙箱化代理。')}</p><p className="pi-project-trust-disabled">{copy('Trusting restarts this chat. Keeping resources unloaded restarts every idle Pi chat in this project; stop active turns in other chats first.', '信任后会重启此对话。保持未加载会重启此项目中所有空闲的 Pi 对话；请先停止其他对话的活动回合。')}</p>{trust.protectedResources.length>0&&<><p>{copy('Protected resources in this project:', '此项目中的受保护资源：')}</p><ul className="pi-project-trust-list">{trust.protectedResources.map(path=><li key={path}><code>{path}</code></li>)}</ul></>}{outside.length>0&&<><p>{copy('Resources and links outside the project:', '项目外部资源和链接：')}</p><ul className="pi-project-trust-list">{outside.map(resource=><li key={`${resource.path}:${resource.target}`}><code>{resource.path}</code><span> → </span><code>{resource.target}</code></li>)}</ul></>}{blocked&&<p className="pi-project-trust-disabled">{disabledReason ?? copy('Stop the current turn before reconnecting.', '请先停止当前回合再重新连接。')}</p>}</SurfaceDialog>}</>;
}

/** C3's connection popover can render this until it owns the popover shell. */
export function PiProjectTrustDetails({ trust, disabled, onDecide, copy }: { trust?: PiTrustState; disabled:boolean; onDecide:(decision:'trusted'|'declined'|'none')=>void; copy:(en:string,zh:string)=>string }) {
 if(!trust)return null;
 const source=piTrustSource(trust);
 if(source==='threadterm' && trust.threadtermDecision==='trusted') return <div className="pi-project-trust-details"><span>{copy('Trusted for this project','已信任此项目')}</span><button className="btn btn-sm" disabled={disabled} title={disabled?copy('Stop the current turn before reconnecting.','请先停止当前回合再重新连接。'):undefined} onClick={()=>onDecide('none')}>{copy('Revoke trust','撤销信任')}</button></div>;
 if(source==='threadterm') return <p className="pi-project-trust-details">{copy('Kept unloaded for this project','此项目资源保持未加载')}</p>;
 if(source==='pi' && trust.piDecision==='trusted') return <p className="pi-project-trust-details">{copy('Trusted by Pi','由 Pi 信任')}</p>;
 if(source==='pi') return <p className="pi-project-trust-details">{copy('Kept unloaded by Pi','由 Pi 保持未加载')}</p>;
 return null;
}
