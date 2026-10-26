# Third-party notices

ThreadTerm includes colour data adapted from the community palettes below (ready-made themes in
`renderer/src/themePresets.ts`, terminal colours in `renderer/src/terminalTheme.ts`). No upstream source code is
bundled; only colour values were mapped onto ThreadTerm's colour roles. Each palette stays under its own licence
and copyright (MIT, except Tokyo Night: Apache License 2.0).

## Palettes

| Palette | Upstream project | Copyright | Licence |
| --- | --- | --- | --- |
| GitHub Light / GitHub Dark | GitHub Primer primitives — https://github.com/primer/primitives | Copyright (c) GitHub, Inc. | MIT |
| Solarized Light / Solarized Dark | Solarized — https://github.com/altercation/solarized (Ethan Schoonover) | Copyright (c) 2011 Ethan Schoonover | MIT |
| Catppuccin Latte / Catppuccin Mocha | Catppuccin palette — https://github.com/catppuccin/palette | Copyright (c) 2021 Catppuccin | MIT |
| Rosé Pine Dawn / Rosé Pine | Rosé Pine palette — https://github.com/rose-pine/rose-pine-theme | Copyright (c) 2022 Rosé Pine | MIT |
| Gruvbox Light / Gruvbox Dark | Gruvbox — https://github.com/morhetz/gruvbox | Copyright (c) 2013 Pavel Pertsev | MIT |
| Nord | Nord — https://github.com/nordtheme/nord | Copyright (c) 2016-present Sven Greb | MIT |
| Tokyo Night | Tokyo Night — https://github.com/folke/tokyonight.nvim | Copyright (c) 2021 Folke Lemaitre | Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0) |
| Dracula | Dracula for Visual Studio Code — https://github.com/dracula/visual-studio-code | Copyright (c) 2021 Dracula Theme | MIT |

ThreadTerm Light and ThreadTerm Dark are ThreadTerm's own colours (`renderer/src/styles.css`, this repository's
`LICENSE`).

## Licence text

Tokyo Night's colour values are used under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0); the only modification is the mapping onto ThreadTerm's colour roles.
Every other palette above is used under the MIT License:

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Contrast adjustments to the mockup palette data

`renderer/src/themePresets.test.ts` enforces WCAG ratios for every preset: text >= 4.5:1 on panel, editor and sidebar;
secondary text >= 3:1 on panel and frame; accent text on accent >= 4.5:1; accent on panel >= 3:1; ANSI 1-6 >= 3:1 on
the editor background. Some official colours miss those floors, so the following values differ from
`prototypes/appearance/themes.js`. Two kinds of adjustment are used:

- **Official tone swap** — another colour of the same published palette (e.g. Gruvbox's faded light-background
  variants, Gruvbox's bright red, Solarized `base02`/`base03`).
- **Derived tone** — the palette has no darker or lighter tone of that hue on that surface, so the official colour is
  mixed toward the palette's own darkest/lightest tone by the smallest step that clears the floor. These are marked
  below; they are the only values that are not literal upstream colours.

| Preset | Key | themes.js | Now | Kind | Measured |
| --- | --- | --- | --- | --- | --- |
| solarized-light | sidebar | `#e4ddc6` | `#fdf6e3` (base3) | official | text on sidebar 3.96 -> 4.99 |
| solarized-light | accent | `#268bd2` | `#073642` (base02) | official | accent text on accent 3.41 -> 12.05 |
| solarized-light | ansi[2] green | `#859900` | `#7f9403` | derived (5% toward base02) | 2.97 -> 3.17 |
| solarized-light | ansi[3] yellow | `#b58900` | `#ac8503` | derived (5% toward base02) | 2.98 -> 3.19 |
| solarized-light | ansi[6] cyan | `#2aa198` | `#289c94` | derived (5% toward base02) | 2.93 -> 3.10 |
| solarized-dark | editor | `#073642` | `#002b36` (base03) | official | text 4.86 -> 5.61, ANSI 1 2.81 -> 3.25, ANSI 5 2.86 -> 3.30 |
| solarized-dark | accent / accentFg | `#268bd2` / `#fdf6e3` | `#2aa198` (cyan) / `#002b36` (base03) | official | accent text on accent 3.41 -> 4.75 |
| catppuccin-latte | ansi[2] green | `#40a02b` | `#419c2e` | derived (5% toward Latte text) | 2.96 -> 3.09 |
| catppuccin-latte | ansi[3] yellow | `#df8e1d` | `#ba7e30` | derived (25% toward Latte text) | 2.31 -> 3.04 |
| catppuccin-latte | ansi[5] magenta | `#ea76cb` | `#c36cb3` | derived (25% toward Latte text) | 2.34 -> 3.04 |
| rose-pine-dawn | ansi[3] gold | `#ea9d34` | `#b98242` | derived (30% toward Dawn text) | 2.16 -> 3.19 |
| rose-pine-dawn | ansi[6] rose | `#d7827e` | `#c97c7b` | derived (10% toward Dawn text) | 2.74 -> 3.04 |
| gruvbox-light | ansi[2] green | `#98971a` | `#79740e` | official (faded green) | 2.73 -> 4.29 |
| gruvbox-light | ansi[3] yellow | `#d79921` | `#b57614` | official (faded yellow) | 2.19 -> 3.33 |
| gruvbox-light | ansi[6] aqua | `#689d6a` | `#427b58` | official (faded aqua) | 2.80 -> 4.40 |
| gruvbox-dark | ansi[1] red | `#cc241d` | `#fb4934` | official (bright red) | 2.40 -> 3.82 |
| nord | editor | `#3b4252` | `#2e3440` (nord0) | official | text 8.26 -> 10.26, ANSI 1 2.46 -> 3.05 |

Everything else (all other presets and roles) matches `prototypes/appearance/themes.js` exactly.
