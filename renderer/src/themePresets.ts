// Ready-made theme presets mapped onto ThreadTerm's colour roles.
// Sources (MIT; Tokyo Night Apache-2.0): GitHub Primer primitives, Solarized (Ethan Schoonover), Catppuccin (palette.json),
// Rosé Pine (palette.json), Gruvbox (morhetz/gruvbox colors/gruvbox.vim), Nord (nordtheme/nord), Tokyo Night
// (folke/tokyonight.nvim), Dracula (dracula/visual-studio-code). ThreadTerm Light/Dark are the app's own tokens.
// Full notices: THIRD_PARTY_NOTICES.md at the repository root.
//
// Roles: frame (window background, tab strip, gaps), sidebar (project list), panel (Chat, side bar, inspector,
// selected tab), editor (file view, diffs, terminal), text, muted, border, accent, accentFg (text on accent).
// Fixed per theme (not user-editable): ok/warn/danger, syntax, ansi (16 terminal colours).
//
// Contrast gate (renderer/src/themePresets.test.ts): text >= 4.5:1 on panel/editor/sidebar, muted >= 3:1 on
// panel/frame, accentFg on accent >= 4.5:1, accent on panel >= 3:1, ANSI 1-6 >= 3:1 on the editor background. A few
// official colours miss that gate on a light background; the adjustments are marked "contrast:" below and listed with
// before/after ratios in THIRD_PARTY_NOTICES.md.
export type ThemeRoleColors = {
  frame: string;
  sidebar: string;
  panel: string;
  editor: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentFg: string;
  ok: string;
  warn: string;
  danger: string;
};

export type SyntaxColors = {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  fn: string;
  type: string;
  prop: string;
  punct: string;
};

/** The 16 xterm ANSI colours: 0-7 normal, 8-15 bright. */
export type AnsiPalette = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
];

export type ThemeMode = "light" | "dark";

export type ThemePreset = {
  id: string;
  family: string;
  name: string;
  mode: ThemeMode;
  c: ThemeRoleColors;
  syn: SyntaxColors;
  ansi: AnsiPalette;
};

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "threadterm-light", family: "ThreadTerm", name: "ThreadTerm Light", mode: "light",
    c: { frame: "#f5f4ef", sidebar: "#eeede6", panel: "#fefdfb", editor: "#fefdfb", text: "#23221f", muted: "#6c6961", border: "#e4e2da", accent: "#4f59c8", accentFg: "#ffffff", ok: "#1a7f37", warn: "#9a6700", danger: "#cf222e" },
    syn: { keyword: "#7c3aed", string: "#15803d", number: "#c2410c", comment: "#6b7280", fn: "#2563eb", type: "#b45309", prop: "#0f766e", punct: "#52525b" },
    ansi: ["#3d3b36", "#b0362f", "#2f6f3e", "#8a6414", "#335f8f", "#7a4f86", "#2a6f73", "#cfccc3", "#6c6961", "#c7473f", "#3b8a4e", "#a67b1b", "#4373ab", "#9161a0", "#348a8f", "#f5f4ef"],
  },
  {
    id: "threadterm-dark", family: "ThreadTerm", name: "ThreadTerm Dark", mode: "dark",
    c: { frame: "#262624", sidebar: "#1f1e1d", panel: "#2c2c2a", editor: "#2c2c2a", text: "#ecebe5", muted: "#a8a59c", border: "#3b3a37", accent: "#8b93f0", accentFg: "#1f1e1d", ok: "#3fb950", warn: "#d29922", danger: "#f85149" },
    syn: { keyword: "#c4b5fd", string: "#86efac", number: "#fdba74", comment: "#8b93a7", fn: "#93c5fd", type: "#fcd34d", prop: "#5eead4", punct: "#a1a1aa" },
    ansi: ["#3a3936", "#e5786d", "#8fbf7f", "#d9b56b", "#82a8d9", "#c49ad6", "#7cc2c0", "#d6d3ca", "#6f6c65", "#f08a80", "#a3d193", "#e8c67c", "#98bbe8", "#d4aee3", "#91d3d1", "#f4f2ec"],
  },
  {
    id: "github-light", family: "GitHub", name: "GitHub Light", mode: "light",
    c: { frame: "#f6f8fa", sidebar: "#eef1f4", panel: "#ffffff", editor: "#ffffff", text: "#1f2328", muted: "#59636e", border: "#d1d9e0", accent: "#0969da", accentFg: "#ffffff", ok: "#1a7f37", warn: "#9a6700", danger: "#d1242f" },
    syn: { keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#59636e", fn: "#8250df", type: "#953800", prop: "#0550ae", punct: "#1f2328" },
    ansi: ["#1f2328", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#59636e", "#393f46", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#818b98"],
  },
  {
    id: "github-dark", family: "GitHub", name: "GitHub Dark", mode: "dark",
    c: { frame: "#0d1117", sidebar: "#010409", panel: "#151b23", editor: "#151b23", text: "#f0f6fc", muted: "#9198a1", border: "#3d444d", accent: "#4493f8", accentFg: "#0d1117", ok: "#3fb950", warn: "#d29922", danger: "#f85149" },
    syn: { keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#9198a1", fn: "#d2a8ff", type: "#ffa657", prop: "#79c0ff", punct: "#f0f6fc" },
    ansi: ["#2f3742", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#be8fff", "#39c5cf", "#f0f6fc", "#656c76", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
  },
  {
    id: "solarized-light", family: "Solarized", name: "Solarized Light", mode: "light",
    // contrast: sidebar = base3 (was a base2 blend: text 3.96 -> 4.99); accent = base02 (blue #268bd2 put accentFg at
    // 3.41 on both base3 and base03, no official foreground reaches 4.5); ANSI green/yellow/cyan darkened 5 % toward
    // base02 (2.97/2.98/2.93 -> 3.17/3.19/3.10). Body text stays base01 per the design note.
    c: { frame: "#eee8d5", sidebar: "#fdf6e3", panel: "#fdf6e3", editor: "#fdf6e3", text: "#586e75", muted: "#657b83", border: "#ddd6c1", accent: "#073642", accentFg: "#fdf6e3", ok: "#859900", warn: "#b58900", danger: "#dc322f" },
    syn: { keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#93a1a1", fn: "#268bd2", type: "#b58900", prop: "#6c71c4", punct: "#657b83" },
    ansi: ["#073642", "#dc322f", "#7f9403", "#ac8503", "#268bd2", "#d33682", "#289c94", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "solarized-dark", family: "Solarized", name: "Solarized Dark", mode: "dark",
    // contrast: editor = base03 (Solarized's own dark background; red/magenta were 2.81/2.86 on base02, now 3.25/3.30);
    // accent = cyan #2aa198 with base03 text (blue #268bd2 capped accentFg at 4.08).
    c: { frame: "#002b36", sidebar: "#00212b", panel: "#073642", editor: "#002b36", text: "#93a1a1", muted: "#839496", border: "#0f4552", accent: "#2aa198", accentFg: "#002b36", ok: "#859900", warn: "#b58900", danger: "#dc322f" },
    syn: { keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#657b83", fn: "#268bd2", type: "#b58900", prop: "#6c71c4", punct: "#93a1a1" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "catppuccin-latte", family: "Catppuccin", name: "Catppuccin Latte", mode: "light",
    // contrast: ANSI green/yellow/magenta darkened toward Latte text #4c4f69 (2.96/2.31/2.34 -> 3.09/3.04/3.04); the
    // Latte palette has no darker tone of those hues.
    c: { frame: "#e6e9ef", sidebar: "#dce0e8", panel: "#eff1f5", editor: "#eff1f5", text: "#4c4f69", muted: "#6c6f85", border: "#ccd0da", accent: "#8839ef", accentFg: "#eff1f5", ok: "#40a02b", warn: "#df8e1d", danger: "#d20f39" },
    syn: { keyword: "#8839ef", string: "#40a02b", number: "#fe640b", comment: "#7c7f93", fn: "#1e66f5", type: "#df8e1d", prop: "#7287fd", punct: "#7c7f93" },
    ansi: ["#5c5f77", "#d20f39", "#419c2e", "#ba7e30", "#1e66f5", "#c36cb3", "#179299", "#acb0be", "#6c6f85", "#de293e", "#49af3d", "#eea02d", "#456eff", "#fe85d8", "#2d9fa8", "#bcc0cc"],
  },
  {
    id: "catppuccin-mocha", family: "Catppuccin", name: "Catppuccin Mocha", mode: "dark",
    c: { frame: "#181825", sidebar: "#11111b", panel: "#1e1e2e", editor: "#1e1e2e", text: "#cdd6f4", muted: "#a6adc8", border: "#313244", accent: "#cba6f7", accentFg: "#11111b", ok: "#a6e3a1", warn: "#f9e2af", danger: "#f38ba8" },
    syn: { keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", comment: "#9399b2", fn: "#89b4fa", type: "#f9e2af", prop: "#b4befe", punct: "#9399b2" },
    ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8", "#585b70", "#f37799", "#89d88b", "#ebd391", "#74a8fc", "#f2aede", "#6bd7ca", "#bac2de"],
  },
  {
    id: "rose-pine-dawn", family: "Rosé Pine", name: "Rosé Pine Dawn", mode: "light",
    // contrast: ANSI gold/rose darkened toward Dawn text #464261 (2.16/2.74 -> 3.19/3.04); no darker Dawn tone exists.
    c: { frame: "#faf4ed", sidebar: "#f2e9e1", panel: "#fffaf3", editor: "#fffaf3", text: "#464261", muted: "#797593", border: "#dfdad9", accent: "#286983", accentFg: "#fffaf3", ok: "#286983", warn: "#ea9d34", danger: "#b4637a" },
    syn: { keyword: "#286983", string: "#ea9d34", number: "#d7827e", comment: "#9893a5", fn: "#d7827e", type: "#56949f", prop: "#907aa9", punct: "#797593" },
    ansi: ["#f2e9e1", "#b4637a", "#286983", "#b98242", "#56949f", "#907aa9", "#c97c7b", "#464261", "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#464261"],
  },
  {
    id: "rose-pine", family: "Rosé Pine", name: "Rosé Pine", mode: "dark",
    c: { frame: "#191724", sidebar: "#13111d", panel: "#1f1d2e", editor: "#1f1d2e", text: "#e0def4", muted: "#908caa", border: "#2e2b42", accent: "#c4a7e7", accentFg: "#191724", ok: "#9ccfd8", warn: "#f6c177", danger: "#eb6f92" },
    syn: { keyword: "#31748f", string: "#f6c177", number: "#ebbcba", comment: "#6e6a86", fn: "#ebbcba", type: "#9ccfd8", prop: "#c4a7e7", punct: "#908caa" },
    ansi: ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"],
  },
  {
    id: "gruvbox-light", family: "Gruvbox", name: "Gruvbox Light", mode: "light",
    // contrast: ANSI green/yellow/aqua use Gruvbox's own faded light background variants (2.73/2.19/2.80 -> 4.29/3.33/4.40).
    c: { frame: "#f2e5bc", sidebar: "#ebdbb2", panel: "#fbf1c7", editor: "#fbf1c7", text: "#3c3836", muted: "#7c6f64", border: "#e0d0a6", accent: "#af3a03", accentFg: "#fbf1c7", ok: "#79740e", warn: "#b57614", danger: "#9d0006" },
    syn: { keyword: "#9d0006", string: "#79740e", number: "#8f3f71", comment: "#928374", fn: "#427b58", type: "#b57614", prop: "#076678", punct: "#7c6f64" },
    ansi: ["#3c3836", "#cc241d", "#79740e", "#b57614", "#458588", "#b16286", "#427b58", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"],
  },
  {
    id: "gruvbox-dark", family: "Gruvbox", name: "Gruvbox Dark", mode: "dark",
    // contrast: ANSI red uses Gruvbox's bright red (2.40 -> 3.82); #cc241d is too dark on the dark editor.
    c: { frame: "#282828", sidebar: "#1d2021", panel: "#32302f", editor: "#32302f", text: "#ebdbb2", muted: "#a89984", border: "#45403d", accent: "#fe8019", accentFg: "#1d2021", ok: "#b8bb26", warn: "#fabd2f", danger: "#fb4934" },
    syn: { keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", comment: "#928374", fn: "#8ec07c", type: "#fabd2f", prop: "#83a598", punct: "#a89984" },
    ansi: ["#282828", "#fb4934", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  },
  {
    id: "nord", family: "Nord", name: "Nord", mode: "dark",
    // contrast: editor = nord0 (Nord's own background; red #bf616a was 2.46 on nord1, now 3.05). Panels stay nord1.
    c: { frame: "#2e3440", sidebar: "#292e39", panel: "#3b4252", editor: "#2e3440", text: "#e5e9f0", muted: "#b4bccb", border: "#4c566a", accent: "#88c0d0", accentFg: "#2e3440", ok: "#a3be8c", warn: "#ebcb8b", danger: "#bf616a" },
    syn: { keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#7b88a1", fn: "#88c0d0", type: "#8fbcbb", prop: "#d8dee9", punct: "#eceff4" },
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  },
  {
    id: "tokyo-night", family: "Tokyo Night", name: "Tokyo Night", mode: "dark",
    c: { frame: "#1a1b26", sidebar: "#16161e", panel: "#1f2335", editor: "#1f2335", text: "#c0caf5", muted: "#a9b1d6", border: "#292e42", accent: "#7aa2f7", accentFg: "#16161e", ok: "#9ece6a", warn: "#e0af68", danger: "#f7768e" },
    syn: { keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#565f89", fn: "#7aa2f7", type: "#2ac3de", prop: "#73daca", punct: "#89ddff" },
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#ff899d", "#9fe044", "#faba4a", "#8db0ff", "#c7a9ff", "#a4daff", "#c0caf5"],
  },
  {
    id: "dracula", family: "Dracula", name: "Dracula", mode: "dark",
    c: { frame: "#21222c", sidebar: "#191a21", panel: "#282a36", editor: "#282a36", text: "#f8f8f2", muted: "#b6b9cc", border: "#3b3e4f", accent: "#bd93f9", accentFg: "#21222c", ok: "#50fa7b", warn: "#ffb86c", danger: "#ff5555" },
    syn: { keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", comment: "#6272a4", fn: "#50fa7b", type: "#8be9fd", prop: "#8be9fd", punct: "#f8f8f2" },
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
];

const PRESETS_BY_ID = new Map(THEME_PRESETS.map(preset => [preset.id, preset]));

export function presetById(id: string | undefined): ThemePreset | undefined {
  return id === undefined ? undefined : PRESETS_BY_ID.get(id);
}

export type ThemeFamily = { id: string; name: string; light?: string; dark?: string };

/** Families in picker order; `light`/`dark` are preset ids. Dark-only families have no light variant. */
export const THEME_FAMILIES: readonly ThemeFamily[] = [
  { id: "threadterm", name: "ThreadTerm", light: "threadterm-light", dark: "threadterm-dark" },
  { id: "github", name: "GitHub", light: "github-light", dark: "github-dark" },
  { id: "solarized", name: "Solarized", light: "solarized-light", dark: "solarized-dark" },
  { id: "catppuccin", name: "Catppuccin", light: "catppuccin-latte", dark: "catppuccin-mocha" },
  { id: "rose-pine", name: "Rosé Pine", light: "rose-pine-dawn", dark: "rose-pine" },
  { id: "gruvbox", name: "Gruvbox", light: "gruvbox-light", dark: "gruvbox-dark" },
  { id: "nord", name: "Nord", dark: "nord" },
  { id: "tokyo-night", name: "Tokyo Night", dark: "tokyo-night" },
  { id: "dracula", name: "Dracula", dark: "dracula" },
];

export function familyById(id: string | undefined): ThemeFamily | undefined {
  return id === undefined ? undefined : THEME_FAMILIES.find(family => family.id === id);
}

/** The preset a paired family uses for the given OS appearance; dark-only families ignore it. */
export function familyPreset(familyId: string, systemDark: boolean): ThemePreset | undefined {
  const family = familyById(familyId);
  if (!family) return undefined;
  return presetById(systemDark ? family.dark ?? family.light : family.light ?? family.dark);
}

export function presetsForFamily(familyId: string): readonly ThemePreset[] {
  const family = familyById(familyId);
  if (!family) return [];
  return [family.light, family.dark]
    .map(id => presetById(id))
    .filter((preset): preset is ThemePreset => preset !== undefined);
}
