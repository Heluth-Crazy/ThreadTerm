import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './PrototypeIcon';
import { useTranslation } from '../i18n';
import { useModalFocus } from "../useModalFocus";

export function SurfaceDialog({title,subtitle,icon,children,footer,onClose,size='md',variant,className=''}:{title:string;subtitle?:string;icon?:string;children:ReactNode;footer?:ReactNode;onClose:()=>void;size?:'sm'|'md'|'wide';variant?:'create'|'plain';className?:string}) {
  const id=useId(), panel=useRef<HTMLElement>(null), close=useRef<HTMLButtonElement>(null), callback=useRef(onClose);
  callback.current=onClose;
  const {locale}=useTranslation();
  useModalFocus(panel,onClose);
  return createPortal(<div className={`overlay runtime-overlay${variant?'':' sheet-overlay'}`} onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={panel} tabIndex={-1} className={`dialog ${variant==='plain'?(size==='wide'?'wide':''):variant==='create'?'create-dlg':`sheet sheet-${size}${size==='wide'?' wide':''}`} ${className}`} role="dialog" aria-modal="true" aria-labelledby={id}><header className={`dlg-head ${variant==='plain'?'':variant==='create'?'create-head':'sheet-head'}`}>{icon&&<span className="sheet-icon sheet-icon-primary"><Icon name={icon}/></span>}<span className="sheet-head-text"><span className="sheet-head-row"><h2 id={id}>{title}</h2></span>{subtitle&&<p>{subtitle}</p>}</span><button ref={close} className="icon-btn" onClick={onClose} aria-label={`${locale==='zh-CN'?'关闭':'Close '}${title}`}><Icon name="close"/></button></header><div className="dlg-body">{children}</div>{footer&&<footer className="dlg-foot">{footer}</footer>}</section></div>,document.body);
}
