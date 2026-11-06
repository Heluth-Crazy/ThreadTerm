/** Navigation state is transient and scoped to one machine/root/owner. */
export type NavigationLanguage = 'typescript' | 'javascript' | 'rust' | 'python' | 'java';
export type NavigationLocation = { path: string; line: number; column: number; endLine?: number; endColumn?: number; name?: string; anchor?: number; head?: number; scrollTop?: number };
export type NavigationDocument = { path: string; content: string; version: number };
export type NavigationBuffer = { path: string; content: string; dirty: boolean; ready?: boolean; reveal?: (location: NavigationLocation) => boolean };

export function navigationLanguage(path: string): NavigationLanguage | undefined {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension ?? '')) return 'typescript';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
  return ({ rs: 'rust', py: 'python', pyi: 'python', java: 'java' } as Record<string, NavigationLanguage>)[extension ?? ''];
}

export function navigationKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): 'definition' | 'symbols' | 'back' | 'forward' | undefined {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.altKey && !event.shiftKey && event.key === 'ArrowLeft') return 'back';
  if (mod && event.altKey && !event.shiftKey && event.key === 'ArrowRight') return 'forward';
  if (event.altKey || event.shiftKey) return;
  if (mod && event.key === 'F12') return 'symbols';
  if ((!mod && event.key === 'F12') || (mod && event.key.toLowerCase() === 'b')) return 'definition';
}

const sameLocation = (a: NavigationLocation, b: NavigationLocation) => a.path === b.path && a.line === b.line && a.column === b.column;
export class NavigationHistory {
  private entries: NavigationLocation[] = [];
  private index = -1;
  get canBack() { return this.index > 0; }
  get canForward() { return this.index >= 0 && this.index < this.entries.length - 1; }
  target(delta: -1 | 1): NavigationLocation | undefined { return this.entries[this.index + delta]; }
  /** Call only after a successful open; failed/cancelled opens leave the stack untouched. */
  visit(origin: NavigationLocation, target: NavigationLocation) {
    if (sameLocation(origin, target)) return;
    this.entries = this.entries.slice(0, this.index + 1);
    if (this.index < 0 || !sameLocation(this.entries[this.index], origin)) this.entries.push(origin);
    this.entries.push(target);
    this.entries = this.entries.slice(-100);
    this.index = this.entries.length - 1;
  }
  move(delta: -1 | 1, origin: NavigationLocation) {
    if (!this.target(delta)) return;
    this.entries[this.index] = origin;
    this.index += delta;
  }
}

export class NavigationDocuments {
  private versions = new Map<string, NavigationDocument>();
  private nextVersion = 0;
  snapshot(source: NavigationBuffer, persisted: readonly NavigationBuffer[], live: readonly NavigationBuffer[]): NavigationDocument[] {
    const selected = new Map(persisted.filter(value => value.dirty && navigationLanguage(value.path)).map(value => [value.path, value]));
    const seen = new Map<string, NavigationBuffer>();
    for (const buffer of live) {
      if (buffer.path === source.path || !buffer.dirty || !navigationLanguage(buffer.path)) continue;
      const previous = seen.get(buffer.path);
      if (previous && previous.content !== buffer.content) throw new Error(`navigation_divergent_buffers: ${buffer.path}`);
      seen.set(buffer.path, buffer);
      selected.set(buffer.path, buffer);
    }
    selected.set(source.path, source);
    const encoder = new TextEncoder();
    let total = 0;
    const output: NavigationDocument[] = [];
    for (const buffer of selected.values()) {
      const bytes = encoder.encode(buffer.content).byteLength;
      if (bytes > 1024 * 1024 || (total += bytes) > 8 * 1024 * 1024 || output.length >= 128) throw new Error('navigation_document_too_large');
      const previous = this.versions.get(buffer.path);
      const doc = previous?.content === buffer.content ? previous : { path: buffer.path, content: buffer.content, version: ++this.nextVersion };
      output.push(doc);
    }
    // A context-wide counter also fences a document that was closed and later reopened.
    this.versions = new Map(output.map(doc => [doc.path, doc]));
    return output;
  }
}

export type NavigationGroup = {
  history: NavigationHistory;
  opening?: { targetPath: string; done: Promise<void>; commitIfReady: () => boolean };
  buffers: Map<string, () => NavigationBuffer | undefined>;
  listeners: Set<() => void>;
  epoch: number;
};
const groups = new Map<string, NavigationGroup>();
export function retainNavigationGroup(key: string, id: string, read: () => NavigationBuffer | undefined): NavigationGroup {
  let group = groups.get(key);
  if (!group) { group = { history: new NavigationHistory(), buffers: new Map(), listeners: new Set(), epoch: 0 }; groups.set(key, group); }
  group.buffers.set(id, read);
  return group;
}
export function releaseNavigationGroup(key: string, id: string) {
  const group = groups.get(key);
  group?.buffers.delete(id);
  if (group && !group.buffers.size) groups.delete(key);
}
export function notifyNavigationGroup(group: NavigationGroup) { for (const notify of group.listeners) notify(); }

export function navigationError(error: unknown, zh: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('navigation_java_incompatible')) {
    const detected = /Java (\d+) or newer is required by JDT LS; detected Java (\d+)/.exec(message);
    if (detected) return zh ? `Java 代码跳转需要 Java ${detected[1]} 或更高版本，这台电脑上只找到 Java ${detected[2]}。请安装新版 Java，或在“语言服务”中选择它。` : `Java code navigation needs Java ${detected[1]} or newer, but this computer only has Java ${detected[2]}. Install a newer Java, or choose it in Language services.`;
    const required = /requires Java (\d+) or newer/.exec(message);
    if (required) return zh ? `这个 Java 语言服务需要 Java ${required[1]} 或更高版本。请在“语言服务”中选择新版 Java。` : `This Java language server needs Java ${required[1]} or newer. Choose a newer Java in Language services.`;
    return zh ? '无法读取 Java 版本。请在“语言服务”中选择 Java 21 或更高版本。' : 'The Java version could not be read. Choose Java 21 or newer in Language services.';
  }
  if (message.includes('navigation_server_unavailable')) {
    if (message.includes('java executable')) return zh ? '没有找到 Java 21 或更高版本。请安装后重试，或在“语言服务”中选择它。' : 'Java 21 or newer was not found. Install it and retry, or choose it in Language services.';
    if (message.includes('JDT LS')) return zh ? '没有找到 Java 语言服务（JDT LS）。在 VS Code 中安装 Red Hat 的 Java 扩展后会自动使用，也可以在“语言服务”中填写它的目录。' : 'The Java language server (JDT LS) was not found. Install Red Hat’s Java extension in VS Code and it is used automatically, or set its folder in Language services.';
    return zh ? '没有找到这种文件的语言服务。请安装后重试，或在“语言服务”中填写它的位置。' : 'No language service was found for this file. Install it and retry, or set its location in Language services.';
  }
  const known: Array<[string, string, string]> = [
    ['divergent_buffers', '目标文件在不同标签中有不同草稿，请先保存后重试。', 'The target has different drafts in separate tabs. Save them before retrying.'],
    ['document_too_large', '文件或草稿集合超出代码跳转的大小限制。', 'The file or draft set exceeds the navigation size limit.'],
    ['disabled', '代码跳转已停用，请在语言服务设置中启用。', 'Code navigation is disabled. Enable it in Language services.'],
    ['timeout', '语言服务未及时响应，可以重试或停止服务。', 'The language service did not respond in time. Retry or stop it.'],
    ['busy', '语言服务正忙，请稍后重试。', 'Language services are busy. Try again shortly.'],
    ['cancel', '已取消。', 'Cancelled.'],
    ['unsupported_target', '定义位于当前项目可访问的源码之外，暂不支持打开库、归档或生成目标。', 'The definition is outside this project’s accessible source files. Library, archive and generated targets are unavailable.'],
    ['unsupported', '此语言或文件暂不支持代码跳转。', 'Navigation is unavailable for this language or file.'],
  ];
  const match = known.find(([code]) => message.includes(code));
  return match ? match[zh ? 1 : 2] : message;
}
