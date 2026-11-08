import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CONTROL_METHODS, READ_METHODS } from '../src/core/wire';

const root=process.cwd();
function quoted(source:string,name:string,close:string) {
  const start=source.indexOf(name);assert.notEqual(start,-1,`missing ${name}`);
  const end=source.indexOf(close,start);assert.notEqual(end,-1,`unterminated ${name}`);
  return [...source.slice(start,end).matchAll(/"([^"]+)"/g)].map(match=>match[1]!);
}

test('mobile method policy stays aligned across JavaScript, Swift, and runtime allowlists',()=>{
  const swift=readFileSync(join(root,'mobile/modules/threadterm-mobile/ios/ThreadTermMobileModule.swift'),'utf8');
  const rust=readFileSync(join(root,'runtime/src/mobile.rs'),'utf8');
  const intrinsic=new Set(['mobile.snapshot','mobile.events.subscribe']);
  assert.deepEqual(new Set(quoted(swift,'private let readMethods: Set<String> = [','\n]').filter(method=>!intrinsic.has(method))),new Set(READ_METHODS));
  assert.deepEqual(new Set(quoted(swift,'private let controlMethods: Set<String> = [','\n]')),new Set(CONTROL_METHODS));
  assert.deepEqual(new Set(quoted(rust,'pub(crate) const VIEW_METHODS: &[&str] = &[','\n];').filter(method=>!intrinsic.has(method))),new Set(READ_METHODS));
  assert.deepEqual(new Set(quoted(rust,'pub(crate) const CONTROL_METHODS: &[&str] = &[','\n];')),new Set(CONTROL_METHODS));
});
