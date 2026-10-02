/** Quick-open matching: ordered subsequence with bonuses for contiguous runs,
 * word/segment starts and matches inside the file name. Pure and allocation-light
 * so it can score ~20k paths per keystroke. */
export type FuzzyMatch = { path:string; score:number; positions:number[] };

const boundary = (previous:string) => previous === '/' || previous === '\\' || previous === '_' || previous === '-' || previous === '.' || previous === ' ';

export function fuzzyScore(path:string, query:string):FuzzyMatch|undefined {
 const needle = query.replace(/\s+/g, '').toLowerCase();
 if(!needle) return {path, score:0, positions:[]};
 const hay = path.toLowerCase();
 const nameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
 // Prefer matching entirely inside the file name when possible.
 const attempt = (from:number) => {
  const positions:number[] = [];
  let cursor = from;
  for(const char of needle) {
   const found = hay.indexOf(char, cursor);
   if(found < 0) return undefined;
   positions.push(found);
   cursor = found + 1;
  }
  return positions;
 };
 const positions = attempt(nameStart) ?? attempt(0);
 if(!positions) return undefined;
 let score = 0;
 for(let index = 0; index < positions.length; index++) {
  const at = positions[index];
  score += 1;
  if(index > 0 && positions[index - 1] === at - 1) score += 5;
  if(at === 0 || boundary(path[at - 1])) score += 4;
  if(at >= nameStart) score += 2;
  if(path[at] !== hay[at] && path[at] === query.replace(/\s+/g, '')[index]) score += 1;
 }
 if(hay.slice(nameStart).startsWith(needle)) score += 10;
 if(hay.slice(nameStart) === needle || hay.slice(nameStart).split('.')[0] === needle) score += 15;
 // Shorter paths win ties; deep vendored copies sink.
 score -= path.length * 0.02 + (path.split('/').length - 1) * 0.3;
 return {path, score, positions};
}

export function fuzzyFilter(paths:readonly string[], query:string, limit = 60):FuzzyMatch[] {
 const matches:FuzzyMatch[] = [];
 for(const path of paths) {
  const match = fuzzyScore(path, query);
  if(match) matches.push(match);
 }
 matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
 return matches.slice(0, limit);
}

/** `src/app.ts:12` or `src/app.ts:12:4` → path plus 1-based position. */
export function splitQuickOpenQuery(query:string):{query:string;line?:number;column?:number} {
 const match = /^(.*?):(\d+)(?::(\d+))?\s*$/.exec(query.trim());
 if(!match || !match[1]) return {query:query.trim()};
 return {query:match[1], line:Number(match[2]) || undefined, column:match[3] ? Number(match[3]) || undefined : undefined};
}
