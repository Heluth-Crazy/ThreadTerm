import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CHAT_IMAGE_BYTES, selectChatImageAttachments, validateChatImages } from './chatImages';

const image='data:image/png;base64,AAAA';
test('page screenshots attach only for image-capable receivers and fit the existing composer',()=>{
 assert.deepEqual(selectChatImageAttachments([], [image], false), []);
 assert.deepEqual(selectChatImageAttachments([image,image,image], [image,image], true), [image]);
 assert.deepEqual(selectChatImageAttachments([image,image,image,image], [image], true), []);
 assert.deepEqual(selectChatImageAttachments([], ['invalid',image], true), [image]);
});
test('page screenshots respect the same 4 MiB data URL budget as native chat input',()=>{
 const large='data:image/png;base64,'+'A'.repeat(MAX_CHAT_IMAGE_BYTES-30);
 const accepted=selectChatImageAttachments([large], [image,image], true);
 assert.deepEqual(accepted,[]);
 assert.doesNotThrow(()=>validateChatImages([large,...accepted]));
 assert.deepEqual(selectChatImageAttachments([], [large+'A'.repeat(40),image], true), [image]);
 const selected=selectChatImageAttachments([], Array(6).fill(image), true);
 assert.equal(selected.length,4); assert.doesNotThrow(()=>validateChatImages(selected));
});
