import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopDialogAction } from './desktopNavigation';

test('desktop navigation opens only the requested remote-machine dialog with scoped session defaults', () => {
  assert.deepEqual(desktopDialogAction({action:'new-session',projectId:'project-1',path:'C:/host/main'}), {kind:'new-session',projectId:'project-1',path:'C:/host/main'});
  assert.deepEqual(desktopDialogAction({action:'add-project'}), {kind:'add-project'});
  assert.equal(desktopDialogAction({action:'computers'}), undefined);
  assert.equal(desktopDialogAction({sessionId:'session-1'}), undefined);
});
