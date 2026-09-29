/**
 * Lane layout for the commit graph. Input is a page (or several concatenated pages) of `git.log` in
 * date order, where no parent appears before all of its children. Each row gets its node column and
 * the edges crossing it: `top` edges run from the row's top edge to the node's centre line, `bottom`
 * edges from the centre line to the row's bottom edge. Lanes never move sideways once assigned, so a
 * straight edge (from === to) is a pass-through and a colour follows a line of first parents.
 */
export type GraphEdge = { half:'top'|'bottom'; from:number; to:number; color:number };
export type GraphRow = { node:number; color:number; edges:GraphEdge[]; width:number };

type Lane = { hash:string; color:number } | null;

export function commitGraph(commits:readonly {hash:string;parents:readonly string[]}[]):{rows:GraphRow[];width:number} {
 let lanes:Lane[] = [];
 let nextColor = 0, width = 1;
 const rows = commits.map(commit => {
  let node = lanes.findIndex(lane => lane?.hash === commit.hash);
  const head = node < 0;
  if(head) {
   // A branch tip nothing below has pointed at yet: take the first free column.
   node = lanes.indexOf(null);
   if(node < 0) { node = lanes.length; lanes.push(null); }
   lanes[node] = {hash:commit.hash, color:nextColor++};
  }
  const color = lanes[node]!.color;
  const edges:GraphEdge[] = [];
  lanes.forEach((lane, index) => {
   if(!lane || (head && index === node)) return;
   // Every lane waiting for this commit converges into its node; the others pass straight through.
   edges.push({half:'top', from:index, to:lane.hash === commit.hash ? node : index, color:lane.color});
  });
  lanes = lanes.map((lane, index) => lane && lane.hash === commit.hash && index !== node ? null : lane);
  const continuing = lanes.map((lane, index) => index !== node && lane !== null);
  const [first, ...merged] = commit.parents;
  // The first parent always continues in this column, even if another lane already waits for it: both
  // lanes converge into the lowest column on the parent's row, so a main line keeps its column.
  if(first === undefined) lanes[node] = null;
  else { lanes[node] = {hash:first, color}; edges.push({half:'bottom', from:node, to:node, color}); }
  for(const parent of merged) {
   let target = lanes.findIndex(lane => lane?.hash === parent);
   if(target < 0) {
    // A merged branch opens a new lane, preferably to the right of the merge commit.
    target = lanes.findIndex((lane, index) => lane === null && index > node);
    if(target < 0) { target = lanes.length; lanes.push(null); }
    lanes[target] = {hash:parent, color:nextColor++};
   }
   edges.push({half:'bottom', from:node, to:target, color:lanes[target]!.color});
  }
  continuing.forEach((alive, index) => { if(alive && lanes[index]) edges.push({half:'bottom', from:index, to:index, color:lanes[index]!.color}); });
  while(lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  const rowWidth = Math.max(node + 1, ...edges.map(edge => Math.max(edge.from, edge.to) + 1));
  width = Math.max(width, rowWidth);
  return {node, color, edges, width:rowWidth};
 });
 return {rows, width};
}

/**
 * Badge text and kind for a `%D` decoration (`HEAD -> main`, `origin/main`, `tag: v1`). Local names may
 * contain slashes too (`qa/feature`), so remote branches come from `git.branches`, not from the name.
 */
export function refBadge(ref:string, remoteBranches:ReadonlySet<string>):{label:string;kind:'head'|'tag'|'remote'|'branch'} {
 if(ref.startsWith('HEAD -> ')) return {label:ref.slice(8), kind:'head'};
 if(ref === 'HEAD') return {label:'HEAD', kind:'head'};
 if(ref.startsWith('tag: ')) return {label:ref.slice(5), kind:'tag'};
 if(remoteBranches.has(ref) || ref.endsWith('/HEAD')) return {label:ref, kind:'remote'};
 return {label:ref, kind:'branch'};
}
