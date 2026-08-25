import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertHarnessAbsent, invoke, waitForSurface, withMatrixEvidence } from './helpers';

const reportPath = process.env.THREADTERM_WDIO_REPORT;

function record(status: 'passed' | 'failed', harnessCommandsChecked: number, started: number): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence({
    kind: 'public-ui-release-smoke',
    status,
    elapsedMs: Date.now() - started,
    harnessCommandsChecked,
  }))}\n`);
}

describe('production release terminal startup smoke', () => {
  it('waits for the public surface and excludes harness commands', async () => {
    const started = Date.now();
    let harnessCommandsChecked = 0;
    try {
      if ((process.env.THREADTERM_WDIO_ARTIFACT ?? 'production') !== 'production') {
        throw new Error('release-smoke-requires-production-artifact');
      }
      await waitForSurface();
      if (!(await invoke('pty_get_all_session_states', {})).ok) {
        throw new Error('shipping-invoke-transport-unavailable');
      }
      harnessCommandsChecked = await assertHarnessAbsent();
      record('passed', harnessCommandsChecked, started);
    } catch (error) {
      record('failed', harnessCommandsChecked, started);
      throw error;
    }
  });
});
