#!/usr/bin/env node
// Local-only ACP fixture for the Run agent tools (2b). It receives the per-session MCP server
// through ACP, calls any threadterm tool the user asks for, and reports the exact tool result.
//   `call <tool> <json-args>` -> RUN_RESULT <MCP tools/call result>
//   `tools`                   -> RUN_TOOLS <JSON array of tool names>
// A spawn or protocol failure is reported as RUN_ERROR <message>.
// Every JSON reply is also written under $THREADTERM_V3_DATA/run-tools-replies, because the chat
// renderer re-serializes JSON-looking message text, so the transcript is not a transport.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`); let serial=0, replies=0; const servers=new Map();
function replyMarker(){return `${Date.now().toString(36)}-${String(++replies).padStart(3,'0')}-${Math.random().toString(36).slice(2,8)}`}
function record(kind,marker,payload){
  try{const dir=join(process.env.THREADTERM_V3_DATA||process.cwd(),'run-tools-replies');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${String(Date.now()).padStart(13,'0')}-${String(replies).padStart(3,'0')}-${kind}.json`),JSON.stringify({kind,marker,payload}));}catch{}
}
function promptText(params){return (params.prompt??[]).flatMap(part=>typeof part?.text==='string'?[part.text]:[]).join('\n').trim()}
function command(text){const call=/^call\s+(\S+)\s+(\{[\s\S]*\})?$/.exec(text);if(call)return {kind:'call',tool:call[1],args:call[2]?JSON.parse(call[2]):{}};if(text==='tools')return {kind:'tools'};throw Error(`unsupported prompt: ${text}`)}
async function withServer(server, action) {
  const env=Array.isArray(server.env)?Object.fromEntries(server.env.map(({name,value})=>[name,value])):server.env||{};
  const child=spawn(server.command,server.args||[],{env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let rest=''; const wait=new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{rest+=chunk;for(;;){const cut=rest.indexOf('\n');if(cut<0)return;const row=JSON.parse(rest.slice(0,cut));rest=rest.slice(cut+1);const done=wait.get(row.id);wait.delete(row.id);done?.(row);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;wait.set(id,row=>row.error?reject(Error(row.error.message)):resolve(row.result));child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`)});
  try {
    await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'run-tools-qa',version:'1'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    return await action(rpc);
  } finally { child.kill(); }
}
if(process.argv.includes('--version')) console.log('run-tools-echo 1.0.0');
else if(process.argv.includes('--acp')) createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',async line=>{
  let request;try{request=JSON.parse(line)}catch{return}
  const {id,method,params={}}=request;const reply=result=>send({jsonrpc:'2.0',id,result});
  if(method==='initialize')return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{}}});
  if(method==='initialized')return;
  if(method==='session/new'||method==='session/load'){const sessionId=method==='session/new'?`run-tools-${Date.now()}`:params.sessionId;servers.set(sessionId,params.mcpServers?.[0]);return reply({sessionId})}
  if(method==='session/prompt'){
    const marker=replyMarker();
    try{
      const intent=command(promptText(params)), server=servers.get(params.sessionId);
      if(!server)throw Error('no threadterm MCP server for this session');
      const result=await withServer(server, action=>intent.kind==='tools'
        ? action('tools/list',{}).then(listed=>(listed.tools??[]).map(tool=>tool.name))
        : action('tools/call',{name:intent.tool,arguments:intent.args}));
      record(intent.kind==='tools'?'tools':'result',marker,result);
      const text=`RUN_${intent.kind==='tools'?'TOOLS':'RESULT'} ${marker} ${JSON.stringify(result)}`;
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
    }catch(error){
      record('error',marker,String(error.message));
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`RUN_ERROR ${marker} ${error.message}`}}}});
    }
    return reply({})
  }
  if(method==='session/cancel')return reply({});
  send({jsonrpc:'2.0',id,error:{code:-32601,message:`unsupported ${method}`}});
});
