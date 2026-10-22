import assert from 'node:assert/strict';
import test from 'node:test';
import { browserInnerRadius } from './browserRadius';

test('browser inner corners subtract the pane border in CSS pixels',()=>{
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'8px',borderBottomWidth:'1px'}),7);
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'8.5px',borderBottomWidth:'1.25px'}),7.25);
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'0px',borderBottomWidth:'1px'}),0);
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'1px',borderBottomWidth:'2px'}),0);
});

test('borderless hosts and unavailable computed geometry have square inner corners',()=>{
 assert.equal(browserInnerRadius(),0);
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'0px',borderBottomWidth:'0px'}),0);
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'',borderBottomWidth:'1px'}),0);
 assert.equal(browserInnerRadius({borderBottomLeftRadius:'8px',borderBottomWidth:''}),0);
});
