const ANSI_ESCAPE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
// Deliberately one address pattern: banners vary wildly, while an explicit
// loopback address plus port is the stable, safe signal shared by them.
const LOOPBACK_ADDRESS = /\b(https?):\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?=[\/:\s'"`)|,;]|$)/i;
export const MAX_REMEMBERED_DEV_SERVER_OFFERS = 256;
export const MAX_DEV_SERVER_LINE_BYTES = 16 * 1024;

export type DevServerOffer = { url:string; host:string; port:number };

/** Session lifetime state belongs to the caller; this keeps remount dedupe explicit and testable. */
export function claimDevServerOffer(seen:Set<string>, sessionId:string, offer:DevServerOffer, enabled:boolean):boolean {
  if (!enabled) return false;
  const key = `${sessionId}:${offer.port}`;
  if (seen.has(key)) return false;
  // A noisy terminal cannot retain unbounded offer history. Refusing new keys
  // preserves the once-only rule for every key already observed.
  if (seen.size >= MAX_REMEMBERED_DEV_SERVER_OFFERS) return false;
  seen.add(key);
  return true;
}

export function devServerOffer(line:string):DevServerOffer|undefined {
  const match = LOOPBACK_ADDRESS.exec(line.replace(ANSI_ESCAPE, ''));
  if (!match) return undefined;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const host = match[2].toLowerCase();
  return { url:`${match[1].toLowerCase()}://${host}:${port}`, host, port };
}

/** Carries only an unfinished output line across arbitrary PTY chunks. */
export function createDevServerLineDetector(onOffer:(offer:DevServerOffer)=>void) {
  let pending = '', discarding = false;
  return {
    push(text:string) {
      let start = 0;
      if (discarding) {
        const newline = text.search(/\r?\n/);
        if (newline < 0) return;
        start = newline + (text[newline] === '\r' && text[newline + 1] === '\n' ? 2 : 1);
        discarding = false;
      }
      const lines = text.slice(start).split(/\r?\n/), tail = lines.pop() ?? '';
      for (let index = 0; index < lines.length; index += 1) {
        const line = `${index === 0 ? pending : ''}${lines[index]}`;
        if (line.length > MAX_DEV_SERVER_LINE_BYTES) continue;
        const offer = devServerOffer(line);
        if (offer) onOffer(offer);
      }
      pending = tail;
      if (pending.length > MAX_DEV_SERVER_LINE_BYTES) { pending = ''; discarding = true; }
    },
    reset() { pending = ''; discarding = false; },
  };
}
