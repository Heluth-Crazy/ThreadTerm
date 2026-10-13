import { useState } from 'react';
import type { PiTrustState } from '@threadterm/protocol';
import { piTrustSource, showPiTrustBanner } from '../piTrust';
import { SurfaceDialog } from './SurfaceDialog';
import './pi-project-trust.css';

export function PiProjectTrust({ trust, disabled, disabledReason, onDecide, copy }: { trust?: PiTrustState; disabled: boolean; disabledReason?: string; onDecide: (decision: 'trusted'|'declined') => void; copy: (en:string,zh:string)=>string }) {
 const [open,setOpen]=useState(false);
 if(!showPiTrustBanner(trust) || !trust)return null;
 const blocked=disabled;
 return <><aside className="pi-project-trust" role="status"><span>{copy("This project's Pi settings and extensions are not loaded.", '此项目的 Pi 设置和扩展未加载。')}</span><button className="btn btn-sm" type="button" onClick={()=>setOpen(true)}>{copy('Review','查看')}</button></aside>{open&&<SurfaceDialog title={copy('Review Pi project resources','查看 Pi 项目资源')} onClose={()=>setOpen(false)} size="sm" footer={<><button className="btn btn-sm" onClick={()=>setOpen(false)}>{copy('Cancel','取消')}</button><button className="btn btn-sm" disabled={blocked} onClick={()=>onDecide('declined')}>{copy('Keep unloaded','保持未加载')}</button><button className="btn btn-sm btn-primary" disabled={blocked} onClick={()=>onDecide('trusted')}>{copy('Trust project','信任项目')}</button></>}><p>{copy('Extensions run code at startup with your account permissions. Trust does not sandbox the agent.', '扩展会在启动时使用您的账户权限运行代码。信任不会沙箱化代理。')}</p><p className="pi-project-trust-disabled">{copy('This chat restarts. Other open Pi chats use this decision when they reconnect.', '此对话将重新启动，其他已打开的 Pi 对话会在重新连接时应用此决定。')}</p><ul className="pi-project-trust-list">{trust.protectedResources.map(path=><li key={path}><code>{path}</code></li>)}</ul>{blocked&&<p className="pi-project-trust-disabled">{disabledReason ?? copy('Stop the current turn before reconnecting.', '请先停止当前回合再重新连接。')}</p>}</SurfaceDialog>}</>;
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
