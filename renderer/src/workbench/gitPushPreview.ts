import type { GitPushPreview } from '@threadterm/protocol';

export function pushDestination(preview:Pick<GitPushPreview,'branch'|'remote'|'remoteBranch'|'setUpstream'>, zh:boolean) {
 const destination=`${preview.remote}/${preview.remoteBranch}`;
 if(preview.setUpstream) return zh ? `发布 ${preview.branch} → ${destination}（设置上游）` : `Publish ${preview.branch} → ${destination} (sets upstream)`;
 return zh ? `推送 ${preview.branch} → ${destination}` : `Push ${preview.branch} → ${destination}`;
}

/** Remote HEAD is authoritative; main/master are the documented fallback when it is unavailable. */
export function requiresForcePushBranchConfirmation(preview:Pick<GitPushPreview,'remoteBranch'|'remoteDefaultBranch'>) {
 return preview.remoteDefaultBranch ? preview.remoteBranch===preview.remoteDefaultBranch : preview.remoteBranch==='main'||preview.remoteBranch==='master';
}

export type PushRejectionAction = 'force'|'refresh'|'review'|undefined;
export function pushRejectionAction(error:unknown):PushRejectionAction {
 const message=error instanceof Error ? error.message : String(error);
 if(/push_rejected_non_ff/.test(message)) return 'force';
 if(/push_lease_stale/.test(message)) return 'refresh';
 if(/push_destination_changed/.test(message)) return 'review';
 return undefined;
}
