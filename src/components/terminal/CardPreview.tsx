import { useTranslation } from 'react-i18next';
import { MessageSquareText, Timer } from 'lucide-react';
import type { CardPreview as CardPreviewData } from './cardPreview';
import { isTechnicalPreviewLine } from './cardPreview';

export interface CardPreviewProps {
  preview: CardPreviewData;
  activeFor: string;
  messageCount: number;
}

export function CardPreview({ preview, activeFor, messageCount }: CardPreviewProps) {
  const { t } = useTranslation('terminal');

  if (preview.bodyLines.length === 0) {
    return (
      <div className="text-[11px] italic text-muted-foreground/70">{t('card.noOutput')}</div>
    );
  }

  const previewText = preview.bodyLines.join('\n\n');
  const previewIsProse =
    preview.source === 'reply' && !preview.bodyLines.some(isTechnicalPreviewLine);
  const previewLineClamp =
    preview.bodyLines.length <= 1 ? 8 : preview.bodyLines.length <= 2 ? 7 : 6;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/40 bg-muted/20">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-2.5 py-1 text-[10px]">
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
      <div className="min-h-0 flex-1 overflow-hidden px-2.5 py-1.5">
        {previewIsProse ? (
          <p
            className="whitespace-pre-wrap break-words text-[11.5px] leading-[1.45] text-foreground/75"
            style={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: previewLineClamp,
              overflow: 'hidden',
            }}
          >
            {previewText}
          </p>
        ) : (
          <div className="space-y-1">
            {preview.bodyLines.map((line, index) => {
              const technical = isTechnicalPreviewLine(line);
              return (
                <div
                  key={`${line}-${index}`}
                  className={[
                    'line-clamp-2 break-words rounded-md text-[11px] leading-snug',
                    technical
                      ? 'bg-background/70 px-1.5 py-1 font-mono text-[10.5px] text-foreground/80'
                      : 'text-muted-foreground',
                  ].join(' ')}
                >
                  {line}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
