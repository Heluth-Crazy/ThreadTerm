// Deterministic Codex app-server fixture for E1. The -c per-process MCP
// override is parsed exactly as Codex receives it; it never launches Codex.
const {spawn}=require('node:child_process'); const {createInterface}=require('node:readline');
let native=`qa-e1-codex-${Date.now()}`,turn=0,serial=0; const send=value=>process.stdout.write(JSON.stringify(value)+'\n'); const setting=prefix=>{const row=process.argv.find(value=>value.startsWith(prefix));return row&&row.slice(prefix.length)}; const literal=value=>(value||'').replace(/^['"]|['"]$/g,''); const quoted=value=>[...String(value).matchAll(/'([^']*)'|"([^"]*)"/g)].map(match=>match[1]??match[2]);
if(process.argv.includes('--version')){console.log('codex-qa-chat-tools 1.0.0');process.exit(0)}
if(process.argv[2]==='login'&&process.argv[3]==='status'){console.log('authenticated QA fixture');process.exit(0)}
async function ask(){const command=literal(setting('mcp_servers.threadterm.command=')),args=quoted(setting('mcp_servers.threadterm.args=')),env=Object.fromEntries([...String(setting('mcp_servers.threadterm.env=')||'').matchAll(/([A-Z0-9_]+)=('([^']*)'|"([^"]*)")/g)].map(match=>[match[1],match[3]??match[4]]));if(!command)throw Error('missing ThreadTerm MCP override');const child=spawn(command,args,{env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});let rest='';const wait=new Map();child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{rest+=chunk;for(;;){const cut=rest.indexOf('\n');if(cut<0)return;const row=JSON.parse(rest.slice(0,cut));rest=rest.slice(cut+1);const done=wait.get(row.id);wait.delete(row.id);done?.(row)}});const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;wait.set(id,row=>row.error?reject(Error(row.error.message)):resolve(row.result));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});try{await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fake-codex-e1',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');const tools=await rpc('tools/list',{});if(!tools.tools?.some(tool=>tool.name==='ask_user'))throw Error('ask_user missing');return await rpc('tools/call',{name:'ask_user',arguments:{questions:[{question:'Choose the E1 response',options:[{label:'Answer'},{label:'Dismiss'}]}]}})}finally{child.kill()}}
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  let request; try { request=JSON.parse(line); } catch { return; }
  const {id,method,params={}}=request; const result=value=>send({id,result:value});
  if(method==='initialize') return result({capabilities:{}});
  if(method==='account/read') return result({account:{type:'chatgpt'},requiresOpenaiAuth:false});
  if(method==='account/rateLimits/read'||method==='skills/list') return result({data:[]});
  if(method==='model/list') return result({data:[{id:'qa-e1',displayName:'QA E1',supportedReasoningEfforts:[]}]});
  if(method==='thread/start'||method==='thread/resume') return result({thread:{id:native,cwd:params.cwd,status:{type:'idle'}},threadSettings:{model:'qa-e1'}});
  if(method==='thread/read') return result({thread:{id:native,status:{type:'idle'}}});
  if(method==='turn/start') { const idTurn=`e1-turn-${++turn}`, tool={id:`${idTurn}-ask`,type:'mcpToolCall',server:'threadterm',tool:'ask_user',arguments:{questions:'E1 QA'}};
    send({method:'turn/started',params:{threadId:native,turn:{id:idTurn}}}); result({turn:{id:idTurn}}); send({method:'item/started',params:{threadId:native,turnId:idTurn,item:tool}});
    void ask().then(answer=>{
      send({method:'item/completed',params:{threadId:native,turnId:idTurn,item:{...tool,result:answer}}});
      send({method:'item/completed',params:{threadId:native,turnId:idTurn,item:{id:`${idTurn}-answer`,type:'agentMessage',text:`ASK_RESULT ${JSON.stringify(answer)}`}}});
      send({method:'turn/completed',params:{threadId:native,turn:{id:idTurn,status:'completed'}}});
    }).catch(error=>{
      send({method:'item/completed',params:{threadId:native,turnId:idTurn,item:{...tool,error:{message:error.message}}}});
      send({method:'item/completed',params:{threadId:native,turnId:idTurn,item:{id:`${idTurn}-error`,type:'agentMessage',text:`ASK_ERROR ${error.message}`}}});
      send({method:'turn/completed',params:{threadId:native,turn:{id:idTurn,status:'completed'}}});
    }); return; }
  if(method==='turn/interrupt') { send({method:'turn/completed',params:{threadId:native,turn:{id:params.turnId,status:'cancelled'}}}); return result({}); }
  send({id,error:{code:-32601,message:`unexpected ${method}`}});
});
