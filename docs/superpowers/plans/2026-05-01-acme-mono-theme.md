# Acme Mono Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Acme Mono` as a selectable dark-only theme pack that restyles the app and terminal globally through theme tokens plus non-layout CSS overrides.

**Architecture:** The implementation has two layers. First, register `Acme Mono` in the existing theme pack system with a complete dark app palette and terminal palette, plus localized Settings copy. Second, add `html[data-theme-pack="acme-mono"]` CSS overrides for typography, borders, surfaces, buttons, badges, inputs, and shadows without changing layout rules.

**Tech Stack:** React, Vite, Tailwind CSS, Vitest, happy-dom, existing ThreadTerm theme pack system

---

## File Structure

- Modify: `src/theme/themePacks.ts`
  Responsibility: define the `Acme Mono` app tokens, terminal tokens, and register the new bundled theme pack.
- Modify: `src/theme/themePacks.test.ts`
  Responsibility: assert the new bundled theme exists, remains dark-only, and resolves correctly.
- Create: `src/theme/applyTheme.test.ts`
  Responsibility: verify `applyResolvedTheme` writes `data-theme-pack="acme-mono"` and the expected CSS variables to `document.documentElement`.
- Modify: `src/index.css`
  Responsibility: add theme-scoped, non-layout CSS overrides for the `Acme Mono` look.
- Modify: `src/components/ui/button.tsx`
  Responsibility: add a stable theme hook attribute so global CSS can target primitive buttons precisely.
- Modify: `src/components/ui/badge.tsx`
  Responsibility: add a stable theme hook attribute so global CSS can target primitive badges precisely.
- Modify: `src/i18n/locales/en/settings.json`
  Responsibility: add the bundled theme description shown in the Settings theme picker.
- Modify: `src/i18n/locales/zh-CN/settings.json`
  Responsibility: add the Simplified Chinese description for the bundled theme picker.
- Modify: `src/i18n/locales/ja/settings.json`
  Responsibility: add the Japanese description for the bundled theme picker.
- Modify: `src/i18n/locales/ko/settings.json`
  Responsibility: add the Korean description for the bundled theme picker.

## Task 1: Add Failing Theme Coverage

**Files:**
- Create: `src/theme/applyTheme.test.ts`
- Modify: `src/theme/themePacks.test.ts`

- [ ] **Step 1: Add a failing bundled-theme test to `src/theme/themePacks.test.ts`**

Add these two cases near the existing `describe('themePacks tokens', ...)` block:

```ts
it('registers Acme Mono as a bundled dark-only theme', () => {
  const acmeMono = themePacks.find((pack) => pack.id === 'acme-mono');

  expect(acmeMono).toBeDefined();
  expect(acmeMono?.name).toBe('Acme Mono');
  expect(acmeMono?.modes.dark).toBeDefined();
  expect(acmeMono?.modes.light).toBeUndefined();
});

it('falls back to dark mode when Acme Mono is requested in light mode', () => {
  const resolved = resolveTheme('acme-mono', 'light');

  expect(resolved.pack.id).toBe('acme-mono');
  expect(resolved.mode).toBe('dark');
});
```

- [ ] **Step 2: Add a failing DOM application test in `src/theme/applyTheme.test.ts`**

Create the file with this content:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { applyResolvedTheme, hexToHslToken, resolveTheme } from './applyTheme';

describe('applyResolvedTheme', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#ffffff" />';
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme-pack');
    document.documentElement.style.cssText = '';
  });

  it('writes Acme Mono theme metadata and CSS variables to the root element', () => {
    const resolved = resolveTheme('acme-mono', 'dark');

    applyResolvedTheme(resolved);

    expect(document.documentElement.dataset.themePack).toBe('acme-mono');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(
      hexToHslToken(resolved.tokens.app.background),
    );
    expect(document.documentElement.style.getPropertyValue('--terminal-background')).toBe(
      resolved.tokens.terminal.background,
    );
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      resolved.tokens.app.background,
    );
  });
});
```

- [ ] **Step 3: Run the focused theme tests to verify they fail**

Run: `npx vitest run src/theme/themePacks.test.ts src/theme/applyTheme.test.ts`

Expected:
- `registers Acme Mono as a bundled dark-only theme` fails because `acme-mono` is missing
- `writes Acme Mono theme metadata and CSS variables to the root element` fails because `resolveTheme('acme-mono', 'dark')` falls back to the default pack

## Task 2: Implement the Acme Mono Theme Pack

**Files:**
- Modify: `src/theme/themePacks.ts`
- Modify: `src/i18n/locales/en/settings.json`
- Modify: `src/i18n/locales/zh-CN/settings.json`
- Modify: `src/i18n/locales/ja/settings.json`
- Modify: `src/i18n/locales/ko/settings.json`
- Test: `src/theme/themePacks.test.ts`
- Test: `src/theme/applyTheme.test.ts`

- [ ] **Step 1: Define the Acme Mono terminal palette in `src/theme/themePacks.ts`**

Add this constant near the other theme-mode definitions:

```ts
const acmeMonoDark = mode(
  {
    background: '#0a0a0a',
    foreground: '#f5f5f0',
    card: '#111111',
    cardForeground: '#f5f5f0',
    popover: '#141414',
    popoverForeground: '#f5f5f0',
    primary: '#f2f2f2',
    primaryForeground: '#0a0a0a',
    secondary: '#1a1a1a',
    secondaryForeground: '#ededed',
    muted: '#181818',
    mutedForeground: '#9a9a95',
    accent: '#202020',
    accentForeground: '#f5f5f0',
    destructive: '#c84b4b',
    destructiveForeground: '#fff7f7',
    border: '#2a2a2a',
    input: '#343434',
    ring: '#d6d6d1',
  },
  terminal('#0b0b0b', '#e8e6e3', '#f2f2f2', '#0b0b0b', '#2a2a2a', '#f5f5f0', [
    '#121212',
    '#c16a6a',
    '#8fa87a',
    '#c7ab6d',
    '#93a7c7',
    '#b39ac7',
    '#8fb8b3',
    '#cfcac2',
    '#5a5a5a',
    '#d98989',
    '#a7bf91',
    '#d9bf84',
    '#a9bfdc',
    '#c5b1d8',
    '#a7d0ca',
    '#f4f1eb',
  ]),
);
```

- [ ] **Step 2: Register the bundled theme in the `themePacks` array**

Insert a new entry before the third-party themes begin:

```ts
{
  id: 'acme-mono',
  name: 'Acme Mono',
  description: 'Monochrome editorial surfaces with crisp borders and a restrained terminal palette.',
  attribution: {
    kind: 'original',
    sourceName: 'ThreadTerm',
    sourceUrl: 'https://github.com/Heluth-Crazy/ThreadTerm',
  },
  modes: {
    dark: acmeMonoDark,
  },
},
```

- [ ] **Step 3: Add localized theme descriptions to the Settings locale files**

Update the `appearanceSettings.themePack.descriptions` object in each file with these exact entries:

`src/i18n/locales/en/settings.json`

```json
"acme-mono": "Monochrome editorial surfaces with crisp borders and a restrained terminal palette."
```

`src/i18n/locales/zh-CN/settings.json`

```json
"acme-mono": "黑白冷灰界面，搭配清晰边框和克制的终端配色。"
```

`src/i18n/locales/ja/settings.json`

```json
"acme-mono": "モノクロ基調のエディトリアルな表情に、シャープな境界線と抑制したターミナル配色を組み合わせたテーマ。"
```

`src/i18n/locales/ko/settings.json`

```json
"acme-mono": "흑백 중심의 에디토리얼 분위기에 또렷한 경계선과 절제된 터미널 팔레트를 더한 테마입니다."
```

- [ ] **Step 4: Run the focused theme tests to verify they pass**

Run: `npx vitest run src/theme/themePacks.test.ts src/theme/applyTheme.test.ts`

Expected:
- both test files pass
- the existing readability assertions still pass with the new palette

- [ ] **Step 5: Commit the working theme-pack foundation**

```bash
git add src/theme/themePacks.ts src/theme/themePacks.test.ts src/theme/applyTheme.test.ts src/i18n/locales/en/settings.json src/i18n/locales/zh-CN/settings.json src/i18n/locales/ja/settings.json src/i18n/locales/ko/settings.json
git commit -m "feat: add Acme Mono theme pack"
```

## Task 3: Add Theme-Scoped Global CSS Polish

**Files:**
- Modify: `src/index.css`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/badge.tsx`

- [ ] **Step 1: Add stable primitive hooks to `Button` and `Badge`**

Update the rendered elements so the theme CSS can target them precisely:

`src/components/ui/button.tsx`

```tsx
      <Comp
        data-ui="button"
        type={asChild ? undefined : type}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
```

`src/components/ui/badge.tsx`

```tsx
  return <span data-ui="badge" className={cn(badgeVariants({ variant, className }))} {...props} />;
```

- [ ] **Step 2: Add `Acme Mono` theme-scoped CSS to `src/index.css`**

Append a block like this near the end of the base layer. Keep every selector scoped to `html[data-theme-pack="acme-mono"]` and avoid layout properties:

```css
  html[data-theme-pack="acme-mono"] {
    --radius: 0.375rem;
  }

  html[data-theme-pack="acme-mono"] body {
    font-family: "IBM Plex Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    letter-spacing: 0.01em;
    background-image: radial-gradient(circle at top, rgba(255, 255, 255, 0.035), transparent 42%);
  }

  html[data-theme-pack="acme-mono"] [data-ui="button"] {
    border-color: hsl(var(--border));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  html[data-theme-pack="acme-mono"] [data-ui="button"][class*="bg-primary"] {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(220, 220, 220, 0.92));
    color: #0b0b0b;
  }

  html[data-theme-pack="acme-mono"] [data-ui="button"][class*="border"] {
    background: rgba(255, 255, 255, 0.02);
  }

  html[data-theme-pack="acme-mono"] [data-ui="badge"] {
    border-color: hsl(var(--border));
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  html[data-theme-pack="acme-mono"] input,
  html[data-theme-pack="acme-mono"] textarea,
  html[data-theme-pack="acme-mono"] select {
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  html[data-theme-pack="acme-mono"] .shadow-sm,
  html[data-theme-pack="acme-mono"] .shadow-md,
  html[data-theme-pack="acme-mono"] .shadow-2xl {
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.03), 0 12px 32px rgba(0, 0, 0, 0.32);
  }

  html[data-theme-pack="acme-mono"] ::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.14);
  }
```

- [ ] **Step 3: Run the production build to verify the CSS compiles cleanly**

Run: `npm run build`

Expected:
- Vite build completes successfully
- no CSS syntax errors
- output includes the normal `dist/` assets

- [ ] **Step 4: Commit the theme-scoped CSS pass**

```bash
git add src/index.css src/components/ui/button.tsx src/components/ui/badge.tsx
git commit -m "feat: add Acme Mono global theme styling"
```

## Task 4: Run Full Verification and Manual QA

**Files:**
- No planned file edits

- [ ] **Step 1: Run the full automated verification suite**

Run:

```bash
npm run typecheck
npx vitest run
npm run build
```

Expected:
- `typecheck` exits 0
- all Vitest files pass
- production build exits 0

- [ ] **Step 2: Start local dev and verify the theme manually**

Run:

```bash
npm run client
```

Then verify this checklist with `Acme Mono` selected in Settings:

- the theme picker shows `Acme Mono`
- selecting it keeps the app in dark mode even if mode is set to `Light`
- Settings, session cards, overlays, inputs, buttons, and badges shift to the dark monochrome look
- the terminal background, cursor, selection, and ANSI palette change with the theme
- layout spacing and component structure remain unchanged

- [ ] **Step 3: If QA reveals visual bugs, fix them before closing the task**

If you change files during QA, rerun:

```bash
npm run typecheck
npx vitest run
npm run build
```

Expected:
- all three commands still pass after the fix

## Self-Review

- Spec coverage: the plan covers bundled theme registration, dark-only fallback behavior, localized Settings copy, theme-scoped CSS overrides, terminal palette updates, and automated plus manual verification.
- Placeholder scan: no `TBD`, `TODO`, or “implement later” placeholders remain.
- Type consistency: `acme-mono` is used consistently across tests, theme pack registration, locale copy, and CSS scoping.
