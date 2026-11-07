// Supplemental browser QA only: validates the real Expo Web export's empty/offline shell.
// It does not exercise NativePort, camera, iOS, or synthetic paired-computer flows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root=process.cwd(),out=join(root,'mobile','.qa-web'),shots=join(root,'mobile','.qa-shots');
execFileSync(process.platform==='win32'?'cmd.exe':'npx',[...(process.platform==='win32'?['/d','/s','/c','npx expo export --platform web --output-dir .qa-web']:['expo','export','--platform','web','--output-dir','.qa-web'])],{cwd:join(root,'mobile'),stdio:'inherit',windowsHide:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2'};
const server=createServer((req,res)=>{const raw=new URL(req.url??'/','http://qa').pathname;const relative=raw==='/'?'index.html':raw.slice(1);const file=normalize(join(out,relative));if(!file.startsWith(out)||!existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('content-type',mime[extname(file)]??'application/octet-stream');res.end(readFileSync(file));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;const browser=await chromium.launch({headless:true});
try { for(const scheme of ['light','dark'])for(const locale of ['en','zh-CN']) {const page=await browser.newPage({viewport:{width:390,height:844},colorScheme:scheme,locale});const errors=[];page.on('pageerror',error=>errors.push(error));await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'networkidle'});await page.getByRole('tab',{name:/settings|设置/i}).click();await page.getByText(/No paired computers|未配对电脑/).waitFor();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,'no horizontal overflow');assert.equal(errors.length,0,errors.map(String).join('\n'));await page.screenshot({path:join(shots,`empty-${locale}-${scheme}-390x844.png`),fullPage:true});await page.close();} } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
