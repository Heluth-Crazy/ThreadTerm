import { canOpenWithSystemApp, openWithSystemApp, type OpenFileAppTarget } from '../openFileApp';

/** R20 in an error row: absent on remote machines and for extensions outside the allow list. */
export function OpenWithSystemAppButton({ target, zh, onIssue, testId }: {
  target: OpenFileAppTarget;
  zh: boolean;
  onIssue?: (message: string) => void;
  testId?: string;
}) {
  if (!canOpenWithSystemApp(target.path)) return null;
  return <button type="button" className="btn btn-sm" data-testid={testId ?? 'open-with-system-app'}
    onClick={() => void openWithSystemApp(target, zh, onIssue)}>{zh ? '用系统应用打开' : 'Open with system app'}</button>;
}
