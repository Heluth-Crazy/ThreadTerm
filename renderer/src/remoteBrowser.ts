export function remoteLoopbackUrl(value:string):boolean {
 try {const url=new URL(value),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');return ['http:','https:'].includes(url.protocol)&&(host==='localhost'||host.endsWith('.localhost')||/^127(?:\.\d{1,3}){3}$/.test(host)||host==='::1'||/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host));}catch{return false;}
}
/** A remote address must never become an iframe in the unproxied application session. */
export function previewAddress(address:string,remote:boolean,openPanel:(url:string)=>void,setIframe:(url:string)=>void):string {
 const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw new Error('Use an HTTP or HTTPS address.');
 if(remote)openPanel(url.href);else setIframe(url.href);
 return url.href;
}

/** A sign-in page opens in that computer's panel browser only when its callback is a literal loopback address.
 * Google forbids embedded sign-in; leave its normal route (and explicit preview choice) alone. */
export function isRemoteSignInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || host === 'google.com' || host.endsWith('.google.com')) return false;
    for (const [name, value] of url.searchParams) {
      if (!['redirect_uri', 'redirect_url'].includes(name.toLowerCase())) continue;
      if (remoteLoopbackUrl(value)) return true;
    }
  } catch { /* Invalid outer URL or redirect. */ }
  return false;
}

/** Keep normal terminal link actions unless this computer's callback needs its panel. */
export function terminalLinkOpensInPanel(value: string, remote: boolean): boolean {
  return remote && (remoteLoopbackUrl(value) || isRemoteSignInUrl(value));
}
