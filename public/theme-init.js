/*
 * Pre-paint theme bootstrap — keeps the first frame dark for dark-mode users.
 *
 * index.css ships light `:root` variables and the real theme is applied by
 * applySavedTheme() only after the JS bundle loads, so dark-mode users saw a
 * light flash on startup. Loaded as an external classic script (synchronous,
 * before first paint) because production CSP is `script-src 'self'` — inline
 * scripts are blocked. It mirrors getStoredThemePreference() +
 * resolveThemeMode() from src/theme/, but only reproduces the `.dark` class
 * and color-scheme; pack tokens still arrive via JS (duplicating the hex→HSL
 * token pipeline here is not worth the drift risk).
 */
try {
  var mode = window.localStorage.getItem('themeMode');
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
    var legacy = window.localStorage.getItem('theme');
    mode = legacy === 'light' || legacy === 'dark' ? legacy : 'system';
  }
  var dark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  }
} catch (err) {
  /* localStorage/matchMedia unavailable — fall back to the light default. */
}
