import test from 'node:test';
import assert from 'node:assert/strict';
import {METHODS,isRuntimeEvent,validateRequest,validateResult} from './index.ts';

const aggregate={
 tokens:{total:14,input:2,cacheRead:3,cacheWrite5m:1,cacheWrite1h:null,cacheWriteUnknown:null,output:8,reasoning:2},
 cost:{reportedUsd:null,apiEquivalentUsd:0.0002,pricedTokens:14,unpricedTokens:0,reportedRequests:0,pricedRequests:1,coverage:1},
 requests:1,sessions:1,activeTimeMs:500,activeTimeEstimated:false,pricingPending:false,
 quality:{exactRequests:1,derivedRequests:0,estimatedRequests:0,exactTokens:14,derivedTokens:0,estimatedTokens:0,exactShare:1,derivedShare:0,estimatedShare:0},
 bucketCoverage:{input:{reportedRequests:1,requests:1},cacheRead:{reportedRequests:1,requests:1},cacheWrite5m:{reportedRequests:1,requests:1},cacheWrite1h:{reportedRequests:0,requests:1},cacheWriteUnknown:{reportedRequests:0,requests:1},output:{reportedRequests:1,requests:1},reasoning:{reportedRequests:1,requests:1}},
};
const point={...aggregate,start:'2026-10-01',end:'2026-10-02',values:[{key:'codex',tokens:14,costUsd:0.0002,activeTimeMs:500,requests:1}]};
const session={...aggregate,provider:'codex',nativeSessionId:'native',threadtermSessionId:null,projectId:null,projectName:null,cwd:null,parentNativeSessionId:null,subagent:false,models:['gpt-test'],firstOccurredAt:'2026-10-01T00:00:00Z',lastOccurredAt:'2026-10-01T00:00:01Z',scope:'outside',subagentCount:0};

test('usage ledger requests are registered and bound their filters',()=>{
 for(const method of ['usage.ledger.summary','usage.ledger.series','usage.ledger.breakdown','usage.ledger.sessions','usage.ledger.session','usage.ledger.sources','usage.ledger.refresh','usage.ledger.rebuild','usage.ledger.cancel','usage.ledger.settings','usage.ledger.settings.update']) assert.ok(METHODS.includes(method));
 validateRequest('usage.ledger.summary',{from:'2026-10-01',to:'2026-10-02',scope:'all'});
 validateRequest('usage.ledger.series',{filters:{scope:'threadterm'},granularity:'week',stack:'tokens',weekStart:'monday'});
 validateRequest('usage.ledger.breakdown',{dimension:'project'});
 validateRequest('usage.ledger.sessions',{limit:200,offset:0,sort:'activeTime',order:'asc'});
 validateRequest('usage.ledger.session',{provider:'codex',nativeSessionId:'native'});
 validateRequest('usage.ledger.sources',{});
 validateRequest('usage.ledger.refresh',{operationId:'refresh'});
 validateRequest('usage.ledger.rebuild',{operationId:'rebuild'});
 validateRequest('usage.ledger.cancel',{scanId:'scan',operationId:'cancel'});
 validateRequest('usage.ledger.settings',{});
 validateRequest('usage.ledger.settings.update',{value:{includeOutside:false,weekStart:'sunday'},expectedRevision:0,operationId:'settings'});
 for(const input of [{from:'not-a-day'},{scope:'everywhere'},{enabledProviders:['']},{limit:201},{offset:-1},{search:'x'.repeat(257)}]) assert.throws(()=>validateRequest('usage.ledger.sessions',input));
 assert.throws(()=>validateRequest('usage.ledger.settings.update',{value:{other:true},expectedRevision:0,operationId:'settings'}));
});

test('usage ledger results express coverage, pending prices, source status, and session detail',()=>{
 validateResult('usage.ledger.summary',{...aggregate,from:'2026-10-01',to:'2026-10-02',scope:'all',sessionsWithoutUsage:0});
 validateResult('usage.ledger.series',{from:'2026-10-01',to:'2026-10-02',granularity:'day',stack:'provider',points:[point]});
 validateResult('usage.ledger.breakdown',{dimension:'project',items:[{...aggregate,key:'',label:'Other folders',labelKey:'otherFolders'}]});
 validateResult('usage.ledger.breakdown',{dimension:'model',items:[{...aggregate,key:'',label:'Grok — model not reported',labelKey:'grokModelNotReported'}]});
 validateResult('usage.ledger.sessions',{total:1,offset:0,limit:1,items:[session]});
 validateResult('usage.ledger.session',{...session,days:[point],subagents:[]});
 validateResult('usage.ledger.sources',{providers:[{provider:'codex',root:'history-root',status:'ready',missingSources:1,historyReadEnabled:false,historyReadLabelKey:'historyNotReadThreadtermOnly',lastRead:'2026-10-01T00:00:00Z',stats:{filesFound:1,filesRead:1,bytesRead:512,facts:1,problems:{},cancelled:false},bucketsReported:['input','output']}],parserVersion:1,scan:null});
 validateResult('usage.ledger.sources',{providers:[{provider:'claude',root:'history-root',status:'history_not_read',missingSources:0,historyReadEnabled:false,historyReadLabelKey:'historyNotReadThreadtermOnly',lastRead:null,stats:{filesFound:0,filesRead:0,bytesRead:0,facts:0,problems:{},cancelled:false},bucketsReported:[]}],parserVersion:1,scan:null});
 validateResult('usage.ledger.refresh',{scanId:'scan',state:'running'});
 validateResult('usage.ledger.rebuild',{scanId:'scan',state:'already_running'});
 validateResult('usage.ledger.cancel',{scanId:'scan',cancelRequested:true});
 const settings={revision:1,value:{includeOutside:true,providers:{codex:true},weekStart:'auto',priceOverrides:{}}};
 validateResult('usage.ledger.settings',settings); validateResult('usage.ledger.settings.update',settings);
 assert.throws(()=>validateResult('usage.ledger.summary',{...aggregate,from:null,to:null,scope:'all',sessionsWithoutUsage:0,secret:'no'}));
 assert.throws(()=>validateResult('usage.ledger.session',{...session,days:[],children:[]}));
 assert.equal(isRuntimeEvent({v:1,event:'usage.ledger.progress',epoch:'e',seq:1,data:{scanId:'scan',state:'completed',error:null}}),true);
});
