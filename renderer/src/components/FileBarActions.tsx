import { useContext } from 'react';
import { Icon } from './PrototypeIcon';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';

/** File actions share the pane menu; standalone file hosts get the same menu locally. */
export function FileBarActions({items,zh}:{items:ContextMenuItem[];zh:boolean}) {
 const surface=useContext(SessionSurfaceContext);
 if(!surface)return <button type="button" className="cg-ghost cg-icon cg-sm file-bar-more" aria-label={zh?'工作区操作':'Workspace actions'} title={zh?'工作区操作':'Workspace actions'} aria-haspopup="menu" onClick={event=>{const anchor=event.currentTarget,rect=anchor.getBoundingClientRect();showContextMenu({x:rect.right,y:rect.bottom,items,restoreFocus:anchor});}}><Icon name="more"/></button>;
 return <SurfaceActions slot="menu">{items.map(item=><button key={item.id} type="button" className="menu-item" onClick={()=>void item.onSelect?.()}>{item.icon}{item.label}</button>)}</SurfaceActions>;
}

/** Cursor's breadcrumbs: one quiet segment per folder, then the file. A symbol segment is only added when the
 * editor knows one; today it does not, so the file is the last segment (kept reachable as the title/aria-label). */
export function FileBreadcrumb({path}:{path:string}) {
 const parts=path.split(/[\\/]/),name=parts.pop()??path;
 return <span className="path file-bar-breadcrumb" title={path} aria-label={path}>
  {parts.map((part,index)=><span key={`${index}:${part}`} className="file-bar-crumb"><span className="file-bar-crumb-label">{part}</span><Icon name="chevR" className="file-bar-crumb-sep"/></span>)}
  <span className="file-bar-name">{name}</span>
 </span>;
}
