export function browserInnerRadius(style?:{borderBottomLeftRadius:string;borderBottomWidth:string}):number {
 if(!style)return 0;
 const radius=parseFloat(style.borderBottomLeftRadius),border=parseFloat(style.borderBottomWidth);
 return Number.isFinite(radius)&&Number.isFinite(border)?Math.max(0,radius-border):0;
}
