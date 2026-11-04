import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
function fixture(deferred=false){
 const app=new EventEmitter(),profiles=new Map(),proxies=[];
 const session={fromPartition(partition){if(!profiles.has(partition))profiles.set(partition,{partition,async setProxy(options){this.proxy=options;}});return profiles.get(partition);}};
 class Proxy{
  constructor(name,tunnel){this.name=name;this.tunnel=tunnel;this.port=5000+proxies.length;this.username='threadterm';this.secret=`secret-${this.port}`;this.disconnected=0;proxies.push(this);}
  async listen(){if(deferred)await new Promise(resolve=>this.started=resolve);return `http://127.0.0.1:${this.port}`;}
  matches(host,port){return !this.closed&&host==='127.0.0.1'&&port===this.port;}
  closeConnections(){this.disconnected++;}
  close(){this.closed=true;this.closeConnections();}
 }
 const module={exports:{}};
 const code=ts.transpileModule(readFileSync('desktop/src/machineBrowser.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='electron'?{app,session}:name==='./loopbackProxy.js'?{LoopbackProxy:Proxy}:assert.fail(name)});
 const manager=new module.exports.MachineBrowserProfiles();
 const owner=partition=>({session:session.fromPartition(partition),isDestroyed:()=>false});
 const login=(contents,authInfo)=>{let prevented=false,credentials;app.emit('login',{preventDefault(){prevented=true;}},contents,{},authInfo,(...value)=>credentials=value);return{prevented,credentials};};
 return {manager,owner,login,profiles,proxies};
}
test('proxy secrets are supplied only to proxy challenges for the matching machine browser session and endpoint',async()=>{
 const f=fixture(),runtime={openTunnel(){}};
 await f.manager.prepare('a','PC A',f.owner('persist:machine-a'),runtime);await f.manager.prepare('b','PC B',f.owner('persist:machine-b'),runtime);
 const auth={isProxy:true,host:'127.0.0.1',port:f.proxies[0].port};
 assert.deepEqual(f.login(f.owner('persist:threadterm-browser-a'),auth),{prevented:true,credentials:['threadterm',f.proxies[0].secret]});
 for(const [contents,info] of [[f.owner('persist:machine-a'),auth],[f.owner('persist:threadterm-browser'),auth],[f.owner('persist:threadterm-browser-b'),auth],[f.owner('persist:threadterm-browser-a'),{...auth,isProxy:false}],[f.owner('persist:threadterm-browser-a'),{...auth,host:'localhost'}],[f.owner('persist:threadterm-browser-a'),{...auth,port:1}],[undefined,auth],[{...f.owner('persist:threadterm-browser-a'),isDestroyed:()=>true},auth]])assert.deepEqual(f.login(contents,info),{prevented:false,credentials:undefined});
 assert.equal(f.profiles.get('persist:threadterm-browser-a').proxy.proxyBypassRules,'<-loopback>');
 assert.notEqual(f.proxies[0].secret,f.proxies[1].secret);f.manager.close();
});
test('one proxy is shared per computer; local profile stays untouched; disconnect/removal/gate cleanup is machine scoped',async()=>{
 const f=fixture(),runtime={openTunnel:(port,ip)=>({port,ip})},owner=f.owner('persist:machine-a');
 await f.manager.prepare('local','This PC',f.owner('default'),runtime);assert.equal(f.proxies.length,0);
 await f.manager.prepare('a','PC A',owner,runtime);await f.manager.prepare('a','PC A',f.owner('persist:machine-a'),runtime);await f.manager.prepare('b','PC B',f.owner('persist:machine-b'),runtime);assert.equal(f.proxies.length,2);
 assert.deepEqual(f.proxies[0].tunnel(5173,'127.0.0.1'),{port:5173,ip:'127.0.0.1'});
 f.manager.disconnect('a');assert.equal(f.proxies[0].disconnected,1);assert.equal(f.proxies[1].disconnected,0);
 f.manager.release('persist:threadterm-browser-a');assert.equal(f.proxies[0].closed,true);assert.ok(!f.proxies[1].closed);
 f.manager.close();assert.equal(f.proxies[1].closed,true);assert.equal(f.profiles.has('persist:threadterm-browser'),false);
});

test('a closed pending proxy cannot overwrite or close its replacement partition proxy',async()=>{
 const f=fixture(true),owner=f.owner('persist:machine-a'),runtime={openTunnel(){}};
 const first=f.manager.prepare('a','PC A',owner,runtime);const refused=assert.rejects(first,/closed/);
 f.manager.release('persist:threadterm-browser-a');
 const second=f.manager.prepare('a','PC A',owner,runtime);f.proxies[0].started();await refused;
 assert.ok(!f.proxies[1].closed);f.proxies[1].started();await second;
 assert.match(f.profiles.get('persist:threadterm-browser-a').proxy.proxyRules,/5001$/);f.manager.close();
});
