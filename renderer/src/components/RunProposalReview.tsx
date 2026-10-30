import { proposalDiff, proposalFieldLabel, proposalReviewFields, type ProposalReview } from '../runProposals';

/** A complete, escaped review shared by the pending row and the human's accept editor. */
export function RunProposalReview({proposal,zh}:{proposal:ProposalReview;zh:boolean}) {
 const diff=proposalDiff(proposal);
 return <section className="wb-proposal-review" data-testid="proposal-review" aria-label={zh?'执行配置审阅':'Execution review'}>
  {proposalReviewFields(proposal).map((item,index)=><div className="wb-proposal-field" data-testid="proposal-field" data-field={item.field} key={`${item.field}:${index}`}><strong>{proposalFieldLabel(item.field,zh)}</strong><pre>{item.field==='Working directory'&&!proposal.cwd?(zh?'（工作树根目录）':'(worktree root)'):zh&&item.field==='Type'&&['task','service'].includes(proposal.kind)?(proposal.kind==='task'?'任务':'服务'):item.text}</pre></div>)}
  {proposal.target&&<section className="wb-proposal-diff" aria-label={zh?'与当前命令的差异':'Changes from current command'}>
   <strong>{zh?'与当前命令的差异':'Changes from current command'}</strong>
   {diff.map((field,index)=><section className="wb-proposal-field" data-testid="proposal-diff-field" data-change={field.change} key={`${field.field}:${index}`}><strong>{proposalFieldLabel(field.field,zh)}</strong>{field.command?<pre aria-label={zh?'命令差异':'Command diff'}>{field.command.map((line,lineIndex)=><span key={lineIndex} className={`is-${line.kind}`}>{line.kind==='added'?'+ ':line.kind==='removed'?'- ':'  '}{line.text}</span>)}</pre>:<><del>{field.before}</del><ins>{field.after}</ins></>}</section>)}
   {!diff.length&&<p className="note">{zh?'与当前命令相比已无差异。':'No changes remain against the current command.'}</p>}
  </section>}
 </section>;
}
