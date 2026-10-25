import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {connectPeer} from './pipe-client.mjs';

// Only a newly-created database and synthetic history; no agent CLI is started.
assert.equal(process.platform,'win32','named-pipe retention QA requires Windows');
const root=resolve(import.meta.dirname,'..');
const executable=resolve(process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(executable),'build the isolated runtime/target-qa binary first');
assert.ok(!/[\\/]runtime[\\/]target[\\/]/i.test(executable),'never use the developer runtime');
const scratch=await mkdtemp(join(tmpdir(),'threadterm-retention-'));
const data=join(scratch,'data'); await mkdir(data);
const pipe=`\\\\.\\pipe\\threadterm-retention-${randomUUID()}`;
const environment={...process.env,THREADTERM_V3_DATA:data,THREADTERM_V3_PIPE:pipe};
for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];
assert.ok(process.env.SystemRoot,'Windows SystemRoot is required for isolated QA');
environment.PATH=[dirname(process.execPath),join(process.env.SystemRoot,'System32')].join(';');
let daemon,control;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(){
 daemon=spawn(executable,[],{env:environment,windowsHide:true,stdio:'ignore'});
 for(let i=0;i<150;i++){
  try{control=await connectPeer(`${pipe}-control`);await control.auth((await readFile(join(data,'runtime.credential'),'utf8')).trim());return;}
  catch{control?.close();control=undefined;if(daemon.exitCode!==null)throw Error('isolated runtime exited');await delay(100);}
 }
 throw Error('runtime startup timeout');
}
async function stop(){
 if(control){try{await control.request('runtime.shutdown',{operationId:randomUUID()});}catch{}control.close();control=undefined;}
 if(!daemon)return;
 for(let i=0;i<60&&daemon.exitCode===null;i++)await delay(100);
 if(daemon.exitCode===null)daemon.kill();
}
function inspect(action){const db=new DatabaseSync(join(data,'threadterm-v3.sqlite3'));try{return action(db);}finally{db.close();}}
try{
 await start();await stop();
 const now=new Date().toISOString();
 inspect(db=>{
  const session=db.prepare("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at,read_only) VALUES(?,?,'shell','terminal','exited',?,?,0)");
  session.run('ended','Retained output',now,now);session.run('expired','Expired output','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z');
  const chunk=db.prepare('INSERT INTO output_chunks VALUES(?,?,?)');
  for(let i=0;i<10;i++)chunk.run('ended',i*1024*1024,Buffer.alloc(1024*1024,97+i));
  chunk.run('expired',0,Buffer.from('expired'));
  db.exec('BEGIN');
  const event=db.prepare("INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}','2000-01-01T00:00:00Z')");
  for(let i=0;i<10250;i++)event.run();
  db.exec("INSERT INTO operations VALUES('old-receipt','test','null','2000-01-01T00:00:00Z'); INSERT INTO operation_requests VALUES('pending','test','{}'); INSERT INTO external_operations VALUES('pending','2000-01-01T00:00:00Z'); COMMIT");
 });
 // Force the daemon-owned logger to rotate when a duplicate launch reports its
 // singleton error. The first daemon continues serving the isolated profile.
 await writeFile(join(data,'runtime.log'),Buffer.alloc(5*1024*1024,46));
 await start();
 const snapshot=await control.request('runtime.snapshot');
 assert.ok(snapshot.sessions.some(s=>s.id==='ended'));
 const healthTimes=[];
 for(let i=0;i<200;i++){
  const started=performance.now();await control.request('runtime.health');healthTimes.push(performance.now()-started);
  if(inspect(db=>db.prepare("SELECT (SELECT COUNT(*) FROM operations WHERE id='old-receipt')=0 AND (SELECT COALESCE(SUM(length(data)),0) FROM output_chunks WHERE session_id='ended')=8388608 AND (SELECT COUNT(*) FROM output_chunks WHERE session_id='expired')=0 AS done").get().done))break;
  await delay(25);
 }
 inspect(db=>{
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operations WHERE id='old-receipt'").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM external_operations WHERE id='pending'").get().n,1);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n>=10000);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE created_at='2000-01-01T00:00:00Z'").get().n<=10000);
 });
 const page=await control.request('terminal.read',{sessionId:'ended',cursor:0,limit:1024*1024});
 assert.equal(page.fromCursor,2*1024*1024);assert.equal(page.truncated,true);assert.equal(Buffer.from(page.data,'base64')[0],99);
 const expired=await control.request('terminal.read',{sessionId:'expired',cursor:0,limit:1024});
 assert.deepEqual([expired.fromCursor,expired.nextCursor,expired.truncated,expired.data],[7,7,true,'']);
 const duplicate=spawn(executable,[],{env:environment,windowsHide:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{duplicate.kill();reject(Error('duplicate launch timeout'));},10000);duplicate.once('exit',()=>{clearTimeout(timer);resolve();});duplicate.once('error',reject);});
 assert.ok((await readFile(join(data,'runtime.log'),'utf8')).length<5*1024*1024);
 assert.ok(existsSync(join(data,'runtime.log.1')));
 console.log('PASS retention startup: 30-day compaction, 10000-event floor, pending fence');
 console.log('PASS terminal replay: retained oldest cursor/truncated flag and expired high-water');
 console.log('PASS daemon-owned runtime log rotates at 5 MiB independently of Electron');
 console.log(`Foreground health during compaction: max ${Math.max(...healthTimes).toFixed(1)} ms`);
 console.log(`QA scratch: ${scratch}`);
}finally{await stop();await rm(scratch,{recursive:true,force:true});}
