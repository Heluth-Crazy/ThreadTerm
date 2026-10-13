// QA-only Pi JSONL RPC fixture. It records argv and never launches Pi or a
// provider. The runtime invokes it through a `pi.cmd` shim in pi-trust-real.
const {appendFileSync}=require('node:fs'); const {createInterface}=require('node:readline');
const log=process.env.THREADTERM_QA_PI_TRUST_LOG;if(!log)process.exit(2);
for(const key of Object.keys(process.env))if(key.toLowerCase()==='path')delete process.env[key];
appendFileSync(log,JSON.stringify({kind:'launch',argv:process.argv.slice(2),cwd:process.cwd()})+'\n');
const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
const reply=(request,data)=>out({type:'response',id:request.id,command:request.type,success:true,data});
const args=process.argv.slice(2);const sessionFlag=args.includes('--session-id')?'--session-id':'--session';const sessionId=args.includes(sessionFlag)?args[args.indexOf(sessionFlag)+1]:'qa-pi-session';
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 if(!line.trim())return;
 const request=JSON.parse(line);
 appendFileSync(log,JSON.stringify({kind:'request',method:request.type,params:request})+'\n');
 if(request.id===undefined)return;
 if(request.type==='get_state')return reply(request,{sessionId,model:{id:'qa-pi-model',provider:'qa'},thinkingLevel:'off',isStreaming:false});
 if(request.type==='get_available_models')return reply(request,{models:[{id:'qa-pi-model',name:'QA Pi model',provider:'qa',contextWindow:200000,maxTokens:4096}]});
 if(request.type==='get_available_thinking_levels')return reply(request,{levels:['off']});
 if(request.type==='get_commands')return reply(request,{commands:[]});
 if(request.type==='prompt'){
  reply(request,{});out({type:'agent_start'});
  if(request.message==='hold')return;
  out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Fake Pi reply'}});
  out({type:'agent_settled',messages:[]});return;
 }
 if(request.type==='abort'){reply(request,{});out({type:'agent_settled',messages:[]});return;}
 reply(request,{});
});
