import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import { TailscaleOnlyControl, TailscaleOnlySetting } from './TailscaleOnlySetting';
import { settingsPageVisible } from '../machines';

test('Tailscale-only switch is bilingual, labelled, confirmed-state controlled and describes both device profiles', () => {
  for (const zh of [false,true]) {
    const html = renderToStaticMarkup(createElement(TailscaleOnlyControl,{zh,checked:true,disabled:false,onChange:()=>{}}));
    assert.match(html,/role="switch"/); assert.match(html,/aria-checked="true"/); assert.match(html,/aria-describedby=/);
    assert.ok(html.includes(zh ? '仅接受我的 Tailscale 网络中的设备' : 'Only accept devices on my Tailscale network'));
    assert.ok(html.includes(zh ? '同时适用于电脑和手机。' : 'Applies to computers and phones.'));
  }
});
test('Computers and Phones mount the same setting only in This PC administration', () => {
  for (const file of ['MachineSettings','DeviceSettings']) assert.match(readFileSync(`renderer/src/components/${file}.tsx`,'utf8'), /<TailscaleOnlySetting zh=\{zh\}/);
  assert.equal(settingsPageVisible('computers',true),false); assert.equal(settingsPageVisible('mobile',true),false);
  const previous = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{threadterm:{machineId:'remote'}}});
  try { assert.equal(renderToStaticMarkup(createElement(TailscaleOnlySetting,{zh:false})), ''); }
  finally { if(previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window'); }
});
