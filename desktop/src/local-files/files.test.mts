import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, mkdir, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import test from 'node:test';
import { MAX_FILE_WINDOW_BYTES, readBoundedFile } from './bounded-read.js';
import { LocalFileService, NoEffectError } from './files.js';
import { MAX_DOCUMENT_BYTES } from './search.js';

async function fixture() { const root=await mkdtemp(join(tmpdir(),'threadterm-local-files-')); return {root,service:new LocalFileService({trashItem:async path=>{await rm(path,{recursive:true});}})}; }
test('reads and writes runtime-compatible fingerprints without following final links', async () => {
 const {root,service}=await fixture(); try { await writeFile(join(root,'a.txt'),'old'); const read=await service.read(root,{path:'a.txt'});
 assert.equal(read.fingerprint,createHash('sha256').update('old').digest('hex'));
 const saved=await service.write(root,{path:'a.txt',content:'new',expectedFingerprint:read.fingerprint}); assert.equal(saved.content,'new');
 await assert.rejects(service.write(root,{path:'a.txt',content:'later',expectedFingerprint:read.fingerprint}),/file_conflict/);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('UTF-8 BOM and CRLF bytes round-trip unchanged and keep Runtime search columns', async () => {
 const {root,service}=await fixture(); const target=join(root,'bom.txt');
 const original=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('needle\r\nsecond\r\n')]);
 try {
  await writeFile(target,original); const opened=await service.read(root,{path:'bom.txt'});
  assert.equal(opened.content,'\uFEFFneedle\r\nsecond\r\n'); assert.equal(opened.fingerprint,createHash('sha256').update(original).digest('hex'));
  const saved=await service.write(root,{path:'bom.txt',content:opened.content,expectedFingerprint:opened.fingerprint});
  assert.equal(saved.content,opened.content); assert.equal(saved.fingerprint,opened.fingerprint); assert.deepEqual(await readFile(target),original);
  const result=await service.search(root,{query:'needle'}); assert.deepEqual(result.files,[{path:'bom.txt',matches:[{line:1,column:2,length:6,preview:'\uFEFFneedle',previewColumn:1}]}]);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('file windows reconstruct UTF-8 and CRLF with the Runtime change token',async()=>{
 const {root,service}=await fixture(), path=join(root,'window.txt');
 const source=Array.from({length:20_000},(_,index)=>`${index}: €\r\n`).join('')+'€'.repeat(3_000);
 try{
  await writeFile(path,source);const metadata=await stat(path,{bigint:true});
  const expectedToken=`${metadata.size}:${metadata.mtimeNs/1_000_000_000n}:${metadata.mtimeNs%1_000_000_000n}`;
  let offset=0,token:string|undefined,rebuilt='';
  while(offset<Buffer.byteLength(source,'utf8')){
   const window=await service.readWindow(root,{path:'window.txt',offset,maxBytes:4*1024,...(token?{changeToken:token}:{})});
   assert.ok(window.end>offset,`window must advance at ${offset}`);assert.ok(Buffer.byteLength(window.content,'utf8')<=4*1024);
   assert.equal(window.changeToken,expectedToken);token=window.changeToken;rebuilt+=window.content;offset=window.end;
  }
  assert.equal(rebuilt,source);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('file windows handle long lines, EOF, stale tokens and binary text',async()=>{
 const {root,service}=await fixture(), path=join(root,'long.txt');
 try{
  await writeFile(path,'x'.repeat(MAX_FILE_WINDOW_BYTES*2));
  const first=await service.readWindow(root,{path:'long.txt',offset:0});
  assert.equal(Buffer.byteLength(first.content,'utf8'),MAX_FILE_WINDOW_BYTES);assert.equal(first.endsMidLine,true);
  const last=await service.readWindow(root,{path:'long.txt',offset:first.size-MAX_FILE_WINDOW_BYTES,changeToken:first.changeToken});
  assert.equal(last.end,last.size);assert.equal(last.startsMidLine,true);
  assert.deepEqual(await service.readWindow(root,{path:'long.txt',offset:last.size+1,changeToken:last.changeToken}),
   {content:'',start:last.size,end:last.size,size:last.size,changeToken:last.changeToken,startsMidLine:false,endsMidLine:false});
  await writeFile(path,'changed');await assert.rejects(service.readWindow(root,{path:'long.txt',offset:0,changeToken:first.changeToken}),/file_changed/);
  await writeFile(path,Buffer.from([0x6f,0x6b,0,0x62,0x61,0x64]));await assert.rejects(service.readWindow(root,{path:'long.txt',offset:0}),/binary_file/);
  await writeFile(path,Buffer.from([0x74,0x65,0x78,0x74,0xe2,0x82]));await assert.rejects(service.readWindow(root,{path:'long.txt',offset:0}),/binary_file/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('file windows match Runtime directory errors',async()=>{
 const {root,service}=await fixture();
 try{await mkdir(join(root,'folder'));await assert.rejects(service.readWindow(root,{path:'folder',offset:0}),error=>error instanceof Error&&error.message==='file_not_file');}
 finally{await rm(root,{recursive:true,force:true});}
});
test('file windows reject a target replaced while its open handle is being read',async()=>{
 const {root,service}=await fixture(), target=join(root,'window-race.txt'), replacement=join(root,'replacement.txt');let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{entered=resolve;});
 const probe=await open(target,'w+'),prototype=Object.getPrototypeOf(probe) as {read:(...args:unknown[])=>Promise<unknown>};await probe.close();const original=prototype.read;let armed=true;
 try{
  await writeFile(target,Buffer.alloc(MAX_FILE_WINDOW_BYTES*2,97));await writeFile(replacement,Buffer.alloc(MAX_FILE_WINDOW_BYTES*2,98));
  prototype.read=async function(...args:unknown[]){if(armed){armed=false;entered();await gate;}return original.apply(this,args);};
  const pending=service.readWindow(root,{path:'window-race.txt',offset:0});await reading;
  try{await rename(replacement,target);}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;await writeFile(target,Buffer.alloc(1024,98));}
  release();await assert.rejects(pending,/file_changed|path_escape/);
 }finally{release();prototype.read=original;await rm(root,{recursive:true,force:true});}
});
test('existing reads and writes match Runtime scoped path forms without permitting traversal', async () => {
 const {root,service}=await fixture(); try {
  await writeFile(join(root,'source.txt'),'one'); await mkdir(join(root,'nested')); await writeFile(join(root,'nested','item.txt'),'nested');
  const dotted=await service.read(root,{path:'./source.txt'}); assert.equal(dotted.content,'one');
  const saved=await service.write(root,{path:'./source.txt',content:'two',expectedFingerprint:dotted.fingerprint}); assert.equal(saved.content,'two'); assert.equal(await readFile(join(root,'source.txt'),'utf8'),'two');
  assert.equal((await service.read(root,{path:'nested//item.txt'})).content,'nested');
  if(process.platform==='win32') {
   const native=await service.read(root,{path:'nested\\item.txt'}); assert.equal(native.content,'nested');
   await service.write(root,{path:'nested\\item.txt',content:'native',expectedFingerprint:native.fingerprint}); assert.equal(await readFile(join(root,'nested','item.txt'),'utf8'),'native');
  }
  for(const path of ['../source.txt','nested/../source.txt',...(process.platform==='win32'?['nested\\..\\source.txt']:[])]) {
   await assert.rejects(service.read(root,{path}),/invalid_path/);
   await assert.rejects(service.write(root,{path,content:'escaped',expectedFingerprint:saved.fingerprint}),error=>error instanceof NoEffectError&&/invalid_path/.test(error.message));
  }
  assert.equal(await readFile(join(root,'source.txt'),'utf8'),'two');
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('mutations reject escapes and tag pre-effect failures', async () => {
 const {root,service}=await fixture(); try { for(const path of ['../escape','C:/escape','a/../escape','CON','trailing.']) await assert.rejects(service.create(root,{path,kind:'file'}),error=>error instanceof NoEffectError && error.noEffect);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('create rename delete and bounded preview remain root-relative', async () => {
 const {root,service}=await fixture(); try { await service.create(root,{path:'nested/a.txt',kind:'file'}); await service.rename(root,{path:'nested/a.txt',newPath:'nested/b.txt'}); await service.write(root,{path:'nested/b.txt',content:'abcdef',expectedFingerprint:createHash('sha256').update('').digest('hex')});
 const preview=await service.preview(root,{path:'nested/b.txt',offset:2,limit:3}); assert.equal(Buffer.from(preview.chunk,'base64').toString(),'cde'); assert.equal(preview.eof,false); assert.equal(preview.path,toNamespacedPath(join(root,'nested','b.txt')));
 const metadata=await stat(join(root,'nested','b.txt'),{bigint:true}); const modified=process.platform==='win32'?`SystemTime { intervals: ${metadata.mtimeNs/100n+116_444_736_000_000_000n} }`:`SystemTime { tv_sec: ${metadata.mtimeNs/1_000_000_000n}, tv_nsec: ${metadata.mtimeNs%1_000_000_000n} }`; assert.equal(preview.fingerprint,`${metadata.dev}:${metadata.ino}:${metadata.size}:${modified}`);
 await assert.rejects(service.preview(root,{path:'nested\\b.txt',offset:0,limit:1}),/invalid_path/); await assert.rejects(service.preview(root,{path:'nested:b.txt',offset:0,limit:1}),/invalid_path/);
 const listed=await service.files(root); assert.deepEqual(listed.paths,['nested/b.txt']); const removed=await service.delete(root,{path:'nested/b.txt',permanent:true}); assert.equal(removed.recycled,false);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('document reads are Word-only, signature-checked and bounded by the Office cap', async () => {
 const {root,service}=await fixture();
 try {
  const zip=Buffer.concat([Buffer.from('PK\x03\x04','binary'),Buffer.alloc(1024*1024+7,97)]);
  await writeFile(join(root,'report.docx'),zip); await writeFile(join(root,'macro.docm'),Buffer.from('PK\x03\x04macro','binary'));
  await writeFile(join(root,'protected.docx'),Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  await writeFile(join(root,'damaged.docx'),'not a zip'); await writeFile(join(root,'notes.txt'),Buffer.from('PK\x03\x04','binary'));
  const first=await service.document(root,{path:'report.docx',offset:0,limit:1024*1024});
  assert.equal(first.size,zip.length); assert.equal(first.eof,false); assert.deepEqual(Buffer.from(first.chunk,'base64'),zip.subarray(0,1024*1024));
  const last=await service.document(root,{path:'report.docx',offset:1024*1024,limit:1024*1024});
  assert.equal(last.eof,true); assert.equal(last.fingerprint,first.fingerprint); assert.equal(Buffer.from(last.chunk,'base64').length,11);
  await service.document(root,{path:'macro.docm',offset:0,limit:1});
  await assert.rejects(service.document(root,{path:'protected.docx',offset:0,limit:1}),/document_protected/);
  await assert.rejects(service.document(root,{path:'damaged.docx',offset:0,limit:1}),/unsupported_document/);
  await assert.rejects(service.document(root,{path:'notes.txt',offset:0,limit:1}),/unsupported_document/);
  await assert.rejects(service.document(root,{path:'report.docx',offset:0,limit:1024*1024+1}),/invalid_limit/);
  await assert.rejects(service.document(root,{path:'report.docx',offset:zip.length+1,limit:1}),/invalid_offset/);
  const huge=join(root,'huge.docx'); const handle=await open(huge,'w'); await handle.truncate(100*1024*1024+1); await handle.close();
  await assert.rejects(service.document(root,{path:'huge.docx',offset:0,limit:1}),/file_too_large/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('bounded reads reject a canonical parent replaced by an escaping junction', async () => {
 const {root}=await fixture(), outside=await mkdtemp(join(tmpdir(),'threadterm-bounded-outside-')); try {
  const directory=join(root,'inside'), displaced=join(root,'displaced'); await mkdir(directory); await writeFile(join(directory,'data.txt'),'inside'); await writeFile(join(outside,'data.txt'),'outside');
  const canonical=join(directory,'data.txt'); await rename(directory,displaced); await symlink(outside,directory,process.platform==='win32'?'junction':'dir');
  await assert.rejects(readBoundedFile(canonical,1024,'file_too_large'),/path_escape/); assert.equal(await readFile(join(outside,'data.txt'),'utf8'),'outside');
 } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});

test('preview rejects a target changed or replaced while its old handle is being read', async () => {
 const {root,service}=await fixture(); const target=join(root,'preview.bin'), replacement=join(root,'replacement.bin'); let release!:()=>void; let entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}); const reading=new Promise<void>(resolve=>{entered=resolve;});
 const probe=await open(target,'w+'); const prototype=Object.getPrototypeOf(probe) as {read: (...args:unknown[])=>Promise<unknown>}; await probe.close(); const original=prototype.read; let armed=true;
 try {
  await writeFile(target,Buffer.alloc(1024*1024,97)); await writeFile(replacement,Buffer.alloc(1024,98));
  prototype.read=async function(...args:unknown[]){if(armed){armed=false;entered();await gate;}return original.apply(this,args);};
  const pending=service.preview(root,{path:'preview.bin',offset:0,limit:1024*1024}); await reading;
  try{await rename(replacement,target);}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;await writeFile(target,Buffer.alloc(1024,98));}
  release();
  await assert.rejects(pending,/file_changed|path_escape/);
 } finally { release(); prototype.read=original; await rm(root,{recursive:true,force:true}); }
});
test('search runs matches off the main event loop and preserves UTF-16 columns', async () => {
 const {root,service}=await fixture(); try { await writeFile(join(root,'find.txt'),'😀 needle\nneedle'); const result=await service.search(root,{query:'needle'}); assert.equal(result.files[0]?.matches[0]?.column,4); assert.equal(result.files[0]?.matches[1]?.line,2);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('a real junction cannot escape and rename/delete operate on the junction, never its target', async () => {
 const {root,service}=await fixture(), outside=await mkdtemp(join(tmpdir(),'threadterm-local-outside-')); try { await writeFile(join(outside,'secret.txt'),'secret'); await symlink(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(service.read(root,{path:'escape/secret.txt'}),/path_escape/);
 await service.rename(root,{path:'escape',newPath:'moved'}); assert.equal(await readFile(join(outside,'secret.txt'),'utf8'),'secret'); assert.equal((await lstat(join(root,'moved'))).isSymbolicLink(),true);
 await service.delete(root,{path:'moved',permanent:true}); assert.equal(await readFile(join(outside,'secret.txt'),'utf8'),'secret'); await assert.rejects(lstat(join(root,'moved')));
 } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});

test('atomic writes replace only one hardlink and readonly/conflict failures have no effect', async () => {
 const {root,service}=await fixture(); const source=join(root,'source.txt'), sibling=join(root,'sibling.txt'), locked=join(root,'locked.txt');
 try {
  await writeFile(source,'old'); await link(source,sibling); const opened=await service.read(root,{path:'source.txt'});
  const saved=await service.write(root,{path:'source.txt',content:'new',expectedFingerprint:opened.fingerprint});
  assert.equal(saved.content,'new'); assert.equal(await readFile(source,'utf8'),'new'); assert.equal(await readFile(sibling,'utf8'),'old');
  await writeFile(locked,'locked'); await chmod(locked,0o444); const readonly=await service.read(root,{path:'locked.txt'}); assert.equal(readonly.readonly,true);
  await assert.rejects(service.write(root,{path:'locked.txt',content:'changed',expectedFingerprint:readonly.fingerprint}),error=>error instanceof NoEffectError&&/readonly_file/.test(error.message));
  assert.equal(await readFile(locked,'utf8'),'locked');
 } finally { await chmod(locked,0o666).catch(()=>{}); await rm(root,{recursive:true,force:true}); }
});

test('reads and search bound allocation and reject oversize, NUL and invalid UTF-8 documents', async () => {
 const {root,service}=await fixture(); try {
  await writeFile(join(root,'large.txt'),Buffer.alloc(MAX_DOCUMENT_BYTES+1,97));
  await writeFile(join(root,'binary.txt'),Buffer.from([97,0,98]));
  await writeFile(join(root,'utf8.txt'),Buffer.from([0xc3,0x28]));
  await assert.rejects(service.read(root,{path:'large.txt'}),/file_too_large/);
  await assert.rejects(service.read(root,{path:'binary.txt'}),/binary_file/);
  await assert.rejects(service.read(root,{path:'utf8.txt'}),/binary_file/);
  const result=await service.search(root,{query:'a'}); assert.equal(result.searchedFiles,0); assert.deepEqual(result.files,[]);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('a mutation is not tagged no-effect after it creates a parent', async () => {
 const {root,service}=await fixture(); try { await mkdir(join(root,'dir')); await writeFile(join(root,'dir','kept.txt'),'kept');
  await assert.rejects(service.rename(root,{path:'dir',newPath:'dir/new/moved'}),error=>error instanceof Error&&!(error instanceof NoEffectError)&&/invalid_path/.test(error.message));
  assert.equal((await stat(join(root,'dir','new'))).isDirectory(),true); assert.equal(await readFile(join(root,'dir','kept.txt'),'utf8'),'kept');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('walk matches ancestor, nested, .ignore and .gitignore precedence without entering ignored directories', async () => {
 const parent=await mkdtemp(join(tmpdir(),'threadterm-ignore-parent-')), root=join(parent,'project'), service=new LocalFileService({trashItem:async()=>{}});
 const prior=process.env.GIT_CONFIG_GLOBAL; try {
  await mkdir(root); const emptyConfig=join(parent,'empty.gitconfig'); await writeFile(emptyConfig,''); process.env.GIT_CONFIG_GLOBAL=emptyConfig;
  await writeFile(join(parent,'.gitignore'),'ancestor.txt\nancestor-reincluded.txt\n');
  await writeFile(join(parent,'.ignore'),'ancestor-ignore.txt\n');
  await writeFile(join(root,'.gitignore'),'git-only.txt\nshared.txt\n!ancestor-reincluded.txt\n!ancestor-ignore.txt\nignored-dir/\n');
  await writeFile(join(root,'.ignore'),'!shared.txt\nignore-only.txt\n');
  await mkdir(join(root,'nested')); await writeFile(join(root,'nested','.gitignore'),'*.tmp\n!keep.tmp\n');
  await mkdir(join(root,'ignored-dir')); await writeFile(join(root,'ignored-dir','.gitignore'),'!keep.txt\n');
  for(const path of ['ancestor.txt','ancestor-reincluded.txt','ancestor-ignore.txt','git-only.txt','shared.txt','ignore-only.txt','nested/drop.tmp','nested/keep.tmp','nested/visible.txt','ignored-dir/keep.txt']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'x');}
  const result=await service.files(root);
  assert.deepEqual(result.paths.filter(path=>!path.startsWith('.')&&!path.endsWith('/.gitignore')&&!path.endsWith('/.ignore')).sort(),['ancestor-reincluded.txt','nested/keep.tmp','nested/visible.txt','shared.txt']);
 } finally { if(prior===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=prior; await rm(parent,{recursive:true,force:true}); }
});

test('walk honors configured global, XDG fallback and linked-worktree info excludes with Runtime precedence', async () => {
 const parent=await mkdtemp(join(tmpdir(),'threadterm-ignore-global-')), root=join(parent,'worktree'), service=new LocalFileService({trashItem:async()=>{}});
 const keys=['GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','XDG_CONFIG_HOME','HOME','USERPROFILE'] as const; const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try {
  await mkdir(root); const globalIgnore=join(parent,'global.ignore'), config=join(parent,'global.gitconfig'); await writeFile(globalIgnore,'*.global\n'); await writeFile(config,`[core]\nexcludesFile = "${globalIgnore.replace(/\\/g,'/')}"\n`); process.env.GIT_CONFIG_GLOBAL=config; process.env.GIT_CONFIG_SYSTEM=join(parent,'none');
  await writeFile(join(root,'drop.global'),'x'); await writeFile(join(root,'keep.global'),'x'); await writeFile(join(root,'.gitignore'),'!keep.global\n');
  assert.deepEqual((await service.files(root)).paths.filter(path=>path.endsWith('.global')),['keep.global']);

  delete process.env.GIT_CONFIG_GLOBAL; process.env.HOME=join(parent,'home'); process.env.USERPROFILE=process.env.HOME; process.env.XDG_CONFIG_HOME=join(parent,'xdg'); await mkdir(join(process.env.XDG_CONFIG_HOME,'git'),{recursive:true}); await writeFile(join(process.env.XDG_CONFIG_HOME,'git','ignore'),'xdg.txt\n'); await writeFile(join(root,'xdg.txt'),'x');
  assert.equal((await service.files(root)).paths.includes('xdg.txt'),false);

  const common=join(parent,'common.git'), gitDirectory=join(common,'worktrees','linked'); await mkdir(join(common,'info'),{recursive:true}); await mkdir(gitDirectory,{recursive:true}); await writeFile(join(common,'info','exclude'),'linked.txt\nkeep-linked.txt\n'); await writeFile(join(gitDirectory,'commondir'),'../..\n'); await writeFile(join(root,'.git'),`gitdir: ${gitDirectory}\n`); await writeFile(join(root,'.gitignore'),'!keep.global\n!keep-linked.txt\n'); await writeFile(join(root,'linked.txt'),'x'); await writeFile(join(root,'keep-linked.txt'),'x');
  const linked=(await service.files(root)).paths; assert.equal(linked.includes('linked.txt'),false); assert.equal(linked.includes('keep-linked.txt'),true);
 } finally { for(const key of keys){const value=prior[key];if(value===undefined)delete process.env[key];else process.env[key]=value;} await rm(parent,{recursive:true,force:true}); }
});

test('search matches Runtime globs, Unicode boundaries, byte limits and match caps', async () => {
 const {root,service}=await fixture(); try {
  await mkdir(join(root,'dist')); await mkdir(join(root,'src')); await writeFile(join(root,'dist','a.ts'),'needle'); await writeFile(join(root,'src','a.ts'),'needle'); await writeFile(join(root,'root.ts'),'needle'); await writeFile(join(root,'words.txt'),'x猫x 猫 😀 ÉCLAIR');
  const dist=await service.search(root,{query:'needle',include:'dist'}); assert.deepEqual(dist.files.map(file=>file.path),['dist/a.ts']);
  const types=await service.search(root,{query:'needle',include:'*.ts',exclude:'dist'}); assert.deepEqual(types.files.map(file=>file.path),['root.ts','src/a.ts']);
  const word=await service.search(root,{query:'猫',wholeWord:true}); assert.equal(word.files[0]?.matches.length,1); assert.equal(word.files[0]?.matches[0]?.column,5);
  const unicode=await service.search(root,{query:'éclair'}); assert.equal(unicode.files[0]?.matches[0]?.column,10);
  await assert.rejects(service.search(root,{query:'界'.repeat(334)}),/invalid_search_query/);
  await writeFile(join(root,'many.txt'),Array.from({length:201},()=> 'hit').join(' ')); const capped=await service.search(root,{query:'hit'}); assert.equal(capped.files.find(file=>file.path==='many.txt')?.matches.length,200); assert.equal(capped.truncated,true);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('pathological regexes and queue pressure stay off main and release worker capacity', async () => {
 const {root,service}=await fixture(); try { await writeFile(join(root,'slow.txt'),`${'a'.repeat(256*1024)}!`); let ticked=false; const tick=setTimeout(()=>{ticked=true;},25); const started=Date.now();
  const result=await service.search(root,{query:'(a+)+$',regex:true}); clearTimeout(tick); assert.equal(result.truncated,true); assert.equal(ticked,true); assert.ok(Date.now()-started<2500);
  const settled=await Promise.allSettled(Array.from({length:20},()=>service.search(root,{query:'(a+)+$',regex:true}))); assert.ok(settled.some(item=>item.status==='rejected'&&/search_busy/.test(String(item.reason))));
  await writeFile(join(root,'fast.txt'),'ready'); const followup=await service.search(root,{query:'ready'}); assert.equal(followup.files.some(file=>file.path==='fast.txt'),true);
 } finally { await rm(root,{recursive:true,force:true}); }
});
