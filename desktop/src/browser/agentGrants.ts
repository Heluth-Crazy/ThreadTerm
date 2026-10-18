import { BrowserAgentError, browserAgentOrigin, type BrowserAgentControlFence, type BrowserAgentDocument, type BrowserAgentExpectedShare, type BrowserAgentGrantState, type BrowserAgentReadFence, type BrowserAgentRegistration, type BrowserAgentShare } from './agentTypes.js';

type RecordState = { registration: BrowserAgentRegistration; level: BrowserAgentShare; grantEpoch: number; refGeneration: number; origin?: string; reason?: string };

function sameRegistration(left: BrowserAgentRegistration, right: BrowserAgentRegistration): boolean {
  return left.tabId === right.tabId && left.sourceTabId === right.sourceTabId && left.attachmentId === right.attachmentId && left.attachmentGeneration === right.attachmentGeneration && left.runtimeEpoch === right.runtimeEpoch && left.viewGeneration === right.viewGeneration;
}

/** Main-owned ephemeral grants. No URL, restored layout or provider token creates a grant. */
export class BrowserAgentGrants {
  private readonly records = new Map<string, RecordState>();
  private epoch = 0;
  constructor(private readonly changed?: (state: BrowserAgentGrantState) => void) {}

  register(registration: BrowserAgentRegistration): BrowserAgentGrantState {
    const existing = this.records.get(registration.sourceTabId);
    if (existing && sameRegistration(existing.registration, registration)) return this.copy(existing);
    if (existing) this.revoke(existing, 'Browser registration changed.');
    const record: RecordState = { registration: Object.freeze({ ...registration }), level: 'off', grantEpoch: ++this.epoch, refGeneration: 0 };
    this.records.set(registration.sourceTabId, record);
    this.publish(record);
    return this.copy(record);
  }

  state(sourceTabId: string): BrowserAgentGrantState | undefined {
    const record = this.records.get(sourceTabId);
    return record ? this.copy(record) : undefined;
  }

  setShare(sourceTabId: string, level: BrowserAgentShare, expected: BrowserAgentExpectedShare, document: BrowserAgentDocument): BrowserAgentGrantState {
    const record = this.require(sourceTabId);
    if (level !== 'off' && level !== 'read' && level !== 'control') throw new BrowserAgentError('browser_invalid_arguments', 'Unsupported browser sharing level.');
    if (level === 'off') this.revoke(record, 'Browser sharing turned off.');
    else {
      if (record.grantEpoch !== expected.grantEpoch || document.sourceTabId !== sourceTabId || document.viewGeneration !== expected.viewGeneration || record.registration.viewGeneration !== expected.viewGeneration || document.documentGeneration !== expected.documentGeneration || document.navigationEpoch !== expected.navigationEpoch) throw new BrowserAgentError('browser_stale_ref', 'The browser page changed before sharing was updated.');
      const origin = browserAgentOrigin(document.url);
      if (!document.available || !document.loaded || !origin || origin === document.appOrigin) throw new BrowserAgentError('browser_unavailable', 'Only a loaded supported browser page can be shared.');
      record.level = level; record.origin = origin; record.reason = undefined; record.grantEpoch = ++this.epoch; record.refGeneration++;
      this.publish(record);
    }
    return this.copy(record);
  }

  /** Call before main overwrites its current URL, including blocked redirects. */
  navigationStarted(sourceTabId: string, url: string): void {
    const record = this.records.get(sourceTabId);
    if (!record) return;
    record.refGeneration++;
    if (record.level !== 'off' && browserAgentOrigin(url) !== record.origin) this.revoke(record, 'Sharing stopped — the page moved to another site.');
    else this.publish(record);
  }

  invalidate(sourceTabId: string, reason = 'Browser view is unavailable.'): void {
    const record = this.records.get(sourceTabId);
    if (record) this.revoke(record, reason);
  }

  unregister(sourceTabId: string, reason = 'Browser tab was removed.'): void {
    const record = this.records.get(sourceTabId);
    if (record) { this.revoke(record, reason); this.records.delete(sourceTabId); }
  }

  clear(reason = 'Browser attachment was lost.'): void {
    for (const record of this.records.values()) this.revoke(record, reason);
    this.records.clear();
  }

  captureRead(sourceTabId: string, document: BrowserAgentDocument): BrowserAgentReadFence {
    const record = this.require(sourceTabId);
    if (record.level === 'off' || !record.origin) throw new BrowserAgentError('browser_grant_required', 'Share this tab with Read access before using browser tools.');
    this.assertDocument(record, document);
    return Object.freeze({ ...this.copy(record), level: 'read', origin: record.origin, documentGeneration: document.documentGeneration, navigationEpoch: document.navigationEpoch, url: document.url });
  }

  assertRead(fence: BrowserAgentReadFence, document: BrowserAgentDocument): void {
    const record = this.require(fence.registration.sourceTabId);
    if (!sameRegistration(record.registration, fence.registration) || record.level === 'off' || record.grantEpoch !== fence.grantEpoch || record.refGeneration !== fence.refGeneration || record.origin !== fence.origin) throw new BrowserAgentError('browser_grant_required', 'Browser sharing changed during this read.');
    this.assertDocument(record, document);
    if (document.documentGeneration !== fence.documentGeneration || document.navigationEpoch !== fence.navigationEpoch || document.url !== fence.url) throw new BrowserAgentError('browser_stale_ref', 'The browser page changed during this read.');
  }

  /** A downgrade removes mutation authority immediately, including while a page is loading. */
  downgradeToRead(sourceTabId: string): void {
    const record = this.require(sourceTabId);
    if (record.level !== 'control') return;
    record.level = 'read'; record.grantEpoch = ++this.epoch; record.refGeneration++; this.publish(record);
  }

  captureControl(sourceTabId: string, document: BrowserAgentDocument): BrowserAgentControlFence {
    const record = this.require(sourceTabId);
    if (record.level !== 'control' || !record.origin) throw new BrowserAgentError('browser_grant_required', 'Control access is required for this browser operation.');
    this.assertDocument(record, document);
    return Object.freeze({ ...this.copy(record), level: 'control', origin: record.origin, documentGeneration: document.documentGeneration, navigationEpoch: document.navigationEpoch, url: document.url });
  }

  assertControl(fence: BrowserAgentControlFence, document: BrowserAgentDocument): void {
    const record = this.require(fence.registration.sourceTabId);
    if (record.level !== 'control' || !sameRegistration(record.registration, fence.registration) || record.grantEpoch !== fence.grantEpoch || record.refGeneration !== fence.refGeneration || record.origin !== fence.origin) throw new BrowserAgentError('browser_grant_required', 'Browser control changed during this operation.');
    this.assertDocument(record, document);
    if (document.documentGeneration !== fence.documentGeneration || document.navigationEpoch !== fence.navigationEpoch || document.url !== fence.url) throw new BrowserAgentError('browser_stale_ref', 'The browser page changed during this operation.');
  }

  private assertDocument(record: RecordState, document: BrowserAgentDocument): void {
    if (document.sourceTabId !== record.registration.sourceTabId || document.viewGeneration !== record.registration.viewGeneration || !document.available || !document.loaded) throw new BrowserAgentError('browser_unavailable', 'The shared browser view is unavailable.');
    if (browserAgentOrigin(document.url) !== record.origin || record.origin === document.appOrigin) throw new BrowserAgentError('browser_grant_required', 'The current browser page is not shared.');
  }
  private require(sourceTabId: string): RecordState {
    const record = this.records.get(sourceTabId);
    if (!record) throw new BrowserAgentError('browser_tab_not_found', 'Browser tab is unavailable.');
    return record;
  }
  private revoke(record: RecordState, reason: string): void {
    record.level = 'off'; record.origin = undefined; record.reason = reason; record.grantEpoch = ++this.epoch; record.refGeneration++;
    this.publish(record);
  }
  private copy(record: RecordState): BrowserAgentGrantState { return Object.freeze({ ...record }); }
  private publish(record: RecordState): void { this.changed?.(this.copy(record)); }
}
