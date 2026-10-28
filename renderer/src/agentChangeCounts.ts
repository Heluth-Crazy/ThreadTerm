import type { ReviewFile } from '@threadterm/protocol';

export type ReviewFileLineCounts = { binary:true } | { binary:false; added:number; removed:number };

export function reviewFileLineCounts(file:Pick<ReviewFile, 'added'|'removed'|'binary'>):ReviewFileLineCounts {
 return file.binary ? {binary:true} : {binary:false, added:file.added ?? 0, removed:file.removed ?? 0};
}

export function reviewChangeTotals(files:readonly Pick<ReviewFile, 'added'|'removed'|'binary'>[]):{added:number;removed:number} {
 return files.reduce<{added:number;removed:number}>((totals, file) => {
  const counts=reviewFileLineCounts(file);
  return counts.binary ? totals : {added:totals.added+counts.added, removed:totals.removed+counts.removed};
 }, {added:0,removed:0});
}

export function reviewChangeSummary(files:readonly Pick<ReviewFile, 'added'|'removed'|'binary'>[], zh:boolean) {
 const totals=reviewChangeTotals(files);
 return `${zh ? `${files.length} 个文件` : `${files.length} ${files.length === 1 ? 'file' : 'files'}`} · +${totals.added} −${totals.removed}`;
}
