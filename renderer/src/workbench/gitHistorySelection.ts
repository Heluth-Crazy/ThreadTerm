/** Loaded rows cannot establish repository-wide prefix uniqueness; only the matching backend result selects a row. */
export function resolveGitHistoryTarget(target:string|undefined, hashes:readonly string[], resolved?:{target:string;hash:string}) {
 return target&&resolved?.target===target&&hashes.includes(resolved.hash)?resolved.hash:undefined;
}

/** A newly loaded page only gives the list a default row when no external target is active. */
export function defaultGitHistoryRovingCommit(current:string|undefined, explicitTarget:string|undefined, hashes:readonly string[]) {
 return hashes.includes(current??'')?current:explicitTarget?undefined:hashes[0];
}
