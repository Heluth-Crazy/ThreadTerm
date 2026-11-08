import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { controlPermissionNotice } from '../src/ui/format';

test('the computer permission ceiling differs from the local Face ID lock in both languages',()=>{
  for(const unlocked of [true,false]) {
    assert.equal(controlPermissionNotice('readonly',unlocked,'en'),'This computer allows viewing only.');
    assert.equal(controlPermissionNotice('readonly',unlocked,'zh-CN'),'此电脑仅允许查看。');
  }
  assert.equal(controlPermissionNotice('fullcontrol',false,'en'),'Locked — unlock with Face ID to control.');
  assert.match(controlPermissionNotice('fullcontrol',false,'zh-CN'),/Face ID/);
  assert.doesNotMatch(controlPermissionNotice('fullcontrol',true,'en'),/unlock|Locked/);
});

test('native permission cache follows authenticated snapshots before returning to JavaScript',()=>{
  const swift=readFileSync('mobile/modules/threadterm-mobile/ios/ThreadTermMobileModule.swift','utf8');
  assert.match(swift,/let result = try environment\.core\.request[\s\S]*if method == "mobile.snapshot"[\s\S]*registry\.updateSnapshot\(id: machineId, resultJson: result\)[\s\S]*return result/);
  const registry=readFileSync('mobile/modules/threadterm-mobile/ios/MachineRegistry.swift','utf8');
  assert.match(registry,/func updateSnapshot[\s\S]*snapshot\["permission"\] as\? String[\s\S]*try updateConnection\(id: id, permission: permission\)/);
});
