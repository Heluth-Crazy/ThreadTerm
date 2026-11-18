export type GitWorkbenchAction = 'commit'|'pull'|'push'|'fetch'|'switch-branch'|'stash';
/** `scopeMode` opens the view in a Source Control scope instead of running an action (R5). */
export type GitWorkbenchCommand = {view:'scm';key:string;action?:GitWorkbenchAction;scopeKey?:string;scopeMode?:'branch'};
