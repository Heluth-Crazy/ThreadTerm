// Copy immutable SVG constants only, never the prototype application/mock state.
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('reference/prototype/app.js',root),'utf8');
const extract = (start,end,name) => vm.runInNewContext(`${source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)))}; ${name}`,Object.create(null),{timeout:1000});
const icons=extract('const ICONS =','const icon =','ICONS');
const brands=extract('const AGENT_BRAND =','function agentIcon','AGENT_BRAND');
const extras=extract('const extra =','const body = AGENT_BRAND','extra');
Object.assign(icons,{flow:'<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6M6 9v9h9"/>',globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',image:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m4 17 5-5 3 3 2-2 6 4"/>',plug:'<path d="M8 3v6M16 3v6M6 9h12v3a6 6 0 0 1-6 6v3M12 18v3"/>',wrench:'<path d="M14 6a5 5 0 0 0-6 6L3 17l4 4 5-5a5 5 0 0 0 6-6l-3 3-3-3z"/>',agents:'<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 16a5 5 0 0 1 7 4"/>',minimize:'<path d="M5 12h14"/>',maximize:'<rect x="5" y="5" width="14" height="14"/>',arrowUp:'<path d="M12 19V5M5 12l7-7 7 7"/>',send:'<path d="M21 3 3 10.5l7.5 3 3 7.5z"/><path d="M21 3 10.5 13.5"/>'});
Object.assign(brands,extras);
const normalized=Object.fromEntries(Object.entries(brands).map(([name,value])=>[name.toLowerCase(),value.replaceAll('stopColor=','stop-color=').replaceAll('stopOpacity=','stop-opacity=')]));
// White marks for Rex-style tiles (not derived from the prototype brand fills).
const tileMarks={
  claude:'<path fill="#fff" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
  codex:'<path fill="#fff" d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"/>',
  kimi:'<path fill="#3B9BFF" d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"/><path fill="#fff" d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"/>',
  grok:'<path fill="#fff" fill-rule="evenodd" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/>',
  opencode:'<path fill="#fff" fill-rule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/>',
  shell:'<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="m6 8 4.5 4L6 16M12.5 16.5h6"/>',
};
const tileFill={
  claude:'linear-gradient(180deg,#E8947A,#D3694A)',
  codex:'linear-gradient(180deg,#A99CFF,#6476FF 55%,#3D46F2)',
  gemini:'linear-gradient(180deg,#FFFFFF,#EEEEF2)',
  kimi:'linear-gradient(180deg,#34343A,#111114)',
  grok:'linear-gradient(180deg,#3A3A3F,#0E0E10)',
  opencode:'linear-gradient(180deg,#4A4441,#211E1D)',
};
await writeFile(new URL('renderer/src/components/PrototypeIcon.tsx',root),`import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type SVGProps } from 'react';
import type { ProviderCapability, Session } from '@threadterm/protocol';
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

/** Which provider a session row should show: the agent detected in a plain terminal, else its own. */
export function sessionIconProvider(session: Pick<Session, 'provider' | 'terminalAgent'>): string {
  return session.terminalAgent ?? session.provider;
}

// White marks for brand tiles; gemini keeps its colour mark. Static constants only.
const tileMarks: Record<string, string> = ${JSON.stringify(tileMarks,null,2)};
const tileMarkHtml = Object.fromEntries(Object.entries(tileMarks).map(([name, __html]) => [name, Object.freeze({ __html })]));
const tileFill: Record<string, string> = ${JSON.stringify(tileFill,null,2)};
const BRAND_TILES = new Set(['claude', 'codex', 'gemini', 'kimi', 'grok', 'opencode']);

/** Rex-style tactile session tile. Brand fills are fixed; edge/sheen/shadow come from theme vars. */
export function AgentTile({ provider, size = 16, animate = false }: { provider: string; size?: number; animate?: boolean }) {
  const capabilities = useAgentCapabilities();
  const icon = capabilities.find(capability => capability.id === provider)?.icon;
  const name = provider.toLowerCase().replace(' code', '');
  const brand = BRAND_TILES.has(name);
  const shell = !brand;
  const style: CSSProperties = {
    ['--s' as string]: \`\${size}px\`,
    ...(brand && tileFill[name] ? { ['--tile-bg' as string]: tileFill[name] } : null),
  };
  const className = [
    'agent-tile',
    shell ? 'agent-tile-shell' : \`agent-tile-\${name}\`,
    name === 'codex' ? 'agent-tile-codex-mark' : '',
    name === 'opencode' ? 'agent-tile-opencode-mark' : '',
    name === 'gemini' ? 'agent-tile-gemini-mark' : '',
    animate ? 'agent-tile-pop' : '',
  ].filter(Boolean).join(' ');

  let body: ReactNode;
  if (shell && icon?.startsWith('data:image/')) {
    body = <img src={icon} alt="" />;
  } else if (name === 'gemini') {
    body = <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={brandHtml.gemini} />;
  } else if (brand && Object.hasOwn(tileMarkHtml, name)) {
    body = <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={tileMarkHtml[name]} />;
  } else {
    body = <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={tileMarkHtml.shell} />;
  }

  return <span className={className} style={style} data-agent-tile={name} aria-hidden="true">{body}</span>;
}

/** Session-identifying tile with a one-shot pop when the visible provider changes. */
export function SessionIcon({ session, size }: { session: Pick<Session, 'provider' | 'terminalAgent'>; size?: number }) {
  const provider = sessionIconProvider(session);
  const previous = useRef<string | undefined>(undefined);
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    if (previous.current !== undefined && previous.current !== provider) {
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduce) {
        setAnimate(false);
        const frame = requestAnimationFrame(() => setAnimate(true));
        const timer = window.setTimeout(() => setAnimate(false), 300);
        previous.current = provider;
        return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
      }
    }
    previous.current = provider;
  }, [provider]);
  return <AgentTile provider={provider} size={size} animate={animate} />;
}
`,'utf8');
