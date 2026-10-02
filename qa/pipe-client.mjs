import {validateWireSuccess} from '../protocol/generated-validators.js';
import net from 'node:net';
import {createHmac,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {validateResult} from '../protocol/index.ts';
export class Peer {
 queue=[];waiters=[];events=[];pending=Buffer.alloc(0);closed=false;
 constructor(socket){this.socket=socket;socket.on('data',b=>{this.pending=Buffer.concat([this.pending,b]);while(this.pending.length>=4){const n=this.pending.readUInt32LE();if(n>8388608)throw Error('oversized server frame');if(this.pending.length<n+4)break;const frame=this.pending.subarray(4,n+4);this.pending=this.pending.subarray(n+4);const w=this.waiters.shift();if(w)w.resolve(frame);else this.queue.push(frame)}});socket.on('error',e=>this.fail(e));socket.on('close',()=>this.fail(Error('closed')))}
 fail(e){this.closed=true;for(const w of this.waiters.splice(0))w.reject(e)}
 next(ms=5000){if(this.queue.length)return Promise.resolve(this.queue.shift());if(this.closed)return Promise.reject(Error('closed'));return new Promise((resolve,reject)=>{const w={resolve:b=>{clearTimeout(t);resolve(b)},reject:e=>{clearTimeout(t);reject(e)}};const t=setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);reject(Error('frame timeout'))},ms);this.waiters.push(w)})}
 send(b){const f=Buffer.alloc(b.length+4);f.writeUInt32LE(b.length);b.copy(f,4);this.socket.write(f)}
 json(v){this.send(Buffer.from(JSON.stringify(v)))}
 binary(kind,header){const h=Buffer.from(JSON.stringify(header)),b=Buffer.alloc(5+h.length);b[0]=kind;b.writeUInt32LE(h.length,1);h.copy(b,5);this.send(b)}
 async auth(credential,id=randomUUID()){const challenge=JSON.parse(await this.next());assert.equal(challenge.contract,2);this.json({kind:'auth',clientId:id,protocol:1,contract:2,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${id}:${challenge.nonce}`).digest('hex')});const proof=JSON.parse(await this.next());assert.equal(proof.kind,'authenticated');assert.equal(proof.contract,2);assert.equal(proof.hmac,createHmac('sha256',credential).update(`server:1:${id}:${challenge.nonce}`).digest('hex'));return id}
 captureEvent(msg){if(msg&&msg.v===1&&typeof msg.event==='string'&&Number.isSafeInteger(msg.seq)){this.events.push(msg);return true}return false}
 async request(method,params={},timeoutMs=10000){const id=randomUUID();this.json({v:1,id,method,params});for(;;){const msg=JSON.parse(await this.next(timeoutMs));if(this.captureEvent(msg))continue;if(msg.id!==id)continue;if(msg.error)throw Object.assign(Error(msg.error.message),{code:msg.error.code});try{validateResult(method,msg.result)}catch(error){error.schemaErrors=validateWireSuccess.errors;throw error}return msg.result}}
 async nextEvent(predicate=()=>true,ms=10000){const deadline=Date.now()+ms;for(;;){const index=this.events.findIndex(predicate);if(index>=0)return this.events.splice(index,1)[0];const remaining=deadline-Date.now();if(remaining<=0)throw Error('event timeout');let frame;try{frame=await this.next(remaining)}catch(error){if(error.message==='frame timeout')throw Error('event timeout');throw error}const msg=JSON.parse(frame);if(this.captureEvent(msg))continue}}
 close(){this.socket.destroy()}
}

export async function connectPeer(name){const socket=await new Promise((resolve,reject)=>{const socket=net.createConnection(name);socket.once('connect',()=>resolve(socket));socket.once('error',reject)});return new Peer(socket)}
