/**
 * Pure chip-registry builder for the focus-mode bottom action bar
 * (Stage 6 §Decision 5).
 *
 * The plan locks six chips: notifications, bookmarks, workflows,
 * file-explorer, rich-input, remote-control. The builder maps a
 * minimal context (cwd, bridge availability, bookmark and unread
 * counts) into ordered, typed descriptors. The renderer maps the
 * `iconKey` strings to Lucide icons; this module stays React-free.
 */

export type ChipId =
  | 'notifications'
  | 'bookmarks'
  | 'workflows'
  | 'file-explorer'
  | 'rich-input'
  | 'remote-control';

export type ChipIconKey = 'bell' | 'star' | 'workflow' | 'folder' | 'message' | 'phone';

export interface ChipDescriptor {
  id: ChipId;
  /** i18n key (no leading namespace). Renderer prefixes with the
   *  `terminal` namespace, so `bottomBar.notifications` resolves
   *  against `src/i18n/locales/<lng>/terminal.json`. */
  labelKey: string;
  iconKey: ChipIconKey;
  /** Numeric badge to render alongside the icon when > 0. */
  badge?: number;
}

export interface ChipContext {
  /** `card.cwd` — empty string when the focused card has no cwd. */
  cardCwd: string;
  /** Whether the mobile-access bridge is reachable. Gates the
   *  remote-control chip per plan Decision 5. */
  bridgeAvailable: boolean;
  /** Total bookmark count for the focused card; renders as a badge
   *  on the bookmarks chip when > 0. */
  bookmarkCount: number;
  /** Unread notification count; flips the notifications chip icon
   *  to `BellDot` and renders a badge when > 0. */
  unreadNotifications: number;
}

export function buildChipRegistry(ctx: ChipContext): ChipDescriptor[] {
  const out: ChipDescriptor[] = [];

  out.push({
    id: 'notifications',
    labelKey: 'bottomBar.notifications',
    iconKey: 'bell',
    badge: ctx.unreadNotifications > 0 ? ctx.unreadNotifications : undefined,
  });

  out.push({
    id: 'bookmarks',
    labelKey: 'bottomBar.bookmarks',
    iconKey: 'star',
    badge: ctx.bookmarkCount > 0 ? ctx.bookmarkCount : undefined,
  });

  out.push({ id: 'workflows', labelKey: 'bottomBar.workflows', iconKey: 'workflow' });

  if (ctx.cardCwd) {
    out.push({ id: 'file-explorer', labelKey: 'bottomBar.fileExplorer', iconKey: 'folder' });
  }

  out.push({ id: 'rich-input', labelKey: 'bottomBar.richInput', iconKey: 'message' });

  if (ctx.bridgeAvailable) {
    out.push({ id: 'remote-control', labelKey: 'bottomBar.remoteControl', iconKey: 'phone' });
  }

  return out;
}
