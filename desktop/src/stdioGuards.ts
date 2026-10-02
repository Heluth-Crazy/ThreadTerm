export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

export function ignoreBrokenStdio(): void {
  const ignore = (error: NodeJS.ErrnoException) => {
    if (isBrokenPipeError(error)) return;
  };
  process.stdout?.on('error', ignore);
  process.stderr?.on('error', ignore);
}
