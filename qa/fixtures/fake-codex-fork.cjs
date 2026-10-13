// Durable offline Codex app-server: temporary processes read the same history.
const {appendFileSync,readFileSync,writeFileSync,existsSync}=require('node:fs');
const {createInterface}=require('node:readline'); const {randomUUID}=require('node:crypto');
const store=process.env.THREADTERM_QA_FORK_STORE,log=process.env.THREADTERM_QA_FORK_LOG,control=process.env.THREADTERM_QA_FORK_CONTROL;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),record=value=>log&&appendFileSync(log,JSON.stringify(value)+'\n');
const read=()=>store&&existsSync(store)?JSON.parse(readFileSync(store,'utf8')):{},save=value=>writeFileSync(store,JSON.stringify(value));
const controls=()=>control&&existsSync(control)?JSON.parse(readFileSync(control,'utf8')):{};
let current,pending;
if(process.argv.includes('--version')){console.log('codex-qa-fork 1.0.0');process.exit(0)}
if(process.argv[2]==='login'&&process.argv[3]==='status'){console.log('authenticated QA fixture');process.exit(0)}
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 let request;try{request=JSON.parse(line)}catch{return}const{id,method,params={}}=request;if(id===undefined)return;
 const ok=result=>send({id,result}),fail=message=>send({id,error:{code:-32000,message}});record({pid:process.pid,method,params});
 if(method==='initialize')return ok({capabilities:{}});
 if(method==='account/read')return ok({account:{type:'chatgpt'},requiresOpenaiAuth:false});
 if(method==='account/rateLimits/read'||method==='skills/list')return ok({data:[]});
 if(method==='model/list')return ok({data:[{id:'qa-fork',displayName:'QA fork',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'}]}]});
 const db=read();
 if(method==='thread/start'){current=randomUUID();db[current]={id:current,cwd:params.cwd,status:{type:'idle'},turns:[],model:'qa-fork'};save(db);return ok({thread:db[current],threadSettings:{model:'qa-fork',reasoningEffort:'low',approvalPolicy:'on-request',sandbox:'workspace-write'}})}
 if(method==='thread/read'||method==='thread/resume'){const row=db[params.threadId];if(!row)return fail('unknown fake native thread');if(method==='thread/resume')current=row.id;return ok({thread:{...row,turns:params.includeTurns===false?[]:row.turns},threadSettings:{model:'qa-fork',reasoningEffort:'low',approvalPolicy:'on-request',sandbox:'workspace-write'}})}
 if(method==='thread/list')return ok({data:Object.values(db),nextCursor:null});
 if(method==='thread/inject_items')return ok({});
 if(method==='thread/fork'){const state=controls();if(state.fail)return fail('deliberate native fork failure');const source=db[params.threadId];if(!source)return fail('unknown source');const index=params.lastTurnId==null?source.turns.length-1:source.turns.findIndex(turn=>turn.id===params.lastTurnId);if(params.lastTurnId!=null&&index<0)return fail('unknown lastTurnId');const child={...source,id:randomUUID(),turns:source.turns.slice(0,index+1)};const complete=()=>{const latest=read();latest[child.id]=child;save(latest);ok({thread:child})};return state.delayMs?setTimeout(complete,state.delayMs):complete()}
 if(method==='turn/start'){current=params.threadId||current;const row=db[current];if(!row)return fail('unknown current');const text=(params.input||[]).map(item=>item.text||'').join('');const number=row.turns.length+1,turn={id:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'userMessage',content:[{type:'text',text}]},{id:randomUUID(),type:'agentMessage',text:`QA reply ${number}: ${text}`,phase:'final_answer'}]};send({method:'turn/started',params:{threadId:current,turn:{id:turn.id,status:'inProgress'}}});ok({turn:{id:turn.id}});if(text==='hold'){pending=turn;return}row.turns.push(turn);save(db);send({method:'item/completed',params:{threadId:current,turnId:turn.id,item:turn.items[1]}});return send({method:'turn/completed',params:{threadId:current,turn}})}
 if(method==='turn/interrupt'){ok({});if(pending){send({method:'turn/completed',params:{threadId:current,turn:{id:pending.id,status:'interrupted'}}});pending=undefined}return}
 fail(`unexpected fake method ${method}`);
});
