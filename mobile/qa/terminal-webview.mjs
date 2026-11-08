// Executes the exact offline WebView document in a real browser engine.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const outfile='mobile/.test-build/terminalDocument.cjs';
await build({entryPoints:['mobile/src/ui/terminalDocument.ts'],outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {terminalDocument,mobileTerminalTheme}=createRequire(import.meta.url)('../../'+outfile);
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:390,height:600}}),errors=[];
page.on('pageerror',e=>errors.push(String(e)));
try {
  await page.setContent(terminalDocument());
  await page.waitForFunction(()=>!!window.__ttTerminal);
  const banner='\x1b[36mOpenAI Codex (v0.167.0)\x1b[0m\r\n\x1b[32m你好 — green\x1b[0m\r\nfixture> ';
  const stream={epoch:0,seq:1,chunks:[{seq:1,from:0,to:Buffer.byteLength(banner),data:Buffer.from(banner).toString('base64')}]};
  await page.evaluate(({stream,theme})=>{window.inputs=[];window.addEventListener('message',e=>{if(e.data?.threadtermTerminal){const value=JSON.parse(e.data.threadtermTerminal);if(value.type==='input')window.inputs.push(value.data);}});window.__ttReceive({config:{cols:120,rows:40,control:true,inputToken:1,theme},stream});},{stream,theme:mobileTerminalTheme(false)});
  const text=()=>page.evaluate(()=>Array.from({length:window.__ttTerminal.buffer.active.length},(_,i)=>window.__ttTerminal.buffer.active.getLine(i).translateToString(true)).join('\n'));
  await page.waitForFunction(()=>window.__ttTerminal.buffer.active.getLine(0).translateToString(true).includes('OpenAI'));
  for(let i=0;i<10;i++){
    await page.setViewportSize({width:390,height:300});await page.evaluate(stream=>window.__ttReceive({focus:true,stream}),stream);
    await page.setViewportSize({width:390,height:600});await page.evaluate(stream=>window.__ttReceive({blur:true,stream}),stream);
  }
  assert.equal((await text()).match(/OpenAI Codex/g)?.length,1,'bridge repeats and keyboard layouts never replay output');
  assert.equal(await page.evaluate(()=>window.__ttTerminal.cols),120);
  assert.equal(await page.evaluate(()=>window.__ttTerminal.rows),40);
  await page.setViewportSize({width:844,height:390});
  assert.deepEqual(await page.evaluate(()=>[window.__ttTerminal.cols,window.__ttTerminal.rows]),[120,40],'rotation changes only the local font/viewport');
  await page.setViewportSize({width:390,height:600});
  assert.equal(await page.evaluate(()=>window.__ttTerminal.options.fontSize),10,'readable minimum preserves horizontal panning');
  assert.ok(await page.evaluate(()=>document.getElementById('pan').scrollWidth>innerWidth),'host columns pan instead of wrapping to phone width');
  assert.equal(await page.evaluate(()=>window.__ttTerminal.buffer.active.getLine(1).getCell(0).isFgPalette()),true,'ANSI palette retained');
  await page.evaluate(()=>window.__ttReceive({focus:true}));
  await page.keyboard.type('testmsg');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.inputs.join('').includes('testmsg\r'));
  assert.equal(await page.evaluate(()=>window.inputs.join('')),'testmsg\r');
  await page.evaluate(()=>window.__ttReceive({token:1,ctrl:true,key:'c'}));
  await page.waitForFunction(()=>window.inputs.at(-1)==='\x03');
  await page.evaluate(()=>window.__ttReceive({token:1,ctrl:true,key:'\x1b[D'}));
  await page.waitForFunction(()=>window.inputs.at(-1)==='\x1b[1;5D');
  await page.evaluate(()=>window.__ttReceive({token:1,key:'x'}));
  await page.waitForFunction(()=>window.inputs.at(-1)==='x');
  const count=await page.evaluate(()=>window.inputs.length);
  await page.evaluate(theme=>window.__ttReceive({config:{cols:120,rows:40,control:true,inputToken:3,theme},token:1,key:'stale\r'}),mobileTerminalTheme(false));
  assert.equal(await page.evaluate(()=>window.inputs.length),count,'queued key commands cannot cross a connection/lease token');
  await page.evaluate(()=>window.__ttReceive({toggleKeyboard:true}));
  assert.equal(await page.evaluate(()=>document.activeElement===window.__ttTerminal.textarea),false);
  await page.evaluate(()=>window.__ttReceive({toggleKeyboard:true}));
  assert.equal(await page.evaluate(()=>document.activeElement===window.__ttTerminal.textarea),true);
  await page.evaluate(theme=>window.__ttReceive({config:{cols:120,rows:40,control:false,inputToken:2,theme}}),mobileTerminalTheme(true));
  const before=await page.evaluate(()=>window.inputs.length);
  await page.evaluate(()=>window.__ttReceive({token:2,key:'bad\r',focus:true}));
  assert.equal(await page.evaluate(()=>window.inputs.length),before,'view-only cannot send input or terminal replies');
  await page.setViewportSize({width:390,height:250});
  await page.evaluate(async theme=>{
    const term=window.__ttTerminal;term.reset();
    window.__ttReceive({config:{cols:120,rows:40,control:true,inputToken:3,theme}});
    await new Promise(resolve=>term.write('\x1b[40;1Hbottom prompt> ',resolve));
    window.__ttReceive({focus:true});
  },mobileTerminalTheme(false));
  await page.waitForTimeout(50);
  assert.ok(await page.evaluate(()=>window.__ttTerminal.textarea.getBoundingClientRect().bottom<=innerHeight),'the host bottom-row prompt stays reachable above a short keyboard viewport');
  const wrapping=[];
  for(const buildNumber of [19045,21376]){
    const lines=await page.evaluate(async({buildNumber,theme})=>{
      const term=window.__ttTerminal;term.reset();
      window.__ttReceive({config:{cols:120,rows:40,control:false,inputToken:4,windowsPty:{backend:'conpty',buildNumber},theme}});
      await new Promise(resolve=>term.write('X'.repeat(120)+'\r\nnext',resolve));
      term.resize(121,40);
      return {options:term.options.windowsPty,rows:[0,1].map(i=>term.buffer.active.getLine(i).translateToString(true))};
    },{buildNumber,theme:mobileTerminalTheme(false)});
    assert.equal(lines.options.buildNumber,buildNumber,'xterm uses host compatibility rather than the phone OS');
    wrapping.push(lines.rows);
  }
  assert.deepEqual(wrapping[1],['X'.repeat(120),'next'],'modern bundled ConPTY preserves the explicit full-width line break');
  assert.deepEqual(errors,[]);
  console.log('PASS offline xterm: ANSI/Chinese, host120x40, ten layout toggles, exactly-once chunks, Enter CR, sticky Ctrl, View input denied.');
} finally {await browser.close();}
