import type { FileReference as ProtocolFileReference } from '@threadterm/protocol';

/** A display-only candidate. Resolution and containment remain runtime-owned. */
export type FileReference = ProtocolFileReference;
export type ExtractedFileReference = FileReference & { start:number; end:number };
/** One reading of a location. A speculative reading is only shown once the runtime finds the file. */
export type FileReferenceCandidate = ExtractedFileReference & { speculative?:true };

const MAX_CANDIDATE_LENGTH=16*1024;
const MAX_TEXT_LENGTH=1_000_000;
const MAX_POSITION=1_000_000;
const MAX_REFERENCES=256;
// An extension needs a letter, so `3.14` and `v1.2.3` stay numbers.
const FILE_EXTENSION=/\.(?=[a-z0-9]{1,16}(?:$|:))[a-z0-9]*[a-z]/i;
const BARE_NAMED_FILE=/^(?:dockerfile|makefile|readme(?:\.[a-z0-9]{1,16})?)$/i;
const NAMED_FILE_PATH=/(?:^|[\\/])(?:dockerfile|makefile|readme(?:\.[a-z0-9]{1,16})?)$/i;
const ABSOLUTE=/^(?:[a-z]:\\|[a-z]:\/(?!\/)|\\\\(?:\?\\)?[^\\/]+[\\/]|\/)/i;
// Closing punctuation, including the full-width marks of Chinese prose (。，：；！？）】》」』”’、).
const TRAILING=/[),.:;!?'"`\]}>”’」』）】》〉、。，：；！？]+$/u;
// Chinese prose puts no space between a path and the punctuation or words around it
// (`见src/a.ts。`), so full-width punctuation, box drawing and TUI bullets/prompts
// (│ ⎿ ⏺ • › ❯) end a token just like whitespace.
const BREAK_CLASS='\\s，。：；！？、（）【】《》〈〉「」『』“”‘’\\u2500-\\u257f\\u2022\\u203a\\u23bf\\u23fa\\u25b6\\u25cf\\u276f';
const BREAK=new RegExp(`[${BREAK_CLASS}]`,'u');
const URL_PREFIX=new RegExp(`[a-z][a-z0-9+.-]*:[^${BREAK_CLASS}]*$`,'iu');
const CJK=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LEADING='([{<@';
const OPENERS='([{<';
const CLOSERS=')]}>';
const TRAILING_MARKS=',.:;!?\'"`';
const LINE_IN_PARENS=/\((\d+)(?:,(\d+))?\)$/;

function localFileUri(value:string):string|undefined {
  if(!/^file:\/\//i.test(value)||/[?#%]/.test(value))return;
  const rest=value.slice(value.indexOf('//')+2);
  if(rest.startsWith('/')) {
    const path=rest.replace(/^\/+/, '');
    return /^[a-z]:[\\/]/i.test(path)?path:undefined;
  }
  const slash=rest.indexOf('/');
  if(slash<1)return;
  return `\\\\${rest.slice(0,slash)}\\${rest.slice(slash+1)}`;
}

function decodedMarkdownHref(value:string):string|undefined {
  if(!/%[0-9a-f]{2}/i.test(value))return value;
  try{return decodeURIComponent(value);}catch{return;}
}

function splitLineFragment(value:string):{path:string;line?:number;column?:number}|undefined {
  const match=/#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(value);
  if(!match)return {path:value};
  const line=Number(match[1]);
  const column=match[2]===undefined?undefined:Number(match[2]);
  if(!Number.isSafeInteger(line)||line<1||line>MAX_POSITION||(column!==undefined&&(!Number.isSafeInteger(column)||column<1||column>MAX_POSITION)))return;
  return {path:value.slice(0,match.index),line,...(column===undefined?{}:{column})};
}

function splitLocation(value:string):FileReference|undefined {
  const match=/^(.*?):(\d+)(?::(\d+)|-\d+)?$/.exec(value);
  const path=match?.[1]||value;
  const line=match?Number(match[2]):undefined;
  const column=match?.[3]===undefined?undefined:Number(match[3]);
  if((line!==undefined&&(!Number.isSafeInteger(line)||line<1||line>MAX_POSITION))||(column!==undefined&&(!Number.isSafeInteger(column)||column<1||column>MAX_POSITION)))return;
  return {path,...(line===undefined?{}:{line}),...(column===undefined?{}:{column})};
}

const looksLikeFile=(path:string)=>FILE_EXTENSION.test(path)||NAMED_FILE_PATH.test(path);

/** Parses a bounded, explicit local path; it never decodes or touches the filesystem. */
export function parseFileReference(text:string):FileReference|undefined {
  let value=text.trim();
  if(value.length<2||value.length>MAX_CANDIDATE_LENGTH)return;
  if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))||(value.startsWith('`')&&value.endsWith('`')))value=value.slice(1,-1);
  value=value.replace(TRAILING,'');
  const fragment=splitLineFragment(value);if(!fragment)return;
  value=fragment.path;
  const uri=localFileUri(value); if(uri)value=uri;
  const reference=fragment.line===undefined?splitLocation(value):{path:value,line:fragment.line,...(fragment.column===undefined?{}:{column:fragment.column})};
  if(!reference||!reference.path||/\p{Cc}/u.test(reference.path))return;
  const path=reference.path;
  if(/^[a-z]:\/\//i.test(path))return;
  if(/^[a-z][a-z0-9+.-]*:/i.test(path)&&!/^[a-z]:[\\/]/i.test(path))return;
  const absolute=ABSOLUTE.test(path);
  const relative=/^(?:\.\.?[\\/]|[^\\/]+[\\/])/.test(path);
  const bare=FILE_EXTENSION.test(path)||BARE_NAMED_FILE.test(path);
  if(!absolute&&!relative&&!bare)return;
  if(!absolute&&!looksLikeFile(path))return;
  return reference;
}

/** Decodes one browser/Markdown URL-encoding layer before applying local-path rules. */
export function parseMarkdownFileReference(href:string):FileReference|undefined {
  const decoded=decodedMarkdownHref(href);if(decoded===undefined)return;
  return parseFileReference(decoded);
}

const isBreak=(value:string)=>BREAK.test(value);
// A scheme-prefixed token (`https://host/?q=src/a.ts`) is a URL, never a local path.
const insideUrl=(text:string,offset:number)=>URL_PREFIX.test(text.slice(Math.max(0,offset-256),offset));

/** Reads `text[from, to)` as one location, trimming trailing punctuation and unmatched closers. */
function readSpan(text:string,from:number,to:number):FileReferenceCandidate|undefined {
  const open:number[]=[]; const stray=new Set<number>(); let firstStray=to;
  for(let index=from;index<to;index++){
    if(OPENERS.includes(text[index])){open.push(index);continue;}
    const closer=CLOSERS.indexOf(text[index]); if(closer<0)continue;
    if(open.length&&text[open[open.length-1]]===OPENERS[closer])open.pop();
    else {stray.add(index);firstStray=Math.min(firstStray,index);}
  }
  let end=to;
  while(end>from&&(TRAILING_MARKS.includes(text[end-1])||stray.has(end-1)))end--;
  // A bracket left unmatched inside means this start cut a name such as `report(1).pdf`.
  if(open.length||firstStray<end||end-from<2)return;
  const core=text.slice(from,end);
  const located=LINE_IN_PARENS.exec(core);
  if(!located||located.index===0){
    const reference=parseFileReference(core);
    return reference&&{...reference,start:from,end};
  }
  // Compiler form `src/a.ts(10,5)`, as printed by tsc and MSBuild.
  const base=parseFileReference(core.slice(0,located.index));
  const line=Number(located[1]); const column=located[2]===undefined?undefined:Number(located[2]);
  if(!base||base.line!==undefined||line<1||line>MAX_POSITION||(column!==undefined&&(column<1||column>MAX_POSITION)))return;
  return {path:base.path,line,...(column===undefined?{}:{column}),start:from,end};
}

/** Readings of one unquoted token: `Update(src/a.ts)`, `--out=./a.js`, `修改了src/a.ts文件`, `a.ts(3,1):`. */
function tokenCandidates(text:string,from:number,to:number):FileReferenceCandidate[] {
  while(from<to&&LEADING.includes(text[from]))from++;
  // Chinese prose also runs words into code: `修改了src/a.ts文件` ("changed the src/a.ts file").
  let lead=from; while(lead<to&&CJK.test(text[lead]))lead++;
  if(lead>from&&lead<to&&/[\w.~]/.test(text[lead]))from=lead;
  let tail=to; while(tail>from&&CJK.test(text[tail-1]))tail--;
  if(tail<to&&tail>from&&/[a-z0-9]/i.test(text[tail-1]))to=tail;
  // A wrapper or prefix (`Read(`, `--out=`, `链接:`) ends at an opener, `=` or `:`. A bracket
  // right after a separator is a directory name (`app/(auth)/`, `[id]/`), and a drive colon
  // or `:line` suffix belongs to the path.
  const starts:number[]=[];
  for(let index=to-1;index>from&&starts.length<3;index--){
    const value=text[index], before=text[index-1];
    const drive=value===':'&&/[a-z]/i.test(before)&&(index-1===from||!/[a-z0-9]/i.test(text[index-2]))&&/[\\/]/.test(text[index+1]??'');
    if(value==='='||(OPENERS.includes(value)&&before!=='/'&&before!=='\\')||(value===':'&&!drive&&!/\d/.test(text[index+1]??'')))starts.push(index+1);
  }
  starts.push(from);
  for(const start of starts){
    const found=readSpan(text,start,to);
    if(!found||insideUrl(text,found.start))continue;
    // `git diff` prints `a/src/x.ts` and `b/src/x.ts`; only the runtime knows which exists.
    const unprefixed=/^[ab][\\/]/.test(text.slice(found.start,found.start+2))?readSpan(text,found.start+2,found.end):undefined;
    return unprefixed?[found,{...unprefixed,speculative:true}]:[found];
  }
  return [];
}

// `C:\Program Files\x.exe` arrives as several tokens. An absolute, directory-like head may
// continue across single spaces; only the runtime can confirm such a reading.
function spacedReadings(text:string,head:FileReferenceCandidate):FileReferenceCandidate[] {
  if(!ABSOLUTE.test(head.path)||looksLikeFile(head.path))return [];
  let end=head.end;
  for(let joins=0;joins<3;joins++){
    if(text[end]!==' '||end+1>=text.length||isBreak(text[end+1])||text[end+1]==='-')return [];
    let next=end+1; while(next<text.length&&!isBreak(text[next]))next++;
    if(next-head.start>MAX_CANDIDATE_LENGTH)return [];
    const reading=readSpan(text,head.start,next);
    if(reading&&looksLikeFile(reading.path))return [{...reading,speculative:true}];
    end=next;
  }
  return [];
}

/**
 * Every location in `text`, each as its alternative readings, most likely first. Callers
 * that cannot ask the runtime use the first non-speculative reading of each group.
 */
export function fileReferenceCandidates(text:string):FileReferenceCandidate[][] {
  if(text.length>MAX_TEXT_LENGTH)return [];
  const groups:FileReferenceCandidate[][]=[];
  const tokenEnd=(from:number)=>{let end=from;while(end<text.length&&!isBreak(text[end]))end++;return end;};
  const emit=(raw:string,offset:number,line?:number)=>{
    if(raw.length>MAX_CANDIDATE_LENGTH||insideUrl(text,offset))return;
    const reference=parseFileReference(raw); if(!reference)return;
    groups.push([{...reference,...(line&&reference.line===undefined?{line}:{}),start:offset,end:offset+raw.length}]);
  };
  // Scan each token once. The former global regex could retry a growing slash-only token
  // at every slash; this keeps long non-path input linear while retaining quoted and
  // Markdown targets that may contain spaces.
  for(let index=0;index<text.length&&groups.length<MAX_REFERENCES;){
    if(isBreak(text[index])){index++;continue;}
    const end=tokenEnd(index);
    if(text[index]==='['){
      let marker=index+1;while(marker<end&&!(text[marker]===']'&&text[marker+1]==='('))marker++;
      if(marker<end){
        let close=marker+2;const limit=Math.min(text.length,marker+2+MAX_CANDIDATE_LENGTH);
        while(close<limit&&text[close]!==')'&&text[close]!=='\n'&&text[close]!=='\r')close++;
        if(close<limit&&text[close]===')'){
          const raw=text.slice(marker+2,close);const target=/^\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))/.exec(raw);
          const selected=target?.[1]??target?.[2]??target?.[3];
          if(selected)emit(selected,marker+2+raw.indexOf(selected));
          index=close+1;continue;
        }
      }
    }
    const quote=text[index];
    if(quote==='"'||quote==="'"||quote==='`'){
      let close=index+1;const limit=Math.min(text.length,index+1+MAX_CANDIDATE_LENGTH);
      while(close<limit&&text[close]!==quote&&text[close]!=='\n'&&text[close]!=='\r')close++;
      if(close<limit&&text[close]===quote){
        // Python tracebacks: `File "D:\repo\x.py", line 10, in <module>`.
        const pythonLine=/^, line (\d{1,7})\b/.exec(text.slice(close+1,close+17));
        const line=pythonLine?Number(pythonLine[1]):undefined;
        emit(text.slice(index+1,close),index+1,line&&line<=MAX_POSITION?line:undefined);
        index=close+1;continue;
      }
      index=end;continue;
    }
    if(end-index<=MAX_CANDIDATE_LENGTH){
      const found=tokenCandidates(text,index,end);
      if(found.length)groups.push([...spacedReadings(text,found[0]),...found]);
    }
    index=end;
  }
  return groups;
}

/** Extracts prose, quoted/code, Markdown-target and local-file-URI candidates with JS offsets. */
export function extractFileReferences(text:string):ExtractedFileReference[] {
  return fileReferenceCandidates(text).flatMap(group=>group.filter(candidate=>!candidate.speculative).slice(0,1));
}
