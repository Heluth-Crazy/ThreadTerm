/** Normalized screenshot geometry; persisted marks contain theme token names, never CSS or HTML. */
export type MarkupTool = 'rectangle'|'arrow'|'pen'|'text';
export type MarkupColor = '--primary'|'--danger'|'--text';
export type MarkupPoint = {x:number;y:number};
export type MarkupMark = {tool:MarkupTool;color:MarkupColor;points:MarkupPoint[];text?:string};
export const MARKUP_COLORS:readonly MarkupColor[]=['--primary','--danger','--text'];
export const MAX_MARKUP_MARKS=100, MAX_MARKUP_POINTS=1000;
export function markupPoint(x:number,y:number,width:number,height:number):MarkupPoint {
 if(![x,y,width,height].every(Number.isFinite)||width<=0||height<=0)throw new Error('Invalid markup geometry.');
 return {x:Math.max(0,Math.min(1,x/width)),y:Math.max(0,Math.min(1,y/height))};
}
export function markupRect(a:MarkupPoint,b:MarkupPoint) {return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
export function markupArrow(a:MarkupPoint,b:MarkupPoint,width:number,height:number):MarkupPoint[] {
 const angle=Math.atan2((b.y-a.y)*height,(b.x-a.x)*width),length=Math.min(14,Math.hypot((b.x-a.x)*width,(b.y-a.y)*height)/3);
 return [-.55,.55].map(offset=>({x:b.x-Math.cos(angle+offset)*length/width,y:b.y-Math.sin(angle+offset)*length/height}));
}
export function serializeMarkup(marks:readonly MarkupMark[]):string {return JSON.stringify(parseMarkup(JSON.stringify(marks)));}
export function parseMarkup(value:string):MarkupMark[] {
 if(value.length>3*1024*1024)throw new Error('Too much screenshot markup.');
 const marks:unknown=JSON.parse(value);
 if(!Array.isArray(marks)||marks.length>MAX_MARKUP_MARKS)throw new Error('Too much screenshot markup.');
 return marks.map(mark=>{
  if(!mark||typeof mark!=='object'||!['rectangle','arrow','pen','text'].includes(mark.tool)||!MARKUP_COLORS.includes(mark.color)||!Array.isArray(mark.points)||mark.points.length<1||mark.points.length>MAX_MARKUP_POINTS)throw new Error('Invalid screenshot markup.');
  if(mark.tool!=='pen'&&mark.points.length!==(mark.tool==='text'?1:2))throw new Error('Invalid screenshot markup.');
  const points=mark.points.map((point:MarkupPoint)=>{if(!point||![point.x,point.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new Error('Invalid markup point.');return {x:point.x,y:point.y};});
  if(mark.tool==='text'&&(typeof mark.text!=='string'||!mark.text.trim()||mark.text.length>120))throw new Error('Enter a label of at most 120 characters.');
  return {tool:mark.tool,color:mark.color,points,...(mark.tool==='text'?{text:mark.text}: {})};
 });
}
