import { randomUUID } from 'node:crypto';
import { BROWSER_AGENT_REF_LIMIT, BROWSER_AGENT_READ_DATA_BYTES, BrowserAgentError, assertBrowserAgentResultBound, browserAgentProvenance, clipBrowserAgentText, type BrowserAgentReadFence } from './agentTypes.js';

export interface BrowserAgentAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name?: string; value?: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface BrowserAgentNodeRef {
  readonly ref: string;
  readonly backendNodeId: number;
  readonly axNodeId: string;
  readonly frameId: string;
  readonly role: string;
}

function generationKey(fence: BrowserAgentReadFence): string {
  return JSON.stringify([fence.registration, fence.grantEpoch, fence.refGeneration, fence.documentGeneration, fence.navigationEpoch]);
}

/** A removed mapping is never reused, including after capacity eviction. */
export class BrowserAgentSnapshotRefs {
  private generation?: string;
  private readonly byIdentity = new Map<string, BrowserAgentNodeRef>();
  private readonly byRef = new Map<string, BrowserAgentNodeRef>();

  reset(): void { this.generation = undefined; this.byIdentity.clear(); this.byRef.clear(); }

  begin(fence: BrowserAgentReadFence): void {
    const key = generationKey(fence);
    if (this.generation !== key) { this.reset(); this.generation = key; }
  }

  bind(fence: BrowserAgentReadFence, frameId: string, node: BrowserAgentAXNode, role: string): BrowserAgentNodeRef | undefined {
    this.begin(fence);
    if (!Number.isSafeInteger(node.backendDOMNodeId) || node.backendDOMNodeId! <= 0 || !node.nodeId) return undefined;
    const identity = JSON.stringify([frameId, node.backendDOMNodeId, node.nodeId, role]);
    const existing = this.byIdentity.get(identity);
    if (existing) return existing;
    while (this.byIdentity.size >= BROWSER_AGENT_REF_LIMIT) {
      const oldest = this.byIdentity.keys().next().value!;
      this.byRef.delete(this.byIdentity.get(oldest)!.ref); this.byIdentity.delete(oldest);
    }
    const result = Object.freeze({ ref: `ref-${randomUUID()}`, backendNodeId: node.backendDOMNodeId!, axNodeId: node.nodeId, frameId, role });
    this.byIdentity.set(identity, result); this.byRef.set(result.ref, result);
    return result;
  }

  resolve(fence: BrowserAgentReadFence, ref: string): BrowserAgentNodeRef {
    if (this.generation !== generationKey(fence)) throw new BrowserAgentError('browser_stale_ref', 'The browser reference belongs to an earlier page.');
    const result = this.byRef.get(ref);
    if (!result) throw new BrowserAgentError('browser_stale_ref', 'The browser reference is no longer available.');
    return result;
  }

  retain(refs: ReadonlySet<string>): void {
    for (const [identity, value] of this.byIdentity) if (!refs.has(value.ref)) { this.byIdentity.delete(identity); this.byRef.delete(value.ref); }
  }

  get size(): number { return this.byRef.size; }
}

export interface BrowserAgentSnapshotResult {
  provenance: ReturnType<typeof browserAgentProvenance>;
  snapshotId: string;
  outline: string;
  truncated: boolean;
  refCount: number;
  omittedFrames: number;
  limitations: string[];
}

function plain(value: unknown, bytes: number, truncated: () => void): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\x00-\x1f\x7f]/g, ' '), result = clipBrowserAgentText(normalized, bytes);
  if (result !== normalized) truncated();
  return result;
}

/** AX values and properties are deliberately omitted, including editable/password values. */
export function buildBrowserAgentSnapshot(fence: BrowserAgentReadFence, frameId: string, nodes: readonly BrowserAgentAXNode[], refs: BrowserAgentSnapshotRefs): BrowserAgentSnapshotResult {
  refs.begin(fence);
  const result: BrowserAgentSnapshotResult = { provenance: browserAgentProvenance(fence), snapshotId: `snapshot-${randomUUID()}`, outline: '', truncated: nodes.length > 8192, refCount: 0, omittedFrames: 0, limitations: ['Editable values are omitted.', 'Embedded frame contents are omitted.', 'Accessibility reflects browser-exposed content; closed shadow content may be unavailable.'] };
  result.truncated ||= result.provenance.truncated;
  const indexed = new Map<string, BrowserAgentAXNode>();
  for (const node of nodes.slice(0, 8192)) if (node && typeof node.nodeId === 'string' && !indexed.has(node.nodeId)) indexed.set(node.nodeId, node);
  const root = [...indexed.values()].find(node => node.frameId === frameId && node.role?.value === 'RootWebArea');
  if (!root) throw new BrowserAgentError('browser_read_failed', 'The current document accessibility root is unavailable.');
  const seen = new Set<string>(), retained = new Set<string>(), lines: string[] = [];
  const pending: { node: BrowserAgentAXNode; depth: number }[] = [{ node: root, depth: 0 }];
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  let visits = 0;
  while (pending.length) {
    if (++visits > 16_384) { result.truncated = true; break; }
    const { node, depth } = pending.pop()!;
    if (seen.has(node.nodeId)) continue;
    if (seen.size >= BROWSER_AGENT_REF_LIMIT || depth > 32) { result.truncated = true; continue; }
    seen.add(node.nodeId);
    if (node.frameId && node.frameId !== frameId) { result.omittedFrames++; continue; }
    const clipped = (): void => { result.truncated = true; };
    const role = plain(node.role?.value, 128, clipped) || 'unknown';
    const embedded = /^(iframe|iframepresentational|webarea)$/i.test(role);
    const editable = /^(textbox|searchbox|combobox|spinbutton)$/i.test(role) || (Array.isArray(node.properties) && node.properties.some(property => property.name === 'editable' && property.value?.value !== false && property.value?.value !== 'false'));
    if (embedded) result.omittedFrames++;
    if (!node.ignored) {
      const name = plain(node.name?.value, 2048, clipped);
      const reference = embedded ? undefined : refs.bind(fence, frameId, node, role);
      const line = `${'  '.repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ''}${reference ? ` [${reference.ref}]` : ''}${embedded ? ' [embedded frame contents omitted]' : editable ? ' [editable contents omitted]' : ''}`;
      // JSON escaping is counted because the wire response itself has a byte limit.
      const lineBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') + 2;
      if (bytes + lineBytes + 256 >= BROWSER_AGENT_READ_DATA_BYTES) { result.truncated = true; break; }
      bytes += lineBytes; lines.push(line);
      if (reference) retained.add(reference.ref);
    }
    if (!embedded && !editable) for (const childId of (node.childIds ?? []).slice(0, BROWSER_AGENT_REF_LIMIT).reverse()) {
      if (pending.length >= 8192) { result.truncated = true; break; }
      const child = indexed.get(childId);
      if (child) pending.push({ node: child, depth: node.ignored ? depth : depth + 1 });
      else result.truncated = true;
    }
    if ((node.childIds?.length ?? 0) > BROWSER_AGENT_REF_LIMIT) result.truncated = true;
  }
  if (result.truncated) lines.push('[Accessibility output truncated]');
  result.outline = lines.join('\n'); result.refCount = retained.size;
  refs.retain(retained);
  assertBrowserAgentResultBound(result, BROWSER_AGENT_READ_DATA_BYTES);
  return result;
}
