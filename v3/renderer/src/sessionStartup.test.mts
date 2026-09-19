import assert from "node:assert/strict";
import test from "node:test";
import { sessionStartup } from "./sessionStartup.js";

test("Windows one-shot commands preserve quotes and pipelines in one raw cmd argument",()=>{
  const command='  echo "hello world" | findstr "world"  ';
  assert.deepEqual(sessionStartup(command,true,"win32"),{executable:"cmd.exe",args:["/D","/S","/C",'echo "hello world" | findstr "world"']});
});
test("Windows interactive commands use /K and retain compound command text",()=>{
  const command='cd /d "C:\\Program Files" && dir';
  assert.deepEqual(sessionStartup(command,false,"win32"),{executable:"cmd.exe",args:["/D","/S","/K",command]});
});
