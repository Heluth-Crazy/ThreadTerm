import type { PageShot } from '@threadterm/protocol';

/** Renderer-to-main contract for person-initiated page handoffs. */
export type BrowserHandoffCommand =
 | { type:'capture'; tabId:string; documentGeneration:number }
 | { type:'saveMarkup'; tabId:string; documentGeneration:number; shotId:string; dataUrl:string }
 | { type:'console'; tabId:string; documentGeneration:number }
 | { type:'preferences'; patch?:{devServerOffers?:boolean} };
export type BrowserConsoleEntry = { level:string; text:string; sourceUrl:string; line:number };
export type BrowserConsoleResult = { url:string; documentGeneration:number; entries:BrowserConsoleEntry[]; errors:number; warnings:number; truncated:boolean; text:string };
export type BrowserCaptureResult = { shot:PageShot; dataUrl:string; url:string; documentGeneration:number; width:number; height:number };
export type BrowserHandoffResult = BrowserCaptureResult|BrowserConsoleResult|{devServerOffers:boolean};
export type BrowserHandoffEvent = { type:'console'; tabId:string; documentGeneration:number; errors:number; warnings:number }|{type:'preferences';devServerOffers:boolean};
export interface BrowserHandoffBridge { browserHandoff(command:BrowserHandoffCommand):Promise<BrowserHandoffResult>; onBrowserHandoffEvent(listener:(event:BrowserHandoffEvent)=>void):()=>void }
