export function remoteLoopbackUrl(value:string):boolean {
 try {const url=new URL(value),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');return ['http:','https:'].includes(url.protocol)&&(host==='localhost'||host.endsWith('.localhost')||/^127(?:\.\d{1,3}){3}$/.test(host)||host==='::1'||/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host));}catch{return false;}
}
/** A remote address must never become an iframe in the unproxied application session. */
export function previewAddress(address:string,remote:boolean,openPanel:(url:string)=>void,setIframe:(url:string)=>void):string {
 const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw new Error('Use an HTTP or HTTPS address.');
 if(remote)openPanel(url.href);else setIframe(url.href);
 return url.href;
}
