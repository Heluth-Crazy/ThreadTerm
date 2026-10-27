// Electron glue for background images (task 10-26 phase D): the privileged `threadterm-bg:` scheme, its protocol
// handler and the IPC the renderer calls. Every rule lives in backgroundImagesCore.ts; this file only wires Electron
// to it, so the storage rules stay unit-testable without an Electron process.
import { app, BrowserWindow, dialog, ipcMain, type CustomScheme, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  BACKGROUND_IMAGE_SCHEME,
  backgroundErrorCode,
  BackgroundImageError,
  backgroundRequestPath,
  listBackgroundImages,
  parseBackgroundUrl,
  pruneBackgroundImages,
  qaBackgroundPickOverride,
  readBackgroundSource,
  removeBackgroundImage,
  storeBackgroundImage,
  storeBackgroundVariant,
} from './backgroundImagesCore.js';

/** The store lives next to the rest of the desktop profile: originals and the manifest are backed up. */
export function backgroundImagesFolder(profileDir: string = app.getPath('userData')): string {
  return join(profileDir, 'backgrounds');
}

/** Registered by main.ts in the same `registerSchemesAsPrivileged` call as the HTML preview scheme (Electron keeps
 * only the last call), before `app.whenReady()` finishes. */
export const BACKGROUND_IMAGE_PRIVILEGED_SCHEME: CustomScheme = {
  scheme: BACKGROUND_IMAGE_SCHEME,
  // `corsEnabled` + an ACAO header keep a canvas untainted, so the renderer can bake a blur variant from the served
  // original without a second copy of the bytes crossing IPC.
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

const responseHeaders = {
  'Content-Type': 'image/webp',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
};

function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Serves exactly the two URL shapes from the two store folders; never follows a path from the URL. */
export async function backgroundImageResponse(folder: string, rawUrl: string, method = 'GET'): Promise<Response> {
  if (method !== 'GET') return notFound();
  const request = parseBackgroundUrl(rawUrl);
  if (!request) return notFound();
  let bytes: Buffer;
  try { bytes = await fs.readFile(backgroundRequestPath(folder, request)); }
  catch { return notFound(); }
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), { status: 200, headers: responseHeaders });
}

export function installBackgroundImageSession(sessionApi: Pick<Electron.Session, 'protocol'>, folder: string): void {
  sessionApi.protocol.handle(BACKGROUND_IMAGE_SCHEME, request => backgroundImageResponse(folder, request.url, request.method));
}

export interface BackgroundIpcOptions {
  folder: string;
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  isPackaged: boolean;
  /** Read at call time so a QA harness can set it after the app started. */
  pickOverride?: () => string | undefined;
}

/** Throws away Electron's wrapper text so the renderer sees the translatable code first. */
function withCode(error: unknown): never {
  const code = backgroundErrorCode(error);
  throw code ? new BackgroundImageError(code, (error as Error).message.replace(`${code}: `, '')) : error;
}

export function registerBackgroundImageIpc(options: BackgroundIpcOptions): void {
  const { folder, assertTrusted, isPackaged } = options;
  const pickOverride = options.pickOverride ?? (() => process.env.THREADTERM_V3_PICK_BACKGROUND_QA);
  const guard = (event: IpcMainInvokeEvent, run: () => Promise<unknown>) => {
    assertTrusted(event);
    return run().catch(withCode);
  };

  ipcMain.handle('threadterm:background-pick', event => guard(event, async () => {
    const qaPath = qaBackgroundPickOverride(pickOverride(), isPackaged);
    let path = qaPath;
    if (!path) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        title: 'Choose a background image',
        properties: ['openFile'] as Electron.OpenDialogOptions['properties'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp'] }],
      };
      const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || !result.filePaths[0]) return null;
      path = result.filePaths[0];
    }
    return readBackgroundSource(path);
  }));

  ipcMain.handle('threadterm:background-read-source', (event, path: unknown) => guard(event, () => readBackgroundSource(path)));
  ipcMain.handle('threadterm:background-store', (event, input: unknown) => guard(event, () => storeBackgroundImage(folder, record(input))));
  ipcMain.handle('threadterm:background-store-variant', (event, input: unknown) => guard(event, () => storeBackgroundVariant(folder, record(input))));
  ipcMain.handle('threadterm:background-list', event => guard(event, () => listBackgroundImages(folder)));
  ipcMain.handle('threadterm:background-remove', (event, id: unknown) => guard(event, () => removeBackgroundImage(folder, id)));
  ipcMain.handle('threadterm:background-prune', (event, keepIds: unknown) => guard(event, () => {
    if (!Array.isArray(keepIds) || keepIds.length > 1000) throw new BackgroundImageError('background_image_unreadable', 'invalid keep list');
    return pruneBackgroundImages(folder, keepIds);
  }));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackgroundImageError('background_image_unreadable', 'invalid request');
  return value as Record<string, unknown>;
}
