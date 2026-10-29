import type { ReviewDiff } from '@threadterm/protocol';

export type ReviewDiffRefresh = {scope:string;ticket:number;diff?:ReviewDiff;text:string;conflict?:ReviewDiff|true};
export type ReviewOverwrite = {scope:string;fingerprint:string};
/** A current-side draft depends on both its line anchors and the availability of the text surface. */
export function reviewDraftNeedsDeferral(before:ReviewDiff|undefined, next:ReviewDiff):boolean {
 return Boolean(before && (before.newText!==next.newText || before.binary!==next.binary || before.exists!==next.exists));
}
/** Reconcile against the text at response time, including edits made during the request. */
export function receiveReviewDiff(state:ReviewDiffRefresh, scope:string, ticket:number, value:ReviewDiff, discardText?:string):ReviewDiffRefresh {
 if(state.scope!==scope || state.ticket!==ticket) return state;
 // Confirmation authorizes replacing the captured text, not edits typed after confirmation.
 if(discardText!==undefined && state.text!==discardText) return {...state,conflict:value};
 if(discardText===undefined && state.diff && state.text!==state.diff.newText) {
  return {...state,conflict:state.conflict || value.fingerprint!==state.diff.fingerprint ? value : undefined};
 }
 return {...state,diff:value,text:value.newText,conflict:undefined};
}
/** Ordinary Save is fenced off in conflict; explicit overwrite uses the latest observed disk version. */
export function reviewSaveFingerprint(state:ReviewDiffRefresh, overwrite?:ReviewOverwrite):string|undefined {
 if(!state.diff || state.text===state.diff.newText) return;
 if(overwrite) return overwrite.scope===state.scope && state.conflict && state.conflict!==true && state.conflict.fingerprint===overwrite.fingerprint ? overwrite.fingerprint : undefined;
 if(state.conflict) return;
 return state.diff.fingerprint;
}
