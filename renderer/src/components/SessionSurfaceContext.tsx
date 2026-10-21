import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FileReference, Session } from '@threadterm/protocol';

export type SessionSurfacePresentation = {
 primaryHost:HTMLElement|null;
 menuHost:HTMLElement|null;
 focused:boolean;
 openFile?:(reference:FileReference)=>void;
 /** Opens a working-tree diff for a path inside the session's project, when the host supports it. */
 openDiff?:(path:string)=>void;
 /** Whether `openDiff` can open this exact path; the action stays hidden when it cannot. */
 canOpenDiff?:(path:string)=>boolean;
 /** Opens an http(s) page in a tab beside the session (terminal link bar). */
 openWeb?:(url:string)=>void;
 /** Inserts a newly created fork in this surface's pane. */
 openFork?:(session:Session)=>void;
 openTaskMap?:(sessionId:string,itemId?:string)=>void;
};
export const SessionSurfaceContext=createContext<SessionSurfacePresentation|undefined>(undefined);
export function SurfaceActions({slot,children}:{slot:'primary'|'menu';children:ReactNode}) {
 const surface=useContext(SessionSurfaceContext);
 if(!surface)return <div className={`surface-local-actions surface-local-${slot}`}>{children}</div>;
 const host=slot==='primary'?surface.primaryHost:surface.menuHost;
 return surface.focused&&host?createPortal(children,host):null;
}
