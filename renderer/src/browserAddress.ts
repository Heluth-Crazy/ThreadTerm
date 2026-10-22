export function browserAddressParts(text: string): { scheme: 'https' | 'http' | 'other'; host: string; rest: string } {
 try {
  const url = new URL(text);
  if (url.protocol === 'https:' || url.protocol === 'http:') {
   return { scheme: url.protocol === 'https:' ? 'https' : 'http', host: url.host.replace(/^www\./, ''), rest: (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash };
  }
 } catch { /* An unfinished address is displayed exactly as entered. */ }
 return { scheme: 'other', host: text, rest: '' };
}
