interface ResumeLoadingOverlayProps {
  label: string;
  progress: number;
  visible: boolean;
}

export function ResumeLoadingOverlay({
  label,
  progress,
  visible,
}: ResumeLoadingOverlayProps) {
  return (
    <div
      hidden={!visible}
      aria-hidden={!visible}
      data-testid="resume-loading-overlay"
      className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--terminal-background)] px-6"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="w-full max-w-sm">
        <div className="mb-3 flex items-center justify-between gap-4 text-sm text-[var(--terminal-foreground)]">
          <span className="truncate font-medium">{label}</span>
          <span className="w-11 shrink-0 text-right font-mono tabular-nums">
            {progress}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          data-state="determinate"
          className="h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--terminal-foreground)_12%,transparent)]"
        >
          <div
            data-testid="resume-loading-progress-fill"
            className="relative h-full overflow-hidden rounded-full bg-[var(--terminal-cursor)] shadow-[0_0_10px_color-mix(in_srgb,var(--terminal-cursor)_45%,transparent)] transition-[width] duration-200 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
