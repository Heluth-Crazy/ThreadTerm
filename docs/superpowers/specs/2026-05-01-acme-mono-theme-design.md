# Acme Mono Theme Design

Date: 2026-05-01
Status: Approved for planning

## Goal

Add a new selectable theme pack named `Acme Mono` that applies a dark, high-contrast monochrome visual style across the app and terminal without changing layout structure.

The theme must:

- appear in the existing theme picker
- support dark mode only
- change app UI colors through the existing theme pack token system
- change terminal colors through the existing terminal token system
- apply additional non-layout visual overrides through global CSS scoped to the theme pack

The theme must not:

- replace the default theme
- change spacing, grid, sizing, content order, or panel layout
- introduce page-specific layout forks

## User Outcome

When a user selects `Acme Mono` in Settings, the whole app should shift to a restrained black, white, and cold-gray visual language. Buttons, cards, badges, inputs, borders, hover states, and terminal colors should all feel like part of the same theme, while the underlying component structure remains unchanged.

## Current Context

The codebase already has:

- theme pack definitions in [src/theme/themePacks.ts](../../../src/theme/themePacks.ts)
- theme token types in [src/theme/themeTypes.ts](../../../src/theme/themeTypes.ts)
- runtime theme application in [src/theme/applyTheme.ts](../../../src/theme/applyTheme.ts)
- theme selection UI in [src/components/Settings.jsx](../../../src/components/Settings.jsx)
- global CSS variables and base styles in [src/index.css](../../../src/index.css)

This means the missing piece is not theme infrastructure. The missing piece is a new theme pack plus theme-specific CSS for visual traits not fully captured by color tokens alone.

## Scope

### In Scope

- add `Acme Mono` as a new theme pack
- provide a dark app token palette
- provide a dark terminal token palette
- add theme metadata so it appears correctly in Settings
- add global CSS overrides under `html[data-theme-pack="acme-mono"]`
- restyle only non-layout properties for shared surfaces and controls

### Out of Scope

- changing page layout
- changing component hierarchy
- adding new theme settings UI
- redesigning feature-specific screens one by one
- introducing light mode support for `Acme Mono`
- refactoring components solely to support this theme unless a small hook is required for correct scoping

## Visual Direction

`Acme Mono` should read as editorial, quiet, and utilitarian rather than glossy or colorful.

Primary visual traits:

- near-black app background with slightly lifted panel surfaces
- off-white foreground text rather than pure white everywhere
- low-saturation cold-gray borders and dividers
- muted emphasis color usage, with action states driven more by contrast than hue
- monospace-leaning personality through selective typography treatment, while preserving readability
- flatter shadows and crisper edges than the current default theme

The target is a strong dark monochrome product style, not a complete recreation of the reference image at the layout level.

## Architecture

The implementation is split into two layers.

### Layer 1: Theme Pack Tokens

Add a new theme pack entry in [src/theme/themePacks.ts](../../../src/theme/themePacks.ts) with:

- `id: "acme-mono"`
- `name: "Acme Mono"`
- a short description for the Settings UI
- attribution marked as project-original unless a more specific attribution is needed
- a single `dark` mode entry

This layer will define:

- app tokens for background, foreground, card, popover, border, input, accent, muted, primary, destructive, and ring
- terminal tokens for background, foreground, cursor, selection, and ANSI colors

This layer is responsible for all variable-driven styling.

### Layer 2: Theme-Scoped CSS Overrides

Add a new global override block in [src/index.css](../../../src/index.css) scoped to:

```css
html[data-theme-pack="acme-mono"]
```

This layer will handle non-layout visual styling that tokens alone cannot express cleanly, including:

- font stack adjustments
- card and panel surface feel
- button and badge surface treatment
- border sharpness
- shadow intensity
- hover, focus, and active visual behavior
- scrollbar tone

This layer must not change:

- spacing
- flex and grid structure
- width or height rules
- breakpoint behavior

## Component Strategy

The theme should rely on existing shared primitives and global classes instead of page-specific rewrites.

Priority targets:

- `body`, shared surfaces, and modal shells
- `Button` and `Badge` primitives
- form controls that use theme CSS variables
- panel and card containers already built on `bg-card`, `border-border`, `text-foreground`, `bg-background`, and related tokens

Because much of the UI already uses semantic Tailwind tokens, a large portion of the visual shift should come from the theme pack itself. The scoped CSS exists to deepen the theme character without rewriting component markup.

## Data Flow

Theme selection remains unchanged:

1. User selects `Acme Mono` in Settings.
2. `ThemeContext` resolves the active theme pack.
3. `applyResolvedTheme` writes app and terminal tokens to CSS variables on `document.documentElement`.
4. The root element receives `data-theme-pack="acme-mono"`.
5. Token-driven styles update immediately.
6. Theme-scoped CSS rules matching `html[data-theme-pack="acme-mono"]` apply the extra non-layout polish.

No new persistence logic or state shape is required.

## Error Handling and Fallbacks

- If `Acme Mono` is selected while theme mode is `light`, the existing resolver should fall back to the pack's available `dark` mode.
- If any token is missing, TypeScript and existing theme tests should catch it before runtime.
- If a CSS override is too broad, the failure mode should be visual only, not structural. Keep selectors narrow and theme-scoped.

## Testing Strategy

### Automated

- extend or satisfy existing theme pack tests so `Acme Mono` passes token completeness checks
- run app typecheck
- run frontend tests to confirm no regressions from theme additions
- run production build to ensure theme assets and CSS compile cleanly

### Manual

Verify with `Acme Mono` selected:

- Settings theme picker shows the new theme
- app background, cards, buttons, badges, inputs, and text shift to the new visual style
- no layout movement occurs in Settings, shell panels, overlays, or dialogs
- terminal colors change with the theme
- hover and focus states remain visible and accessible

Manual checks should cover at least:

- Settings
- main terminal manager view
- selector / overlay surfaces if available in local dev

## Implementation Notes

- Keep the first pass global and restrained. Do not chase every component-specific edge case unless it clearly breaks the theme.
- Prefer semantic token usage over hardcoded ad hoc values where possible.
- Use theme-scoped CSS only for style traits that cannot be expressed well with the existing token model.
- If the first pass reveals repeated non-layout needs that do not fit tokens, document them for a follow-up expansion of the theme system rather than widening scope mid-task.

## Risks

### Theme Too Weak

If the work only changes color tokens, the result may still feel too close to the default theme. The scoped CSS layer exists specifically to avoid that weak outcome.

### Theme Too Broad

If selectors are written too generically, the theme could accidentally alter layout or affect unrelated states. Scope every enhancement under the theme pack selector and avoid changing spacing or display properties.

### Primitive Drift

If shared primitives like `Button` and `Badge` are restyled in a way that assumes only `Acme Mono`, other themes could regress. Any primitive adjustment must remain theme-agnostic unless guarded by theme-specific selectors.

## Acceptance Criteria

- `Acme Mono` appears as a selectable theme in Settings
- selecting it applies a distinct dark monochrome app theme globally
- selecting it also updates terminal colors
- layout and spacing remain unchanged
- the implementation uses theme tokens plus theme-scoped CSS overrides
- typecheck, tests, and build pass
