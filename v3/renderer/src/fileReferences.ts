import type { FileReference as ProtocolFileReference } from '@threadterm/protocol';

/** A display-only candidate. Resolution and containment remain runtime-owned. */
export type FileReference = ProtocolFileReference;
export type ExtractedFileReference = FileReference & { start:number; end:number };

const MAX_CANDIDATE_LENGTH=16*1024;
const MAX_TEXT_LENGTH=1_000_000;
const MAX_POSITION=1_000_000;
const MAX_REFERENCES=256;
const FILE_EXTENSION=/\.(?:[a-z0-9]{1,16}|dockerfile)(?:$|:)/i;
const BARE_NAMED_FILE=/^(?:dockerfile|makefile|readme(?:\.[a-z0-9]{1,16})?)$/i;
const NAMED_FILE_PATH=/(?:^|[\\/])(?:dockerfile|makefile|readme(?:\.[a-z0-9]{1,16})?)$/i;
const TRAILING=/[),.;!?'”」、】【]+$/u;

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
  const match=/#L(\d+)(?:C(\d+))?$/i.exec(value);
  if(!match)return {path:value};
  const line=Number(match[1]);
  const column=match[2]===undefined?undefined:Number(match[2]);
  if(!Number.isSafeInteger(line)||line<1||line>MAX_POSITION||(column!==undefined&&(!Number.isSafeInteger(column)||column<1||column>MAX_POSITION)))return;
  return {path:value.slice(0,match.index),line,...(column===undefined?{}:{column})};
}

function splitLocation(value:string):FileReference|undefined {
  const match=/^(.*?)(?::(\d+))(?::(\d+))?$/.exec(value);
  const path=match?.[1]||value;
  const line=match?Number(match[2]):undefined;
  const column=match?.[3]===undefined?undefined:Number(match[3]);
  if((line!==undefined&&(!Number.isSafeInteger(line)||line<1||line>MAX_POSITION))||(column!==undefined&&(!Number.isSafeInteger(column)||column<1||column>MAX_POSITION)))return;
  return {path,...(line===undefined?{}:{line}),...(column===undefined?{}:{column})};
}

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
  const absolute=/^(?:[a-z]:\\|[a-z]:\/(?!\/)|\\\\(?:\?\\)?[^\\/]+[\\/]|\/)/i.test(path);
  const relative=/^(?:\.\.?[\\/]|[^\\/]+[\\/])/.test(path);
  const bare=FILE_EXTENSION.test(path)||BARE_NAMED_FILE.test(path);
  if(!absolute&&!relative&&!bare)return;
  if(!absolute&&!FILE_EXTENSION.test(path)&&!NAMED_FILE_PATH.test(path))return;
  return reference;
}

/** Decodes one browser/Markdown URL-encoding layer before applying local-path rules. */
export function parseMarkdownFileReference(href:string):FileReference|undefined {
  const decoded=decodedMarkdownHref(href);if(decoded===undefined)return;
  return parseFileReference(decoded);
}

/** Extracts prose, quoted/code, Markdown-target and local-file-URI candidates with JS offsets. */
export function extractFileReferences(text:string):ExtractedFileReference[] {
  if(text.length>MAX_TEXT_LENGTH)return [];
  const found:ExtractedFileReference[]=[]; const seen=new Set<string>();
  const whitespace=(value:string)=>/\s/u.test(value);
  const tokenEnd=(from:number)=>{let end=from;while(end<text.length&&!whitespace(text[end]))end++;return end;};
  const emit=(raw:string,offset:number)=>{
    if(raw.length>MAX_CANDIDATE_LENGTH||/[a-z][a-z0-9+.-]*:[^\s]*$/i.test(text.slice(Math.max(0,offset-256),offset)))return;
    const reference=parseFileReference(raw); if(!reference)return;
    const key=`${offset}:${raw.length}`; if(seen.has(key))return; seen.add(key);
    found.push({...reference,start:offset,end:offset+raw.length});
  };
  // Scan each non-whitespace token once. The former global regex could retry
  // a growing slash-only token at every slash; this keeps long non-path input
  // linear while retaining quoted and Markdown targets that may contain spaces.
  for(let index=0;index<text.length&&found.length<MAX_REFERENCES;){
    if(whitespace(text[index])){index++;continue;}
    const end=tokenEnd(index);
    if(text[index]==='['){
      let marker=index+1;while(marker<end&&!(text[marker]===']'&&text[marker+1]==='('))marker++;
      if(marker<end){
        let close=marker+2;const limit=Math.min(text.length,marker+2+MAX_CANDIDATE_LENGTH);
        while(close<limit&&text[close]!==')'&&text[close]!=='\n'&&text[close]!=='\r')close++;
        if(close<limit&&text[close]===')'){
          const raw=text.slice(marker+2,close);const target=/^\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))/.exec(raw);
          const selected=target?.[1]??target?.[2]??target?.[3];
          if(selected){const quote=target?.[1]!==undefined||target?.[2]!==undefined;emit(selected,marker+2+raw.indexOf(selected)+(quote?0:0));}
          index=close+1;continue;
        }
      }
    }
    const quote=text[index];
    if(quote==='"'||quote==="'"||quote==='`'){
      let close=index+1;const limit=Math.min(text.length,index+1+MAX_CANDIDATE_LENGTH);
      while(close<limit&&text[close]!==quote&&text[close]!=='\n'&&text[close]!=='\r')close++;
      if(close<limit&&text[close]===quote){emit(text.slice(index+1,close),index+1);index=close+1;continue;}
      index=end;continue;
    }
    if(end-index<=MAX_CANDIDATE_LENGTH){
      let start=index;while(start<end&&'([{<'.includes(text[start]))start++;
      emit(text.slice(start,end),start);
    }
    index=end;
  }
  return found;
}
