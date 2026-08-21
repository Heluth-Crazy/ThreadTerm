/**
 * Inline brand SVG icons for AI agent terminal types.
 *
 * Source: @lobehub/icons-static-svg v1.94.0 (MIT license), which derives its
 * marks from official brand assets; paths are embedded verbatim (24x24 grid).
 * Third-party trademarks belong to their respective owners and are used solely
 * to identify product compatibility.
 *
 * Variant notes (fetched from cdn.jsdelivr.net on 2026-08-21):
 * - claude:  "claude-color" — coral starburst, fixed brand colour #D97757.
 * - codex:   "codex-color"  — white tile + violet-blue gradient knot.
 * - gemini:  "gemini-color" — blue spark #3186FF with green/red/yellow
 *            gradient overlay passes.
 * - opencode:"opencode"     — monochrome ring rendered via currentColor: the
 *            mark ships as plain black/white (vendor uses both), so it picks
 *            up the surrounding text colour instead of vanishing on one theme.
 * - kimi:    monochrome K-mark geometry filled with Kimi blue #1783FF; the
 *            published colour variant draws its main glyph in white and
 *            assumes a coloured backdrop, which would vanish on light UIs.
 * - grok:    "grok"         — monochrome slash mark via currentColor, same
 *            rationale as opencode.
 */
import type { ComponentType, ReactNode } from 'react';

export type AgentBrandIcon = ComponentType<{ className?: string }>;

interface BrandIconShellProps {
  className?: string;
  children: ReactNode;
  fillRule?: 'evenodd' | 'nonzero';
  /** Stable hook for tests / styling, e.g. "claude" -> data-agent-icon="claude". */
  iconId: string;
}

function BrandIconShell({ className, children, fillRule, iconId }: BrandIconShellProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      fillRule={fillRule}
      data-agent-icon={iconId}
    >
      {children}
    </svg>
  );
}

/** Claude (Anthropic) starburst — official coral. */
export function ClaudeBrandIcon({ className }: { className?: string }) {
  return (
    <BrandIconShell className={className} iconId="claude">
      <path
        fill="#D97757"
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
      />
    </BrandIconShell>
  );
}

/** OpenAI Codex CLI tile — white tile + violet-blue gradient knot. */
export function CodexBrandIcon({ className }: { className?: string }) {
  return (
    <BrandIconShell className={className} iconId="codex">
      <defs>
        <linearGradient id="tt-brand-codex-grad" x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
      <path
        fill="#fff"
        d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
      />
      <path
        fill="url(#tt-brand-codex-grad)"
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
      />
    </BrandIconShell>
  );
}

/** Google Gemini spark — blue base with green/red/yellow gradient passes. */
export function GeminiBrandIcon({ className }: { className?: string }) {
  const spark =
    'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z';
  return (
    <BrandIconShell className={className} iconId="gemini">
      <defs>
        <linearGradient id="tt-brand-gemini-grad-green" x1="7" x2="11" y1="15.5" y2="12" gradientUnits="userSpaceOnUse">
          <stop stopColor="#08B962" />
          <stop offset="1" stopColor="#08B962" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="tt-brand-gemini-grad-red" x1="8" x2="11.5" y1="5.5" y2="11" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F94543" />
          <stop offset="1" stopColor="#F94543" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="tt-brand-gemini-grad-yellow" x1="3.5" x2="17.5" y1="13.5" y2="12" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FABC12" />
          <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={spark} fill="#3186FF" />
      <path d={spark} fill="url(#tt-brand-gemini-grad-green)" />
      <path d={spark} fill="url(#tt-brand-gemini-grad-red)" />
      <path d={spark} fill="url(#tt-brand-gemini-grad-yellow)" />
    </BrandIconShell>
  );
}

/** OpenCode ring — monochrome mark, follows surrounding text colour. */
export function OpencodeBrandIcon({ className }: { className?: string }) {
  return (
    <BrandIconShell className={className} iconId="opencode" fillRule="evenodd">
      <path fill="currentColor" d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
    </BrandIconShell>
  );
}

/** Kimi (Moonshot AI) K-mark — monochrome geometry in Kimi blue. */
export function KimiBrandIcon({ className }: { className?: string }) {
  return (
    <BrandIconShell className={className} iconId="kimi" fillRule="evenodd">
      <path
        fill="#1783FF"
        d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"
      />
      <path
        fill="#1783FF"
        d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"
      />
    </BrandIconShell>
  );
}

/** Grok (xAI) slash mark — monochrome, follows surrounding text colour. */
export function GrokBrandIcon({ className }: { className?: string }) {
  return (
    <BrandIconShell className={className} iconId="grok" fillRule="evenodd">
      <path
        fill="currentColor"
        d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"
      />
    </BrandIconShell>
  );
}
