import {_electron as electron} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// A visible, user-owned preview. The controller observes it until the user exits;
// it never resets its runtime data or automatically closes the application.
const metadataPath='qa/results/active-parity-preview.json';
const meta=JSON.parse(await readFile(metadataPath,'utf8'));
const profile=join(meta.root,'verified-profile-'+Date.now());
await mkdir(profile,{recursive:true});
const env={...process.env,THREADTERM_V3_DATA:meta.data,THREADTERM_V3_PIPE:meta.pipe,THREADTERM_V3_USER_DATA:profile};
delete env.THREADTERM_V3_RUNTIME;delete env.THREADTERM_V3_DEV_SERVER_URL;
const app=await electron.launch({executablePath:meta.executable,args:[],env,timeout:45000});
const page=await app.firstWindow();
await page.locator('.app-shell').waitFor();
const project=page.getByTitle(meta.project.path,{exact:true}).and(page.locator('.proj-row')).first();
await project.waitFor();await project.click();
await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setTitle('ThreadTerm · 原型对齐预览');window.show();window.focus();});
meta.previousPreviewPid=meta.pid;meta.launcherPid=app.process().pid;meta.pid=await app.evaluate(()=>process.pid);meta.profile=profile;
meta.styles=await page.evaluate(()=>({stylesheets:[...document.styleSheets].map(sheet=>({href:sheet.href,rules:sheet.cssRules.length})),shellDisplay:getComputedStyle(document.querySelector('.app-shell')).display,sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width}));
meta.window=await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];return {visible:window.isVisible(),title:window.getTitle(),bounds:window.getBounds()};});
meta.verifiedAt=new Date().toISOString();meta.screenshot=join(meta.root,'visible-preview.png');
await page.screenshot({path:meta.screenshot});
await writeFile(metadataPath,JSON.stringify(meta,null,2));
console.log(JSON.stringify({pid:meta.pid,window:meta.window,styles:meta.styles,screenshot:meta.screenshot}));
await new Promise(resolve=>app.process().once('exit',resolve));
