/**
 * Single source of truth for product-level feature visibility on the
 * desktop UI surface. Flipping a flag here hides every entry point for the
 * named feature without touching its data layer or persisted state, so a
 * subsequent flip back to `true` brings the feature back exactly as it was
 * (including any user data that accumulated while it was hidden).
 *
 * Conventions:
 *   • Flags are plain `const` exports — no environment / runtime overrides.
 *     A change requires a code edit + rebuild, which is appropriate for a
 *     "hide for now, may revisit" gate.
 *   • Only UI render paths should consult these flags. Store actions, types,
 *     persistence migrations, and tests of the underlying data layer must
 *     stay intact regardless of the flag value.
 */

/**
 * Bookmarks feature visibility (Stage 5).
 *
 * When `false`, the following surfaces are hidden:
 *   • Workspace top-toolbar star button + count badge.
 *   • Right-edge `BookmarksSidebar` slide-out panel.
 *   • Hover-toolbar star button on command blocks (`BlockToolbar`).
 *   • Bottom action bar `bookmarks` chip.
 *
 * `terminalStore.bookmarks` and its `addBookmark` / `removeBookmark` /
 * `isBookmarked` actions remain functional and continue to be persisted, so
 * historical bookmarks survive the hide and reappear when this flag flips
 * back to `true`.
 */
export const BOOKMARKS_VISIBLE = false;
