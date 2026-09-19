import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {validateResult} from '../protocol/index.ts';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-ipc-'));
const data=join(scratch,'data'),project=join(scratch,'project');await mkdir(data);await mkdir(project);
const pipe=`\\\\.\\pipe\\threadterm-v3-qa-${randomUUID()}`;
const exe=resolve(process.env.THREADTERM_QA_RUNTIME_EXE || 'runtime/target/debug/threadterm-v3-runtime.exe');
let stderr='';
const daemon=spawn(exe,[],{env:{...process.env,THREADTERM_V3_DATA:data,THREADTERM_V3_PIPE:pipe},windowsHide:true,stdio:['ignore','ignore','pipe']});
daemon.stderr.on('data',b=>stderr+=b);
class Peer {
 queue=[];waiters=[];pending=Buffer.alloc(0);closed=false;
 constructor(socket){this.socket=socket;socket.on('data',b=>{this.pending=Buffer.concat([this.pending,b]);while(this.pending.length>=4){const n=this.pending.readUInt32LE();if(n>8388608)throw Error('oversized server frame');if(this.pending.length<n+4)break;const frame=this.pending.subarray(4,n+4);this.pending=this.pending.subarray(n+4);const w=this.waiters.shift();if(w)w.resolve(frame);else this.queue.push(frame)}});socket.on('error',e=>this.fail(e));socket.on('close',()=>this.fail(Error('closed')))}
 fail(e){this.closed=true;for(const w of this.waiters.splice(0))w.reject(e)}
 next(ms=5000){if(this.queue.length)return Promise.resolve(this.queue.shift());if(this.closed)return Promise.reject(Error('closed'));return new Promise((resolve,reject)=>{const w={resolve:b=>{clearTimeout(t);resolve(b)},reject:e=>{clearTimeout(t);reject(e)}};const t=setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);reject(Error('frame timeout'))},ms);this.waiters.push(w)})}
 send(b){const f=Buffer.alloc(b.length+4);f.writeUInt32LE(b.length);b.copy(f,4);this.socket.write(f)}
 json(v){this.send(Buffer.from(JSON.stringify(v)))}
 binary(kind,header){const h=Buffer.from(JSON.stringify(header)),b=Buffer.alloc(5+h.length);b[0]=kind;b.writeUInt32LE(h.length,1);h.copy(b,5);this.send(b)}
 async auth(credential,id=randomUUID()){const challenge=JSON.parse(await this.next());assert.equal(challenge.contract,2);this.json({kind:'auth',clientId:id,protocol:1,contract:2,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${id}:${challenge.nonce}`).digest('hex')});const proof=JSON.parse(await this.next());assert.equal(proof.kind,'authenticated');this.epoch=proof.epoch;assert.equal(proof.contract,2);assert.equal(proof.hmac,createHmac('sha256',credential).update(`server:1:${id}:${challenge.nonce}`).digest('hex'));return id}
 async request(method,params={}){const id=randomUUID();this.json({v:1,id,method,params});for(;;){const msg=JSON.parse(await this.next(10000));if(msg.id!==id)continue;if(msg.error)throw Object.assign(Error(msg.error.message),{code:msg.error.code});validateResult(method,msg.result);return msg.result}}
 close(){this.socket.destroy()}
}
const peers=[];
async function connect(name){const s=await new Promise((res,rej)=>{const sock=net.createConnection(name);sock.once('connect',()=>res(sock));sock.once('error',rej)});const p=new Peer(s);peers.push(p);return p}
let credential;
try {
 for(let n=0;n<100;n++){try{credential=(await readFile(join(data,'runtime.credential'),'utf8')).trim();const p=await connect(`${pipe}-control`);await p.auth(credential);p.close();break}catch(e){if(daemon.exitCode!==null)throw Error(`daemon exited ${daemon.exitCode}: ${stderr}`);await delay(100)}}
 assert.ok(credential,'credential generated');
 const controller=await connect(`${pipe}-control`);const principal=await controller.auth(credential);
 const observer=await connect(`${pipe}-control`);await observer.auth(credential);
 const initial=await observer.request('runtime.snapshot');
 assert.equal(controller.epoch,initial.epoch,'control handshake uses snapshot epoch');
 assert.equal(observer.epoch,initial.epoch,'new pipe keeps runtime epoch');
 const health=await controller.request('runtime.health');assert.equal(health.epoch,controller.epoch);
 const reconnected=await connect(`${pipe}-control`);await reconnected.auth(credential);assert.equal(reconnected.epoch,initial.epoch,'reconnect must not invent a random epoch');reconnected.close();
 const projectRow=await controller.request('project.add',{path:project,name:'IPC QA',operationId:randomUUID()});
 let event;for(let n=0;n<10;n++){const m=JSON.parse(await observer.next());if(m.event==='state.changed'&&m.seq>initial.revision){event=m;break}}
 assert.ok(event,'second client receives state event without requests');
 const createParams={projectId:projectRow.id,cwd:project,title:'IPC shell',provider:'shell',mode:'terminal',executable:'cmd.exe',args:['/Q','/K'],operationId:randomUUID()};
 const session=await controller.request('session.create',createParams);
 const again=await controller.request('session.create',createParams);assert.equal(again.id,session.id,'idempotent session create');
 const lease=await controller.request('session.claim',{sessionId:session.id,clientId:principal});
 await controller.request('session.renew',{sessionId:session.id,leaseEpoch:lease.leaseEpoch});
 await assert.rejects(observer.request('terminal.input',{sessionId:session.id,data:'echo unauthorized\r',leaseEpoch:lease.leaseEpoch}));
 const output=await connect(`${pipe}-output`);await output.auth(credential,principal);assert.equal(output.epoch,initial.epoch,'output handshake shares runtime epoch');
 output.binary(3,{sessionId:session.id,cursor:0});output.binary(2,{sessionId:session.id,credit:65536});
 await delay(600);
 await controller.request('terminal.input',{sessionId:session.id,data:'echo THREADTERM_DELAYED_OUTPUT\r',leaseEpoch:lease.leaseEpoch});
 let text='',cursor=0;
 for(let n=0;n<40&&!text.includes('THREADTERM_DELAYED_OUTPUT');n++){const b=await output.next();assert.equal(b[0],1);const hlen=b.readUInt32LE(1),h=JSON.parse(b.subarray(5,5+hlen)),bytes=b.subarray(5+hlen);assert.equal(h.cursor,cursor);cursor+=bytes.length;text+=bytes.toString('utf8')}
 assert.ok(text.includes('THREADTERM_DELAYED_OUTPUT'),'delayed PTY output delivered without extra output requests');
 await controller.request('terminal.resize',{sessionId:session.id,cols:100,rows:35,leaseEpoch:lease.leaseEpoch});
 output.close();
 const replay=await connect(`${pipe}-output`);await replay.auth(credential,principal);replay.binary(3,{sessionId:session.id,cursor:0});replay.binary(2,{sessionId:session.id,credit:65536});
 const firstReplay=await replay.next();assert.equal(firstReplay[0],1);assert.equal(JSON.parse(firstReplay.subarray(5,5+firstReplay.readUInt32LE(1))).cursor,0);
 // A second daemon must exit before recovery can corrupt the first daemon's live state.
 const duplicate=spawn(exe,[],{env:{...process.env,THREADTERM_V3_DATA:data,THREADTERM_V3_PIPE:pipe},windowsHide:true,stdio:'ignore'});
 await new Promise((r,j)=>{const timer=setTimeout(()=>{duplicate.kill();j(Error('duplicate daemon did not exit'))},5000);duplicate.on('exit',()=>{clearTimeout(timer);r()})});
 const current=await controller.request('runtime.snapshot');assert.equal(current.sessions.find(s=>s.id===session.id).status,'running');
 await controller.request('session.stop',{sessionId:session.id,operationId:randomUUID()});
 await controller.request('runtime.shutdown',{operationId:randomUUID()});
 if(daemon.exitCode===null) await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('confirmed shutdown did not naturally exit daemon')),10000);daemon.once('exit',()=>{clearTimeout(timer);resolve()})});
 assert.equal(daemon.exitCode,0);
 const result={passed:true,checks:['mutual authentication','cross-client state event','real PTY delayed output','plain input','resize','output replay','lease principal rejection','create idempotency','singleton recovery exclusion','explicit shutdown'],scratch};
 await mkdir('qa/results',{recursive:true});await writeFile('qa/results/runtime-ipc.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error){console.error(error);console.error(stderr);process.exitCode=1}
finally{for(const p of peers)p.close();if(daemon.exitCode===null)daemon.kill();}
