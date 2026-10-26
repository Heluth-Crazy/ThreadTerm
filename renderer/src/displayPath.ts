/** Formats an absolute path for display without changing the stored value. */
export function displayPath(path:string):string {
 const lower=path.toLowerCase();
 const value=lower.startsWith('\\\\?\\unc\\')?'\\\\'+path.slice(8):lower.startsWith('\\\\?\\')?path.slice(4):lower.startsWith('//?/unc/')?'//'+path.slice(8):lower.startsWith('//?/')?path.slice(4):path;
 return /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value)?value.replace(/\//g,'\\'):value;
}
