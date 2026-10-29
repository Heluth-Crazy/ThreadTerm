export type GitWorkbenchAction = 'commit'|'pull'|'push'|'fetch'|'switch-branch'|'stash';
export type GitWorkbenchCommand = {view:'scm';key:string;action:GitWorkbenchAction;scopeKey?:string};
