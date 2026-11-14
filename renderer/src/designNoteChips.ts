export type DesignNoteChip = { pin: string; target: string; words: string; shotId?: string };

/** Parses only ThreadTerm's plain page-note formatter; arbitrary page text never becomes HTML. */
export function designNoteChips(text: string): DesignNoteChip[] {
  const divider = text.search(/(?:^|\n)(?:Page comments \/|页面评论 \/)/);
  if (divider < 0) return [];
  const targets = new Map<string, string>();
  const shots = new Map<string,string>(); let currentPin:string|undefined;
  for(const line of text.slice(0,divider).split(/\r?\n/)) {
    const target=line.match(/^- \[(P\d+)\] ([^\n(]+?)(?: \([^\n]*\))?$/); if(target){currentPin=target[1];targets.set(target[1]!,target[2]!.trim());}
    const shot=line.match(/\[shot:([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\]/i); if(currentPin&&shot)shots.set(currentPin,shot[1]!);
  }
  const chips: DesignNoteChip[] = [];
  for (const match of text.slice(divider).matchAll(/^- \[(P\d+)\] ([^\n]+)/gm)) {
    const target = targets.get(match[1]!); if (!target) continue;
    chips.push({pin:match[1]!,target,words:match[2]!.trim().split(/\s+/).slice(0,8).join(' '),...(shots.get(match[1]!)?{shotId:shots.get(match[1]!)}:{})});
  }
  return chips;
}
