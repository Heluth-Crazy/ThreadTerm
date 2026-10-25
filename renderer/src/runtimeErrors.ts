/** Electron rethrows a rejected IPC call as `Error invoking remote method '<channel>': <Name>Error: <message>`. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*'[,:]\s*/i;
const ERROR_NAME = /^(?:[A-Za-z_$][\w$]*)?Error:\s*/;
/** Diagnostic codes are lower snake_case; prose and localized sentences are not. */
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+/;

function unwrap(error: unknown): string | undefined {
 const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
 const text = raw.replace(IPC_WRAPPER, '').replace(ERROR_NAME, '').trim();
 return text || undefined;
}

/** The runtime's message without the IPC wrapper and error name, for readable fallbacks. */
export function runtimeErrorText(error: unknown): string | undefined {
 return unwrap(error);
}

/**
 * The diagnostic code of a rejected runtime request (`revision_conflict`, or the leading token of
 * `invalid_group_file: Choose a file…`), or undefined when the message carries prose instead.
 */
export function runtimeErrorCode(error: unknown): string | undefined {
 const text = unwrap(error);
 if (!text) return undefined;
 const code = CODE.exec(text)?.[0];
 if (!code) return undefined;
 const rest = text.slice(code.length);
 return rest && !/^[:\s]/.test(rest) ? undefined : code;
}
