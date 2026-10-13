#!/usr/bin/env node
// Offline-only ACP fixture. It never starts a model, reads credentials, or uses
// the network. Every prompt returns the Lane 5 Markdown corpus.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const emit=(sessionId,update)=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
const plainText='Lane 5 plain fixture complete.';
const replyText = [
  'Lane 5 fixture complete.', '', '```mermaid', 'graph TD; A-->B', '```', '',
  '![Fixture image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==)', '',
  'Inline $E=mc^2$ and $$x^2$$.', '', '```json', '{"answer":42,"nested":{"ok":true}}', '```', '',
  '```threadterm-ui',
  '{"version":1,"components":[{"type":"card","title":"Fixture","children":[{"type":"stat","label":"Tests","value":276}]}],"buttons":[{"label":"Insert fixture","text":"Fixture inserted."}]}',
  '```',
].join('\n');
if(process.argv.includes('--version'))console.log('lane5-chat-acp 0.1.0');
else if(process.argv.includes('--acp'))createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{let request;try{request=JSON.parse(line);}catch{return;}const{id,method,params={}}=request,reply=result=>send({jsonrpc:'2.0',id,result});if(method==='initialize')return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{},load:{}}}});if(method==='initialized')return;if(method==='session/new')return reply({sessionId:`lane5-${randomUUID()}`});if(method==='session/list')return reply({sessions:[]});if(method==='session/load')return reply({sessionId:params.sessionId});if(method==='session/prompt'){const input=JSON.stringify(params);if(!/plain/i.test(input))emit(params.sessionId,{sessionUpdate:'plan',entries:[{content:'Inspect fixture',status:'completed',priority:'medium'},{content:'Render fixture',status:'in_progress',priority:'low'}]});emit(params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:/plain/i.test(input)?plainText:replyText}});return reply({stopReason:'end_turn'});}if(method==='session/cancel')return reply({});if(id!==undefined)send({jsonrpc:'2.0',id,error:{code:-32601,message:'Unsupported method'}});});
else console.log('Lane 5 fixture terminal.');
