import assert from 'node:assert/strict';
import test from 'node:test';
import { diffFileKey, isDiffFileKey } from './diffKeyboard';

test('diff file navigation uses Alt arrows on Windows/Linux and Ctrl+Alt arrows on macOS',()=>{
 assert.deepEqual(diffFileKey('next','Win32'),{key:'ArrowRight',altKey:true,ctrlKey:false,aria:'Alt+ArrowRight',label:'Alt+Right'});
 assert.deepEqual(diffFileKey('previous','Linux x86_64'),{key:'ArrowLeft',altKey:true,ctrlKey:false,aria:'Alt+ArrowLeft',label:'Alt+Left'});
 assert.deepEqual(diffFileKey('next','MacIntel'),{key:'ArrowRight',altKey:true,ctrlKey:true,aria:'Control+Alt+ArrowRight',label:'Ctrl+Alt+Right'});
 assert.equal(isDiffFileKey({key:'ArrowRight',altKey:true,ctrlKey:false,metaKey:false,shiftKey:false},'next','Win32'),true);
 assert.equal(isDiffFileKey({key:'ArrowRight',altKey:true,ctrlKey:false,metaKey:false,shiftKey:false},'next','MacIntel'),false);
 assert.equal(isDiffFileKey({key:'ArrowRight',altKey:true,ctrlKey:true,metaKey:false,shiftKey:false},'next','MacIntel'),true);
});
