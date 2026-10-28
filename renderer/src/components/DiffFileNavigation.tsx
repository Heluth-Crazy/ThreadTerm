import { diffFilePosition } from '../diffFileNavigation';

export function DiffFileNavigation({paths,path,zh,disabled,onNavigate}:{paths:readonly string[];path:string;zh:boolean;disabled?:boolean;onNavigate?:(path:string)=>void}) {
 const {position,total,previous,next}=diffFilePosition(paths,path);
 return <span className="wb-hunk-nav" role="group" aria-label={zh?'文件导航':'File navigation'}>
  <button type="button" className="btn btn-sm" disabled={disabled||!onNavigate||!previous} onClick={()=>previous&&onNavigate?.(previous)}>{zh?'上一个文件':'Previous file'}</button>
  <span className="wb-hunk-count" aria-label={zh?'文件位置':'File position'}>{position} / {total}</span>
  <button type="button" className="btn btn-sm" disabled={disabled||!onNavigate||!next} onClick={()=>next&&onNavigate?.(next)}>{zh?'下一个文件':'Next file'}</button>
 </span>;
}
