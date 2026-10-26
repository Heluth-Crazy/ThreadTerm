let paletteStyle: HTMLStyleElement | undefined;

/** Keep Settings usable even when the workspace draft has unreadable colours. Computed custom properties also
 * preserve the shared derived fills, focus rings and shadows without duplicating their definitions. */
export function captureSettingsPalette(mode: 'light' | 'dark'): void {
  if (typeof getComputedStyle !== 'function' || !document.head) return;
  const saved = getComputedStyle(document.documentElement);
  if (!paletteStyle) {
    paletteStyle = document.createElement('style');
    paletteStyle.dataset.settingsSavedPalette = 'true';
    document.head.append(paletteStyle);
    paletteStyle.sheet!.insertRule(':where(.settings-drawer, .settings-theme-import) {}');
  }
  const style = (paletteStyle.sheet!.cssRules[0] as CSSStyleRule).style;
  style.cssText = '';
  for (let index = 0; index < saved.length; index += 1) {
    const name = saved[index];
    if (name.startsWith('--')) style.setProperty(name, saved.getPropertyValue(name));
  }
  style.colorScheme = mode;
}

export function clearSettingsPalette(): void {
  paletteStyle?.remove();
  paletteStyle = undefined;
}
