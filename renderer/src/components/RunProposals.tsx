import type { RunProposal, Session } from '@threadterm/protocol';
import { AgentTag } from './RunRows';
import { visibleControlCharacters } from '../chatQuestion';
import { RunProposalReview } from './RunProposalReview';

export function RunProposals({proposals,sessions,zh,busy,onAccept,onReject,onOpenChat}:{proposals:readonly RunProposal[];sessions:readonly Session[];zh:boolean;busy:boolean;onAccept:(proposal:RunProposal)=>void;onReject:(proposal:RunProposal)=>void;onOpenChat:(id:string)=>void}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 if(!proposals.length)return null;
 return <section className="wb-run-section wb-run-proposals" data-testid="run-proposals" aria-label={copy('Proposals','建议')}>
  <header className="wb-run-section-head"><span className="wb-section-label">{copy('Proposals','建议')}</span><span className="wb-count">{proposals.length}</span></header>
  {proposals.map(proposal => { return <article className="wb-proposal-row" key={proposal.id} data-testid="run-proposal-row" data-proposal-id={proposal.id}>
   <div className="ql-command-head"><strong>{proposal.targetCommandId?copy(`Update ${visibleControlCharacters(proposal.name)}`,`更新 ${visibleControlCharacters(proposal.name)}`):visibleControlCharacters(proposal.name)}</strong><AgentTag startedBy={proposal.sessionId} sessions={sessions} zh={zh} onOpen={onOpenChat}/><span className="wb-agent-chat">{visibleControlCharacters(sessions.find(session=>session.id===proposal.sessionId)?.title??proposal.sessionId)}</span></div>
   <p className="wb-proposal-reason"><span>{copy('Reason: ','原因：')}</span>{visibleControlCharacters(proposal.reason)}</p>
   <RunProposalReview proposal={proposal} zh={zh}/>
   <div className="ql-actions"><button type="button" className="btn btn-sm" data-testid="run-proposal-accept" disabled={busy} onClick={()=>onAccept(proposal)}>{copy('Accept…','接受…')}</button><button type="button" className="btn btn-sm btn-ghost" data-testid="run-proposal-reject" disabled={busy} onClick={()=>onReject(proposal)}>{copy('Reject','拒绝')}</button><button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={()=>onOpenChat(proposal.sessionId)}>{copy('Open chat','打开聊天')}</button></div>
  </article>; })}
 </section>;
}
