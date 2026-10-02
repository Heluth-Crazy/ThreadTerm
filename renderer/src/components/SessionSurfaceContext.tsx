import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FileReference } from '@threadterm/protocol';

export type SessionSurfacePresentation = {
 primaryHost:HTMLElement|null;
 menuHost:HTMLElement|null;
 focused:boolean;
 openFile?:(reference:FileReference)=>void;
};
export const SessionSurfaceContext=createContext<SessionSurfacePresentation|undefined>(undefined);
export function SurfaceActions({slot,children}:{slot:'primary'|'menu';children:ReactNode}) {
 const surface=useContext(SessionSurfaceContext);
 if(!surface)return <div className={`surface-local-actions surface-local-${slot}`}>{children}</div>;
 const host=slot==='primary'?surface.primaryHost:surface.menuHost;
 return surface.focused&&host?createPortal(children,host):null;
}
