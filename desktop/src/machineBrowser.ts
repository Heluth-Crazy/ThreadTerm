import { app, session, type WebContents } from 'electron';
import { LoopbackProxy } from './loopbackProxy.js';
import type { RuntimeClient } from './runtime-client.js';

export const machineBrowserPartition = (machineId: string): string => machineId === 'local' ? 'persist:threadterm-browser' : `persist:threadterm-browser-${machineId}`;
type Entry = { proxy: LoopbackProxy; ready: Promise<void>; owners: Map<WebContents, RuntimeClient> };
/** Credentials stay in main, and are supplied only to the matching browser session's proxy challenge. */
export class MachineBrowserProfiles {
  private readonly entries = new Map<string, Entry>();
  constructor() {
    app.on('login', (event, contents, _details, authInfo, callback) => {
      if (!authInfo.isProxy || !contents || contents.isDestroyed()) return;
      for (const [id, entry] of this.entries) {
        if (contents.session === session.fromPartition(machineBrowserPartition(id)) && entry.proxy.matches(authInfo.host, authInfo.port)) {
          event.preventDefault(); callback(entry.proxy.username, entry.proxy.secret); return;
        }
      }
    });
  }
  async prepare(id: string, name: string, owner: WebContents, runtime: RuntimeClient): Promise<void> {
    if (id === 'local') return;
    let entry = this.entries.get(id);
    if (!entry) {
      const owners = new Map<WebContents, RuntimeClient>();
      const proxy = new LoopbackProxy(name, (port, loopback) => {
        const candidate = [...owners].find(([contents]) => !contents.isDestroyed());
        if (!candidate) return Promise.reject(new Error('Computer browser is closed'));
        return candidate[1].openTunnel(port, loopback);
      });
      const ready = proxy.listen().then(address => {
        if(this.entries.get(id)?.proxy!==proxy)throw new Error('Computer browser was closed');
        return session.fromPartition(machineBrowserPartition(id)).setProxy({ proxyRules: address, proxyBypassRules: '<-loopback>' });
      });
      entry = { proxy, ready, owners }; this.entries.set(id, entry);
    }
    entry.owners.set(owner, runtime);
    try { await entry.ready; }
    catch (error) { if(this.entries.get(id)===entry)this.release(machineBrowserPartition(id)); throw error; }
    if (this.entries.get(id) !== entry || owner.isDestroyed()) throw new Error('Computer browser was closed');
  }
  disconnect(id: string): void { this.entries.get(id)?.proxy.closeConnections(); }
  release(partition: string): void {
    for (const [id, entry] of this.entries) if (machineBrowserPartition(id) === partition) { entry.proxy.close(); this.entries.delete(id); }
  }
  close(): void { for (const entry of this.entries.values()) entry.proxy.close(); this.entries.clear(); }
}
