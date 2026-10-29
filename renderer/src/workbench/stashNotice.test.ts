import assert from 'node:assert/strict';
import test from 'node:test';
import { stashConflictNotice } from './stashNotice';
import { stashDropInterference, stashInterferenceError } from './errors';

test('apply and smart-switch conflict notices identify the stash with a short OID, message, and full OID title', () => {
 const apply=stashConflictNotice({oid:'0123456789abcdef',message:'WIP settings',zh:false});
 assert.deepEqual(apply,{before:'Stash ',label:'0123456 · WIP settings',title:'0123456789abcdef',after:' was applied with conflicts and kept until you resolve them. Staged changes were restored as unstaged.'});
 const smart=stashConflictNotice({oid:'0123456789abcdef',message:'切换前更改',branch:'feature',zh:true});
 assert.deepEqual(smart,{before:'已切换到 feature；重新应用暂存 ',label:'0123456 · 切换前更改',title:'0123456789abcdef',after:' 时产生冲突。解决前会保留该暂存；已暂存的更改会以未暂存状态恢复。'});
});

test('drop interference preserves every named stash and recovery guidance', () => {
 const value={oid:'0123456789abcdef',ourEntryDropped:false,restored:[{oid:'abcdef0123456789',message:'other'}],restoreFailed:[{oid:'fedcba9876543210',message:'failed',error:'git_failed'}],orderChanged:true,unknownEntryLost:true};
 assert.deepEqual(stashDropInterference(value),value);
 const notice=stashInterferenceError(value,false)!;
 assert.match(notice,/0123456.*not dropped/);
 assert.match(notice,/abcdef0 · other/);
 assert.match(notice,/fedcba9 · failed/);
 assert.match(notice,/Stash order changed/);
 assert.match(notice,/git fsck --unreachable/);
 assert.doesNotMatch(stashInterferenceError(value,false,false)!,/Restored:|Could not restore:/);
 assert.match(stashInterferenceError({...value,ourEntryDropped:true},true)!,/已删除/);
});
