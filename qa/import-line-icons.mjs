// Imports ThreadTerm's line icons from Lucide (https://lucide.dev, ISC) into qa/line-icons.json, which
// qa/generate-prototype-icons.mjs turns into PrototypeIcon.tsx. Run it only to add or change an icon:
//   node qa/import-line-icons.mjs
// lucide-react is already installed (a dependency of @astryxdesign/theme-neutral); nothing of it ships at runtime but
// these static path strings. Owner decision 2026-11-26: one line set, one meaning per glyph (prototypes/icon-refresh).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const lucide = join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'node_modules/lucide-react');
const icons = join(lucide, 'dist/esm/icons');

/** ThreadTerm name → Lucide name. Names are what call sites ask for; several may share a drawing. */
const MAP = {
  // Shell and navigation
  home: 'house', inbox: 'inbox', terminal: 'square-terminal', clock: 'clock', layers: 'layers', search: 'search',
  plus: 'plus', bell: 'bell', gear: 'settings', sidebar: 'panel-left', panel: 'panel-right', compose: 'square-pen',
  usage: 'chart-no-axes-column', sun: 'sun', moon: 'moon', globe: 'globe', user: 'user', person: 'user',
  // Disclosure and arrows
  chevR: 'chevron-right', chevD: 'chevron-down', back: 'chevron-left', chevU: 'chevron-up', 'chev-up': 'chevron-up',
  arrowUp: 'arrow-up', moveUp: 'arrow-up', moveDown: 'arrow-down', 'arrow-left': 'arrow-left', 'arrow-right': 'arrow-right',
  nest: 'corner-down-right', 'collapse-all': 'chevrons-down-up',
  // Row and menu actions
  more: 'ellipsis', close: 'x', check: 'check', minus: 'minus', minimize: 'minus', maximize: 'square',
  copy: 'copy', rename: 'pencil', refresh: 'refresh-cw', undo: 'undo-2', trash: 'trash',
  archive: 'archive', restore: 'archive-restore', settle: 'circle-check', star: 'star', pin: 'pin', follow: 'eye',
  bookmark: 'bookmark', power: 'power', link: 'link', hash: 'hash', export: 'share', download: 'file-down',
  // Opening things
  popout: 'square-arrow-out-up-right', external: 'external-link', pip: 'picture-in-picture-2', locate: 'locate',
  split: 'columns-2', rows: 'rows-2',
  // Files and Git
  file: 'file', folder: 'folder', folderOpen: 'folder-open', 'file-plus': 'file-plus', 'folder-plus': 'folder-plus',
  attach: 'paperclip', image: 'image', branch: 'git-branch', worktree: 'folder-git-2', diff: 'diff',
  history: 'history', fileHistory: 'file-clock', checkpoint: 'git-commit-horizontal',
  fetch: 'cloud-download', pull: 'arrow-down-to-line', push: 'arrow-up-from-line',
  // Agents and chat
  agents: 'users', users: 'users', 'agent-access': 'users', bot: 'bot', spark: 'sparkles', brain: 'brain',
  review: 'scan-search', send: 'send', msg: 'message-square', comment: 'message-square-text', 'to-chat': 'message-square-share',
  bolt: 'zap', alarm: 'alarm-clock', shield: 'shield-check', info: 'info', warning: 'triangle-alert',
  plug: 'plug', wrench: 'wrench', tune: 'sliders-horizontal',
  // Browser and design tools
  devtools: 'code-xml', 'element-code': 'code', 'css-props': 'braces', 'zoom-in': 'zoom-in', 'zoom-out': 'zoom-out',
  screenshot: 'scan', annotate: 'pencil-line', 'pick-element': 'mouse-pointer-2', 'pick-area': 'square-dashed-mouse-pointer',
  play: 'play', stop: 'square',
  // Workbench toolbar views
  'view-files': 'file', 'view-search': 'search', 'view-scm': 'git-branch', 'view-browser': 'globe', 'view-details': 'info',
  'view-changes': 'diff',
};

/** Follows Lucide 1.x's renames (`export { default } from './trash.mjs'`) to the file that holds the drawing. */
function drawing(name) {
  let file = `${name}.mjs`;
  for (let alias; (alias = /export \{ default \} from '\.\/([^']+)'/.exec(readFileSync(join(icons, file), 'utf8')));) file = alias[1];
  return join(icons, file);
}

const version = JSON.parse(readFileSync(join(lucide, 'package.json'), 'utf8')).version;
const out = {};
for (const [name, source] of Object.entries(MAP)) {
  const { __iconData } = await import(pathToFileURL(drawing(source)).href);
  out[name] = __iconData.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== 'key').map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('');
}
const license = readFileSync(join(lucide, 'LICENSE'), 'utf8').trim();
writeFileSync(new URL('qa/line-icons.json', root), `${JSON.stringify({ source: `lucide-react ${version}`, license, map: MAP, icons: out }, null, 1)}\n`);
console.log(`qa/line-icons.json: ${Object.keys(out).length} icons from lucide-react ${version}`);
