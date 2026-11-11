/** Which viewer an Office file needs, from its extension only (`design.md` §2, PRD D6).
 * The signature check happens in the sheet core, never here: the renderer must not read bytes
 * to decide, and a mismatch has to reach the user as `unsupported_document`. */
export type OfficeKind = 'sheet' | 'docx';

/** Excel: `.xlsx .xlsm .xlsb .xls .ods`; Word: `.docx .docm`. Legacy `.doc` stays out (D6). */
const extensions: Readonly<Record<string, OfficeKind>> = {
  '.xlsx': 'sheet',
  '.xlsm': 'sheet',
  '.xlsb': 'sheet',
  '.xls': 'sheet',
  '.ods': 'sheet',
  // Word is step 5; until then the branch keeps today's behaviour.
  '.docx': 'docx',
  '.docm': 'docx',
};

/** Case-insensitive, on the last dot only; a name without a dot is no Office file. */
export function officeKind(path: string): OfficeKind | undefined {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return extensions[name.slice(dot).toLowerCase()];
}

/** Excel files are previewed as a sheet in step 2; Word waits for its viewer. */
export const isSheetPath = (path: string) => officeKind(path) === 'sheet';
