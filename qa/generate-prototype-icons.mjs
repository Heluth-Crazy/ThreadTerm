// Copy immutable SVG constants only, never the prototype application/mock state.
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('reference/prototype/app.js',root),'utf8');
const extract = (start,end,name) => vm.runInNewContext(`${source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)))}; ${name}`,Object.create(null),{timeout:1000});
const icons=extract('const ICONS =','const icon =','ICONS');
const brands=extract('const AGENT_BRAND =','function agentIcon','AGENT_BRAND');
const extras=extract('const extra =','const body = AGENT_BRAND','extra');
Object.assign(icons,{minimize:'<path d="M5 12h14"/>',maximize:'<rect x="5" y="5" width="14" height="14"/>',arrowUp:'<path d="M12 19V5M5 12l7-7 7 7"/>'});
Object.assign(brands,extras);
const normalized=Object.fromEntries(Object.entries(brands).map(([name,value])=>[name.toLowerCase(),value.replaceAll('stopColor=','stop-color=').replaceAll('stopOpacity=','stop-opacity=')]));
await writeFile(new URL('renderer/src/components/PrototypeIcon.tsx',root),`import { createContext, useContext, type ReactNode, type SVGProps } from 'react';
import type { ProviderCapability } from '@threadterm/protocol';
// Static SVG constants copied verbatim from the approved immutable reference.
// Never pass user text into these markup maps.
const icons: Record<string,string> = ${JSON.stringify(icons,null,2)};
const brands: Record<string,string> = ${JSON.stringify(normalized,null,2)};
const aliases: Record<string,string> = {settings:'gear',chevron:'chevD',grid:'terminal','chevron-left':'back','chevron-right':'chevR'};
// Stable innerHTML props keep pressed SVG children mounted during pane activation.
const iconHtml=Object.fromEntries(Object.entries(icons).map(([name,__html])=>[name,Object.freeze({__html})]));
const brandHtml=Object.fromEntries(Object.entries(brands).map(([name,__html])=>[name,Object.freeze({__html})]));
export function Icon({name,className,...props}:{name:string;className?:string}&SVGProps<SVGSVGElement>){
  return <svg className={['ico',className].filter(Boolean).join(' ')} viewBox="0 0 24 24" aria-hidden="true" {...props} dangerouslySetInnerHTML={iconHtml[aliases[name]??name]??iconHtml.file}/>;
}
/** Raw SVG body of an agent's brand mark for non-React surfaces (the launch screen); static constants only. */
export function agentIconMarkup(provider:string):string|undefined{return Object.hasOwn(brands,provider)?brands[provider]:undefined;}
const AgentIconsContext = createContext<readonly ProviderCapability[]>([]);
export function AgentIconsProvider({providers,children}:{providers:readonly ProviderCapability[];children:ReactNode}){
  return <AgentIconsContext.Provider value={providers}>{children}</AgentIconsContext.Provider>;
}
export function useAgentCapabilities(){return useContext(AgentIconsContext);}
export function AgentIcon({provider,size}:{provider:string;size?:number}){
  const capabilities=useAgentCapabilities(); const icon=capabilities.find(capability=>capability.id===provider)?.icon;
  const name=provider.toLowerCase().replace(' code',''); const body=Object.hasOwn(brands,name)?brands[name]:undefined;
  // Plugin icons arrive as data URLs from the runtime; anything else (a remote URL) is never fetched.
  if(!body&&icon?.startsWith('data:image/'))return <img className="brand-ico" src={icon} alt="" data-agent-icon={provider} style={size === undefined ? undefined : {width:size,height:size}}/>;
  if(!body)return <Icon name="terminal" className="brand-ico" style={size === undefined ? undefined : {width:size,height:size}}/>;
  return <svg className="brand-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-agent-icon={name} style={size === undefined ? undefined : {width:size,height:size}} dangerouslySetInnerHTML={brandHtml[name]}/>;
}
`,'utf8');
