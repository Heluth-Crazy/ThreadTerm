import { useTranslation } from 'react-i18next';
import { MessageSquareText, Timer } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { CardPreview as CardPreviewData } from './cardPreview';
import { isTechnicalPreviewLine } from './cardPreview';

export interface CardPreviewPanelProps {
  preview: CardPreviewData;
  activeFor: string;
  messageCount: number;
}

function getLineTone(line: string): string {
  if (/\b(error|failed|exception|traceback|panic)\b/i.test(line)) {
    return 'text-destructive';
  }
  if (/\b(warning|warn|deprecated)\b/i.test(line)) {
    return 'text-[hsl(var(--primary))]';
  }
  if (isTechnicalPreviewLine(line)) {
    return 'text-[color:var(--terminal-foreground)] opacity-90';
  }
  return 'text-[color:var(--terminal-foreground)] opacity-65';
}

export function CardPreviewPanel({ preview, activeFor, messageCount }: CardPreviewPanelProps) {
  const { t } = useTranslation('terminal');
  const terminalSurfaceStyle = {
    backgroundColor: 'var(--terminal-background)',
    color: 'var(--terminal-foreground)',
  } satisfies CSSProperties;
  const scanlineStyle = {
    backgroundImage:
      'linear-gradient(to bottom, color-mix(in srgb, var(--terminal-foreground) 22%, transparent) 1px, transparent 1px)',
    backgroundSize: '100% 10px',
  } satisfies CSSProperties;

  if (preview.bodyLines.length === 0) {
    return (
      <div
        data-testid="card-preview-empty"
        className="flex h-full min-h-[120px] items-center justify-center overflow-hidden rounded-lg border border-white/10/40 px-3 text-[11px] italic opacity-65"
        style={terminalSurfaceStyle}
      >
        {t('card.noOutput')}
      </div>
    );
  }

  const summaryLine = preview.summaryLine;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/10/50 shadow-inner"
      style={terminalSurfaceStyle}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10/30 px-2.5 py-1 text-[10px]">
        <span className="min-w-0 truncate font-semibold uppercase tracking-wide text-muted-foreground/80">
          {t(`card.preview.${preview.kind}`, preview.kind)}
        </span>
        <div className="flex shrink-0 items-center gap-2 text-muted-foreground/70">
          <span
            className="inline-flex items-center gap-0.5"
            title={t('card.activeFor', { time: activeFor, defaultValue: activeFor })}
          >
            <Timer className="h-3 w-3" />
            {activeFor}
          </span>
          <span
            className="inline-flex items-center gap-0.5"
            title={t('card.messageCountTitle', {
              count: messageCount,
              defaultValue: `${messageCount}`,
            })}
          >
            <MessageSquareText className="h-3 w-3" />
            {messageCount}
          </span>
          {preview.hiddenLineCount > 0 && (
            <span className="text-[9px] text-muted-foreground/60">
              {t('card.preview.more', { count: preview.hiddenLineCount })}
            </span>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          data-testid="card-preview-thumbnail"
          aria-hidden="true"
          className="absolute inset-0 overflow-hidden px-2.5 py-2 font-mono text-[8px] leading-[1.1]"
        >
          <div
            className="pointer-events-none absolute inset-0 opacity-25"
            style={scanlineStyle}
          />
          <div className="relative space-y-[3px]">
            {preview.bodyLines.map((line, index) => (
              <div
                key={`${line}-${index}`}
                className={[
                  'line-clamp-2 whitespace-pre-wrap break-words rounded-sm',
                  getLineTone(line),
                  isTechnicalPreviewLine(line)
                    ? 'bg-[color-mix(in_srgb,var(--terminal-foreground)_8%,transparent)] px-1'
                    : '',
                ].join(' ')}
              >
                {line}
              </div>
            ))}
          </div>
        </div>
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
          style={{
            background:
              'linear-gradient(to top, color-mix(in srgb, var(--terminal-background) 70%, transparent) 0%, transparent 100%)',
          }}
        />
        {summaryLine && (
          <div
            data-testid="card-preview-summary"
            className="absolute inset-x-0 bottom-0 border-t border-white/10/35 px-2.5 py-1 shadow-[0_-6px_14px_rgba(0,0,0,0.14)] backdrop-blur-sm"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--terminal-background) 66%, hsl(var(--card)) 34%)',
            }}
          >
            <div
              className={[
                'line-clamp-1 break-words font-mono text-[10.5px] leading-snug',
                getLineTone(summaryLine),
              ].join(' ')}
            >
              {summaryLine}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
