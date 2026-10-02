/** One-line file reference handed to an agent session (Chat composer or terminal
 * input). Agents read the file themselves; nothing is sent automatically. */
export type AgentReference = { path:string; startLine?:number; endLine?:number };

export function formatAgentReference({path, startLine, endLine}:AgentReference):string {
 const normalized = path.replace(/\\/g, '/');
 const quoted = /\s/.test(normalized) ? `"${normalized}"` : normalized;
 if(!startLine) return quoted;
 return endLine && endLine > startLine ? `${quoted}:${startLine}-${endLine}` : `${quoted}:${startLine}`;
}

/** Relative to the file's root when the session works in that same root, otherwise absolute. */
export function referencePath(relative:string, fileRoot:string, sessionRoot?:string):string {
 const same = sessionRoot !== undefined && canonical(sessionRoot) === canonical(fileRoot);
 if(same) return relative;
 const separator = fileRoot.includes('\\') ? '\\' : '/';
 return `${fileRoot.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`;
}

const canonical = (path:string) => path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/** Inserts `reference` at the caret with single-space padding. */
export function insertAtCaret(text:string, caret:number, reference:string):{text:string;caret:number} {
 const before = text.slice(0, caret), after = text.slice(caret);
 const lead = before && !/\s$/.test(before) ? ' ' : '';
 const trail = after && !/^\s/.test(after) ? ' ' : after ? '' : ' ';
 const next = `${before}${lead}${reference}${trail}${after}`;
 return {text:next, caret:before.length + lead.length + reference.length + trail.length};
}
