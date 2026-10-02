// Copy immutable SVG constants only, never the prototype application/mock state.
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('reference/prototype/app.js',root),'utf8');
const extract = (start,end,name) => vm.runInNewContext(`${source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)))}; ${name}`,Object.create(null),{timeout:1000});
const icons=extract('const ICONS =','const icon =','ICONS');
const brands=extract('const AGENT_BRAND =','function agentIcon','AGENT_BRAND');
const extras=extract('const extra =','const body = AGENT_BRAND','extra');
Object.assign(icons,{minimize:'<path d="M5 12h14"/>',maximize:'<rect x="5" y="5" width="14" height="14"/>'});
Object.assign(brands,extras);
const normalized=Object.fromEntries(Object.entries(brands).map(([name,value])=>[name.toLowerCase(),value.replaceAll('stopColor=','stop-color=').replaceAll('stopOpacity=','stop-opacity=')]));
await writeFile(new URL('renderer/src/components/PrototypeIcon.tsx',root),`import type { SVGProps } from 'react';
// Static SVG constants copied verbatim from the approved immutable reference.
// Never pass user text into these markup maps.
const icons: Record<string,string> = ${JSON.stringify(icons,null,2)};
const brands: Record<string,string> = ${JSON.stringify(normalized,null,2)};
const aliases: Record<string,string> = {settings:'gear',chevron:'chevD',grid:'terminal','chevron-left':'back','chevron-right':'chevR'};
export function Icon({name,className,...props}:{name:string;className?:string}&SVGProps<SVGSVGElement>){
  return <svg className={['ico',className].filter(Boolean).join(' ')} viewBox="0 0 24 24" aria-hidden="true" {...props} dangerouslySetInnerHTML={{__html:icons[aliases[name]??name]??icons.file}}/>;
}
export function AgentIcon({provider,size=16}:{provider:string;size?:number}){
  const name=provider.toLowerCase().replace(' code',''); const body=brands[name];
  if(!body)return <Icon name="terminal" className="brand-ico" style={{width:size,height:size}}/>;
  return <svg className="brand-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-agent-icon={name} style={{width:size,height:size}} dangerouslySetInnerHTML={{__html:body}}/>;
}
`,'utf8');
