export type ConflictBlock = {
 from:number;
 to:number;
 startLine:number;
 endLine:number;
 ours:string;
 base?:string;
 theirs:string;
};

export type ConflictChoice = 'current'|'incoming'|'current-first'|'incoming-first';

type Line = { from:number; to:number; text:string; fullTo:number };

const startMarker = /^<{7}(?: .*)?$/;
const baseMarker = /^\|{7}(?: .*)?$/;
const separatorMarker = /^={7}$/;
const endMarker = /^>{7}(?: .*)?$/;
const markerLike = /^(?:<{7,}|\|{7,}|={7,}|>{7,}).*$/;

function lines(text:string):Line[] {
 const result:Line[] = [];
 for(let from=0;from<text.length;) {
  const newline = text.indexOf('\n', from);
  const fullTo = newline < 0 ? text.length : newline + 1;
  const to = newline < 0 ? fullTo : newline > from && text[newline - 1] === '\r' ? newline - 1 : newline;
  result.push({ from, to, text:text.slice(from, to), fullTo });
  from = fullTo;
 }
 return result;
}

function skipMalformedRegion(source:Line[], start:number):number {
 let depth = 1;
 for(let index=start + 1;index<source.length;index++) {
  const line = source[index]!;
  if(startMarker.test(line.text)) depth++;
  else if(endMarker.test(line.text) && --depth === 0) return index + 1;
 }
 return source.length;
}

/** Parses complete Git conflict regions without interpreting marker-like file content. */
export function conflictBlocks(text:string):{blocks:ConflictBlock[];unparseable:boolean} {
 const source = lines(text);
 const blocks:ConflictBlock[] = [];
 let unparseable = false;
 for(let index=0;index<source.length;) {
  const start = source[index]!;
  if(!startMarker.test(start.text)) {
   if(markerLike.test(start.text)) unparseable = true;
   index++;
   continue;
  }
  const startLine = index + 1;
  const oursFrom = start.fullTo;
  let boundary = ++index;
  while(boundary < source.length && !markerLike.test(source[boundary]!.text)) boundary++;
  const first = source[boundary];
  if(!first || !(baseMarker.test(first.text) || separatorMarker.test(first.text))) {
   unparseable = true;
   index = skipMalformedRegion(source, index - 1);
   continue;
  }
  const ours = text.slice(oursFrom, first.from);
  let base:string|undefined;
  let separator:Line;
  if(baseMarker.test(first.text)) {
   const baseFrom = first.fullTo;
   boundary++;
   while(boundary < source.length && !markerLike.test(source[boundary]!.text)) boundary++;
   separator = source[boundary]!;
   if(!separator || !separatorMarker.test(separator.text)) {
    unparseable = true;
    index = skipMalformedRegion(source, index - 1);
    continue;
   }
   base = text.slice(baseFrom, separator.from);
  } else {
   separator = first;
  }
  const theirsFrom = separator.fullTo;
  boundary++;
  while(boundary < source.length && !markerLike.test(source[boundary]!.text)) boundary++;
  const end = source[boundary];
  if(!end || !endMarker.test(end.text)) {
   unparseable = true;
   index = skipMalformedRegion(source, index - 1);
   continue;
  }
  blocks.push({
   from:start.from,
   to:end.fullTo,
   startLine,
   endLine:boundary + 1,
   ours,
   ...(base === undefined ? {} : {base}),
   theirs:text.slice(theirsFrom, end.from),
  });
  index = boundary + 1;
 }
 return { blocks, unparseable };
}

export function conflictReplacement(block:ConflictBlock, choice:ConflictChoice):string {
 switch(choice) {
  case 'current': return block.ours;
  case 'incoming': return block.theirs;
  case 'current-first': return block.ours + block.theirs;
  case 'incoming-first': return block.theirs + block.ours;
 }
}
