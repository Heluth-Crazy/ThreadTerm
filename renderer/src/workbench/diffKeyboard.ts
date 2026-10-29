export type DiffFileDirection = 'previous'|'next';

export function diffFileKey(direction:DiffFileDirection, platform=navigator.platform) {
 const arrow=direction==='next'?'ArrowRight':'ArrowLeft', mac=/Mac/i.test(platform);
 return {key:arrow,altKey:true,ctrlKey:mac,aria:mac?`Control+Alt+${arrow}`:`Alt+${arrow}`,label:mac?`Ctrl+Alt+${arrow.replace('Arrow','')}`:`Alt+${arrow.replace('Arrow','')}`};
}

export function isDiffFileKey(event:Pick<KeyboardEvent,'key'|'altKey'|'ctrlKey'|'metaKey'|'shiftKey'>, direction:DiffFileDirection, platform=navigator.platform) {
 const shortcut=diffFileKey(direction,platform);
 return event.key===shortcut.key&&event.altKey&&event.ctrlKey===shortcut.ctrlKey&&!event.metaKey&&!event.shiftKey;
}
