import assert from 'node:assert/strict';
import test from 'node:test';
import { usageCardsForItems } from '../renderer/src/usageCard.ts';
const text = value => ({type:'text',text:value});
const item = (parts, extra={}) => ({id:'a',role:'assistant',turnId:'t',createdAt:'now',parts,...extra});
const user = command => item([text(command)],{id:'u',role:'user'});
const status = data => ({type:'status',data});
const plan = rows => ({type:'text',data:{kind:'plan',rows}});
const get = (provider,parts,command) => usageCardsForItems(provider,[...(command?[user(command)]:[]),item(parts)]).get('a');

test('Codex usage excludes status-only fields and preserves zero without mutating payload',()=>{
 const data={kind:'usage',accountLoaded:true,rateLimitsLoaded:true,account:{planType:'prolite',email:'private@example.test'},directory:'C:/private',thread:{id:'private-thread'},context:{usedTokens:0,modelContextWindow:100,percentUsed:0},rateLimits:[{limitId:'codex',primary:{usedPercent:0,windowDurationMins:300,resetsAt:123}}]};
 const before=JSON.stringify(data),model=get('codex',[status(data)]);
 assert.equal(model.plan,'Pro Lite');assert.equal(model.limits[0].percent,0);assert.equal(model.metrics.find(row=>row.key==='contextUsed').value,0);
 assert.equal(JSON.stringify(data),before);assert.doesNotMatch(JSON.stringify(model),/private/);
 assert.equal(get('codex',[status({...data,kind:'status'})],'/status'),undefined);
 assert.equal(get('codex',[status({...data,kind:undefined})],'/status'),undefined);
 assert.ok(get('codex',[status({...data,kind:undefined})],'/usage'));
});
test('missing, pending and failed quota remain distinct',()=>{
 const loaded=get('codex',[status({kind:'usage',accountLoaded:true,rateLimitsLoaded:true,context:{usedTokens:null},rateLimits:[]})]);
 assert.deepEqual(loaded.metrics,[]);assert.deepEqual(loaded.limits,[]);assert.equal(loaded.plan,undefined);
 assert.equal(get('codex',[status({kind:'usage',accountLoaded:true,rateLimitsLoaded:false})]).notices[0].kind,'loading');
 const failed=get('codex',[status({kind:'usage',accountLoaded:true,rateLimitsLoaded:true,warning:'rate-limit data unavailable'})]);
 assert.equal(failed.notices[0].kind,'error');assert.deepEqual(failed.limits,[]);
});
test('Kimi combines native context and plan with zero output and missing cost omitted',()=>{
 const model=get('kimi',[text('Context: 22288 / 1048576 tokens (2%)\nSession total: 22248 input, 0 output'),plan([{label:'Weekly limit',percent:25,reset:'resets in 5d 21h 8m'},{label:'5h limit',percent:0}])]);
 assert.equal(model.limits.length,2);assert.equal(model.limits[1].percent,0);
 assert.equal(model.metrics.find(row=>row.key==='outputTokens').value,0);
 assert.equal(model.metrics.find(row=>row.key==='contextUsed').value,22288);
 assert.ok(!model.metrics.some(row=>row.key==='costUsd'));assert.deepEqual(model.notices,[]);
});
test('Grok combines title, account limits and scoped native metrics',()=>{
 const model=get('grok',[text('Grok usage — SuperGrok'),plan([{label:'Weekly limit',percent:60,resetAt:'2026-09-22T10:08:47Z'}]),text('Grok session usage (since start or last resume)\n\n- Input tokens: 1,234\n- Cache read tokens: 0\n- API time: 1.25 s\n- Cost (USD): $0.001234')]);
 assert.equal(model.plan,'SuperGrok');assert.equal(model.sinceResume,true);assert.equal(model.metrics.find(row=>row.key==='inputTokens').value,1234);
 assert.equal(model.metrics.find(row=>row.key==='cacheReadTokens').value,0);assert.equal(model.metrics.find(row=>row.key==='costUsd').value,.001234);assert.deepEqual(model.notices,[]);
});
test('no-call and partial failures stay visible without invented metrics',()=>{
 const model=get('grok',[text('Grok usage — SuperGrok'),text('Account usage limits are currently unavailable from Grok. Session statistics are shown separately below.'),text('Grok session usage (since start or last resume)\n\nNo model calls yet in this session.')]);
 assert.deepEqual(model.metrics,[]);assert.deepEqual(model.limits,[]);assert.deepEqual(model.notices.map(row=>row.key),['limitsUnavailable','noCalls']);
 const failed=get('grok',[text('Grok session usage is unavailable. No token counts or costs have been inferred.')],'/usage');
 assert.equal(failed.notices[0].key,'statsUnavailable');
});
test('ordinary answers and status do not become usage cards',()=>{
 assert.equal(get('kimi',[text('Final answer'),plan([{percent:10}]),{type:'approval',approvalId:'approval'}],'/usage'),undefined);
 assert.equal(get('grok',[text('Final answer'),plan([{percent:10}])],'explain'),undefined);
 assert.equal(get('kimi',[text('Context: 42 tokens')],'/explain'),undefined);
 assert.equal(get('grok',[text('Grok session status\n- Model: Grok')],'/status'),undefined);
 assert.equal(get('claude',[plan([{percent:10}])],'/usage'),undefined);
});
