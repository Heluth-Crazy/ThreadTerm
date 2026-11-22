import type { PagePick, PageShot } from '@threadterm/protocol';

/** Renderer-to-main contract for person-initiated page handoffs. */
export type BrowserHandoffCommand =
 | { type:'capture'; tabId:string; documentGeneration:number }
 | { type:'contextCapture'; tabId:string; documentGeneration:number; contextSequence:number }
 | { type:'saveMarkup'; tabId:string; documentGeneration:number; shotId:string; dataUrl:string }
 | { type:'console'; tabId:string; documentGeneration:number }
 | { type:'preferences'; patch?:{devServerOffers?:boolean} };
export type BrowserConsoleEntry = { level:string; text:string; sourceUrl:string; line:number };
export type BrowserConsoleResult = { url:string; documentGeneration:number; entries:BrowserConsoleEntry[]; errors:number; warnings:number; truncated:boolean; text:string };
export type BrowserCaptureResult = { shot:PageShot; dataUrl:string; url:string; documentGeneration:number; width:number; height:number; /** CSS-pixel viewport when the capture was made; optional for older/mock bridges. */ viewport?:{width:number;height:number} };
/** A cropped page-comment image. It is issued only for the current native context click. */
export type BrowserContextCaptureResult = { shot:PageShot; pick:PagePick; documentGeneration:number; contextSequence:number };
export type BrowserHandoffResult = BrowserCaptureResult|BrowserContextCaptureResult|BrowserConsoleResult|{devServerOffers:boolean};
export type BrowserHandoffEvent = { type:'console'; tabId:string; documentGeneration:number; errors:number; warnings:number }|{type:'preferences';devServerOffers:boolean};
export type BrowserHandoffResultFor<C extends BrowserHandoffCommand> = C extends {type:'contextCapture'} ? BrowserContextCaptureResult : Exclude<BrowserHandoffResult,BrowserContextCaptureResult>;
export interface BrowserHandoffBridge { browserHandoff<C extends BrowserHandoffCommand>(command:C):Promise<BrowserHandoffResultFor<C>>; onBrowserHandoffEvent(listener:(event:BrowserHandoffEvent)=>void):()=>void }
