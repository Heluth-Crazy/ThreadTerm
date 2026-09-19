export type DiffChange={fromA:number;toA:number;fromB:number;toB:number};
export type RevertSpec={from:number;to:number;insert:string};
/** Maps one exact diff change, avoiding line-number offsets after earlier hunks. */
export function revertChangeAt(changes:readonly DiffChange[],fromA:number,fromB:number,head:number,a:string,b:string):RevertSpec|undefined{
 const change=changes.find(value=>{const start=fromB+value.fromB,end=fromB+value.toB;return start<=head&&head<=end;});if(!change)return;
 const aFrom=fromA+change.fromA,aTo=fromA+change.toA,bFrom=fromB+change.fromB,bTo=fromB+change.toB;
 return {from:bFrom,to:bTo,insert:a.slice(aFrom,aTo)};
}
export function revertChunk(fromA:number,toA:number,fromB:number,toB:number,a:string,b:string):RevertSpec{
 let insert=a.slice(fromA,Math.max(fromA,toA-1));
 if(fromA!==toA&&toB<=b.length)insert+=(a.includes('\r\n')?'\r\n':'\n');
 return {from:fromB,to:Math.min(b.length,toB),insert};
}

export function revertLineChanges(changes:readonly DiffChange[],fromA:number,fromB:number,lineFrom:number,lineTo:number,a:string):RevertSpec[]{return changes.filter(value=>{const start=fromB+value.fromB,end=fromB+value.toB;return start<=lineTo&&end>=lineFrom;}).map(value=>({from:fromB+value.fromB,to:fromB+value.toB,insert:a.slice(fromA+value.fromA,fromA+value.toA)}));}
