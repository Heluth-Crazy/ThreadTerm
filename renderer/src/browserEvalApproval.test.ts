import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash,webcrypto } from 'node:crypto';
import type { ChatItem,ChatPart } from '@threadterm/protocol';
import { BROWSER_ACTION_TOOLS,BROWSER_READ_TOOLS } from '@threadterm/protocol';
import { browserEvalReviewEnabled,browserEvalReviewKey,browserEvalSummary,createBrowserEvalDecision,createBrowserEvalReviewRequests,isBrowserEvalApproval,verifyBrowserEvalReview,type BrowserEvalContext,type BrowserEvalSummary } from './browserEvalApproval';
import { browserToolActivityFromPart,browserToolIdentity,hasRedactedBrowserResult } from './browserToolActivity';
import { partBody,partLabel } from './chatPresentation';
import { chatMarkdownExportBundle } from './chatMarkdownExport';
import { feedbackNotesFromPart,isFeedbackCheck } from './feedbackNotes';
import { toolView } from './toolView';
import { describeTool,toolOutputPreview } from './toolActivity';

const code='  const label = "界😀<script>PRIVATE</script>";\r\n\tlabel;  ';
const summary:BrowserEvalSummary={approvalId:'approval-a',operationId:'browser-operation',callerSessionId:'chat-a',tabId:'tab-a',origin:'https://source.test',
 codeHash:createHash('sha256').update(code,'utf8').digest('hex'),codeByteLength:Buffer.byteLength(code),expiresAtUnixMs:Date.now()+60_000,settingsGeneration:'runtime:7'};
const context:BrowserEvalContext={sessionId:'chat-a',turnId:'turn-a',leaseEpoch:4,generation:'runtime:connection',writable:true,live:true};
const part:ChatPart={type:'approval',approvalId:summary.approvalId,status:'pending',data:{...summary,runtimeOwned:true,requestType:'threadterm.browser_eval',code:'PRIVATE DURABLE',details:{code:'PRIVATE DETAILS'},choices:[{id:'approve_once',label:'Approve once'},{id:'deny',label:'Deny'}]}};
const response=()=>{const {callerSessionId,...view}=summary;return {...view,code,status:'pending' as const};};
const digest=(bytes:Uint8Array)=>webcrypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);

test('eval approval marker and summary are exact and ignore every raw durable sibling',()=>{
 assert.equal(isBrowserEvalApproval(part),true);assert.deepEqual(browserEvalSummary(part),summary);
 for(const changed of [{runtimeOwned:false},{requestType:'threadterm.browser_eval_extra'},{requestType:'browser_eval'}])assert.equal(isBrowserEvalApproval({...part,data:{...part.data as object,...changed}}),false);
 for(const changed of [{approvalId:'other'},{codeHash:'A'.repeat(64)},{codeByteLength:16*1024+1},{expiresAtUnixMs:Infinity},{callerSessionId:'bad\ncaller'},{origin:'PRIVATE CODE'},{origin:'https://source.test/PRIVATE'},{origin:'https://user:secret@source.test'}])assert.equal(browserEvalSummary({...part,data:{...part.data as object,...changed}}),undefined);
 assert.equal(JSON.stringify(browserEvalSummary(part)).includes('PRIVATE'),false);
});

test('only a current writable pending live-turn lease may load code; every identity changes the review key',()=>{
 assert.equal(browserEvalReviewEnabled(summary,context,'pending'),true);
 for(const changed of [{sessionId:'other'},{turnId:''},{leaseEpoch:0},{live:false},{writable:false}])assert.equal(browserEvalReviewEnabled(summary,{...context,...changed},'pending'),false);
 for(const status of ['resolved','expired','failed','outcomeUnknown','answered'])assert.equal(browserEvalReviewEnabled(summary,context,status),false);
 assert.equal(browserEvalReviewEnabled(summary,undefined,'pending'),false);assert.equal(browserEvalReviewEnabled({...summary,expiresAtUnixMs:1},context,'pending'),false);
 const key=browserEvalReviewKey(summary,context,'pending');
 for(const changed of [{sessionId:'other'},{turnId:'turn-b'},{leaseEpoch:5},{generation:'new-runtime'},{live:false},{writable:false}])assert.notEqual(browserEvalReviewKey(summary,{...context,...changed},'pending'),key);
 for(const changed of [{operationId:'other'},{codeHash:'0'.repeat(64)},{settingsGeneration:'runtime:8'},{expiresAtUnixMs:1}])assert.notEqual(browserEvalReviewKey({...summary,...changed},context,'pending'),key);
 assert.notEqual(browserEvalReviewKey(summary,context,'resolved'),key);
});

test('exact UTF8 bytes, whitespace, CRLF and Unicode are hashed without normalization',async()=>{
 const bytes:Uint8Array[]=[];
 const review=await verifyBrowserEvalReview(response(),summary,async value=>{bytes.push(value);return digest(value);});
 assert.equal(review.code,code);assert.deepEqual(Array.from(bytes[0]),Array.from(Buffer.from(code,'utf8')));
 assert.equal(review.codeHash,summary.codeHash);assert.equal(review.codeByteLength,Buffer.byteLength(code));
 for(const changed of [{code:code.trim()},{code:code.replace(/\r\n/g,'\n')},{code:'\u0000'},{code:'\ud800'},{code:'x'.repeat(16*1024+1)},
  {codeHash:'0'.repeat(64)},{codeByteLength:summary.codeByteLength-1},{operationId:'other'},{origin:'https://other.test'},{tabId:'other'},{settingsGeneration:'runtime:8'},{status:'expired'}])await assert.rejects(verifyBrowserEvalReview({...response(),...changed},summary,digest));
 const wrong={...summary,codeHash:'0'.repeat(64)};await assert.rejects(verifyBrowserEvalReview({...response(),codeHash:wrong.codeHash},wrong,digest),/changed/);
});

test('cancelled reads and replaced live identities discard both late payloads and late hash completion',async()=>{
 let read=false;await createBrowserEvalReviewRequests().read(async()=>{read=true;return response();},summary,()=>false,()=>assert.fail('inactive read accepted'));assert.equal(read,false);
 for(const stage of ['read','hash'] as const){
  const requests=createBrowserEvalReviewRequests();let finish!:(value:unknown)=>void,accepted=false,hashed=false;
  const deferred=new Promise<unknown>(resolve=>{finish=resolve;});
  const pending=requests.read(()=>stage==='read'?deferred:Promise.resolve(response()),summary,()=>true,()=>{accepted=true;},async value=>{
   hashed=true;if(stage==='hash')await deferred;return verifyBrowserEvalReview(value,summary,digest);
  });
  if(stage==='hash')await Promise.resolve();requests.cancel();finish(response());await pending;
  assert.equal(accepted,false);if(stage==='read')assert.equal(hashed,false);
 }
 for(const changed of [{leaseEpoch:5},{sessionId:'other'},{turnId:'turn-b'},{writable:false},{live:false},{generation:'reconnected'}]){
  const requests=createBrowserEvalReviewRequests(),original=browserEvalReviewKey(summary,context,'pending');let latest=context,finish!:(value:unknown)=>void,accepted=false;
  const pending=requests.read(()=>new Promise(resolve=>{finish=resolve;}),summary,()=>browserEvalReviewKey(summary,latest,'pending')===original&&browserEvalReviewEnabled(summary,latest,'pending'),()=>{accepted=true;},value=>verifyBrowserEvalReview(value,summary,digest));
  latest={...context,...changed};finish(response());await pending;assert.equal(accepted,false);
 }
});

test('decision retries retain exact operation identity and choice without duplicate or cross-card settlement',()=>{
 let generated=0;const decisions=createBrowserEvalDecision(()=>`decision-${++generated}`),key=browserEvalReviewKey(summary,context,'pending');
 const first=decisions.begin(key,'approve_once')!;assert.equal(first.operationId,'decision-1');
 assert.equal(decisions.begin(key,'approve_once'),undefined);assert.equal(decisions.begin(key,'deny'),undefined);
 decisions.settle(first.operationId,false);const retry=decisions.begin(key,'approve_once')!;assert.equal(retry.operationId,first.operationId);
 decisions.settle(retry.operationId,true);assert.equal(decisions.begin(key,'approve_once'),undefined);
 const next=decisions.begin('new-card','deny')!;assert.equal(next.operationId,'decision-2');decisions.settle(first.operationId,false);
 assert.equal(decisions.begin('new-card','deny'),undefined,'old completion cannot unlock the newer in-flight decision');
 decisions.clear();assert.equal(decisions.begin(key,'deny')?.operationId,'decision-3');
});

test('separate eval privacy identity protects tool and approval history, export, feedback and raw fallback sinks',()=>{
 const raw={text:'PRIVATE',code:'PRIVATE',result:'PRIVATE',error:'PRIVATE',rawOutput:'PRIVATE',images:['data:image/png;base64,UFJJVkFURQ=='],localizedText:{en:'PRIVATE'},input:{code:'PRIVATE'},fileReferences:[{path:'D:/PRIVATE'}]};
 const cases:ChatPart[]=[{...part,text:'PRIVATE',data:{...part.data as object,...raw},fileReferences:[{path:'D:/PRIVATE'}]},
  ...[false,true].map(inverse=>({type:'tool' as const,toolName:`mcp__${inverse?'PRIVATE':'threadterm'}__browser_eval`,text:'PRIVATE',fileReferences:[{path:'D:/PRIVATE'}],data:{...raw,server:inverse?'threadterm':'PRIVATE',tool:inverse?'browser_eval':'PRIVATE'}}))];
 for(const candidate of cases){
  assert.equal(hasRedactedBrowserResult(candidate),true);assert.equal(partBody(candidate),'');assert.equal(toolOutputPreview(candidate),undefined);
  assert.equal(isFeedbackCheck(candidate),false);assert.equal(feedbackNotesFromPart(candidate),undefined);
  assert.equal(JSON.stringify([partLabel(candidate,en=>en),describeTool(candidate,en=>en),candidate.type==='tool'?toolView(candidate):undefined]).includes('PRIVATE'),false);
  const items:ChatItem[]=[{id:'eval-item',role:'assistant',createdAt:'',parts:[candidate]}],bundle=chatMarkdownExportBundle(items,{title:'Chat',provider:'claude',createdAt:'',locale:'en'},'assets');
  assert.deepEqual(bundle.images,[]);assert.equal(bundle.markdown.includes('PRIVATE'),false);
 }
 const activity=browserToolActivityFromPart({type:'tool',toolName:'mcp__threadterm__browser_eval',data:{...raw,browserActivity:{tool:'browser_eval',outcome:'outcome_unknown',origin:'https://source.test',code:'PRIVATE',result:'PRIVATE',thumbnail:'data:image/jpeg;base64,PRIVATE'}}});
 assert.equal(activity?.outcome,'outcome_unknown');assert.equal(activity?.thumbnail,undefined);assert.equal(JSON.stringify(activity).includes('PRIVATE'),false);
 assert.deepEqual(browserToolIdentity({toolName:'mcp__foreign__browser_eval',data:{server:'foreign',tool:'browser_eval'}}),{displayTool:undefined,receiptTool:undefined,redact:false});
 assert.equal([...BROWSER_READ_TOOLS,...BROWSER_ACTION_TOOLS].length,10);assert.equal([...BROWSER_READ_TOOLS,...BROWSER_ACTION_TOOLS].includes('browser_eval' as never),false);
});
