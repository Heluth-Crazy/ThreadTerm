import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuickLaunchRepoEntry } from '@threadterm/protocol';
import { editorStorage, pendingRepoMove, repoBadges, repoCommandId, repoDiff, storageMoveSources, visibleQuoted } from './runRepoConfig';

const entry = (overrides:Partial<QuickLaunchRepoEntry> = {}):QuickLaunchRepoEntry => ({
 id:'api', name:'API', command:'npm run dev', shell:'cmd', cwd:'apps/api', kind:'service',
 env:[{name:'LOG_LEVEL',value:'debug'},{name:'API_TOKEN',value:'local-secret',secret:true}],
 previewUrl:'http://localhost:3000/', fingerprint:'a'.repeat(64), trusted:false, changed:true, missingSecrets:['API_TOKEN'],
 accepted:{command:'npm run start',shell:'cmd',cwd:'apps/api',kind:'service',env:[{name:'LOG_LEVEL',value:'info'},{name:'API_TOKEN',secret:true}],previewUrl:'http://localhost:3000/'}, ...overrides,
});

test('repo diff compares structured env variables and presents changed launch fields without exposing a secret value', () => {
 const rows=repoDiff(entry());
 assert.deepEqual(rows.map(row=>row.field),['command','env']);
 const env=rows.find((row):row is Extract<typeof row,{field:'env'}>=>row.field==='env')!;
 assert.equal(env.name,'LOG_LEVEL');
 assert.equal(env.change,'changed');
 assert.equal(env.before,'value "info"');
 assert.equal(env.after,'value "debug"');
 assert.doesNotMatch(JSON.stringify(rows),/local-secret/);
});

test('repo diff cannot hide a second env variable in a newline or confuse a literal with a secret marker', () => {
 const rows=repoDiff(entry({
  accepted:{...entry().accepted!,env:[{name:'IGNORED',value:'x\nNODE_OPTIONS=--require=./hook.cjs'},{name:'REMOVED',value:'old'},{name:'TOKEN',secret:true}]},
  env:[{name:'IGNORED',value:'x'},{name:'NODE_OPTIONS',value:'--require=./hook.cjs'},{name:'TOKEN',value:'secret (local value)'}],
 }));
 assert.deepEqual(rows.filter(row=>row.field==='env').map(row=>[row.name,row.change]),[['IGNORED','changed'],['NODE_OPTIONS','added'],['REMOVED','removed'],['TOKEN','changed']]);
 assert.match(rows.find(row=>row.field==='env'&&row.name==='IGNORED')!.before!,/\\n/);
 assert.equal(visibleQuoted('zero​width\nnext'),'"zero\\u200Bwidth\\nnext"');
 assert.equal(visibleQuoted('⟨U+200B⟩'),'"⟨U+200B⟩"');
 assert.notEqual(visibleQuoted('​'),visibleQuoted('\\u200B'));
 assert.equal(visibleQuoted('\u2028\u2029\uD800'),'"\\u2028\\u2029\\uD800"');
 assert.equal(rows.find(row=>row.field==='env'&&row.name==='TOKEN')!.before,'secret (local value)');
 assert.equal(rows.find(row=>row.field==='env'&&row.name==='TOKEN')!.after,'value "secret (local value)"');
});

test('repo diff compares raw scalar fields before rendering invisible characters', () => {
 const rows=repoDiff(entry({accepted:{...entry().accepted!,command:'node​ server.mjs'},command:'node\\u200B server.mjs'}));
 const command=rows.find(row=>row.field==='command')!;
 assert.equal(command.before,'"node\\u200B server.mjs"');
 assert.equal(command.after,'"node\\\\u200B server.mjs"');
});

test('repo badges and storage mode keep secret and storage state explicit', () => {
 assert.deepEqual(repoBadges(entry()),{changed:true,missing:['API_TOKEN']});
 assert.equal(editorStorage(), 'local');
 assert.equal(editorStorage(undefined,entry()), 'repo');
 assert.equal(repoCommandId('api'),'repo:api');
});

test('a confirmed storage move retains Save and run intent', () => {
 assert.deepEqual(pendingRepoMove('toRepo',true),{direction:'toRepo',launch:true});
 assert.deepEqual(pendingRepoMove('toLocal',false),{direction:'toLocal',launch:false});
});

test('storage moves identify the source for runtime-only secret copying', () => {
 const saved={id:'local',revision:3}, repo={id:'shared'};
 assert.deepEqual(storageMoveSources(saved,repo,'f'.repeat(64),'D:/repo'),{localSource:saved,repoSource:{id:'shared',fingerprint:'f'.repeat(64),cwd:'D:/repo'} });
 assert.deepEqual(storageMoveSources(undefined,repo),{localSource:undefined,repoSource:undefined});
});
