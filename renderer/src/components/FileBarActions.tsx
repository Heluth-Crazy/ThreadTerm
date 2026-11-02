import { useContext } from 'react';
import { Icon } from './PrototypeIcon';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';

/** File actions share the pane menu; standalone file hosts get the same menu locally. */
export function FileBarActions({items,zh}:{items:ContextMenuItem[];zh:boolean}) {
 const surface=useContext(SessionSurfaceContext);
 if(!surface)return <button type="button" className="icon-btn icon-btn-sm file-bar-more" aria-label={zh?'工作区操作':'Workspace actions'} title={zh?'工作区操作':'Workspace actions'} aria-haspopup="menu" onClick={event=>{const anchor=event.currentTarget,rect=anchor.getBoundingClientRect();showContextMenu({x:rect.right,y:rect.bottom,items,restoreFocus:anchor});}}><Icon name="more"/></button>;
 return <SurfaceActions slot="menu">{items.map(item=><button key={item.id} type="button" className="menu-item" onClick={()=>void item.onSelect?.()}>{item.icon}{item.label}</button>)}</SurfaceActions>;
}

export function FileBreadcrumb({path}:{path:string}) {
 const parts=path.split(/[\\/]/),name=parts.pop();
 return <span className="path file-bar-breadcrumb" title={path} aria-label={path}><span className="file-bar-folders">{parts.length?`${parts.join(' › ')} › `:''}</span><span className="file-bar-name">{name}</span></span>;
}
