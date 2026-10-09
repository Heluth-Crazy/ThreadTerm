// Packaged Windows icon acceptance QA. Usage:
//   node qa/app-icon.mjs release/win-unpacked/ThreadTerm.exe
// It launches only on Desktop 1 via qa/lib/desktop1.mjs and never changes the
// user's icon cache, registry, taskbar, profile, or provider configuration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { electron } from './lib/desktop1.mjs';

const executable = process.argv[2] ? resolve(process.argv[2]) : undefined;
assert.ok(executable && existsSync(executable), 'usage: node qa/app-icon.mjs <packaged ThreadTerm.exe>');
assert.equal(basename(executable).toLowerCase(), 'threadterm.exe', 'refuse a non-ThreadTerm executable');
const referenceIcon = join(resolve('desktop/assets'), 'threadterm.png');
assert.ok(existsSync(referenceIcon), `missing source icon reference: ${referenceIcon}`);
const output = join(resolve('qa/results/app-icon'), 'package');
const scratch = await mkdtemp(join(tmpdir(), 'tt-app-icon-'));
const probeScript = join(scratch, 'icon-probe.ps1');
const report = { executable, scratch, passed: false, checks: [], images: [], errors: [], limitations: ['The Windows shell and live BrowserWindow icon are inspected without clearing icon caches or touching user registry/taskbar state.'] };
let app;
let page;

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const probeSource = String.raw`
param([Parameter(Mandatory=$true)][string]$Exe,[Parameter(Mandatory=$true)][string]$Reference,[Parameter(Mandatory=$true)][string]$Output,[string]$Hwnd='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IconNative {
  public delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@
function Count-Resource([IntPtr]$Module,[int]$Type) {
  $script:resourceCount=0
  $callback=[IconNative+EnumResNameProc]{ param($m,$t,$n,$p) $script:resourceCount++; return $true }
  if(-not [IconNative]::EnumResourceNames($Module,[IntPtr]$Type,$callback,[IntPtr]::Zero)){ throw "EnumResourceNames failed for type $Type" }
  return $script:resourceCount
}
$module=[IconNative]::LoadLibraryEx($Exe,[IntPtr]::Zero,2)
if($module -eq [IntPtr]::Zero){ throw "LoadLibraryEx failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try { $groups=Count-Resource $module 14; $icons=Count-Resource $module 3 } finally { [void][IconNative]::FreeLibrary($module) }
if($groups -lt 1 -or $icons -lt 1){ throw "missing PE icon resources: groups=$groups icons=$icons" }
$shell=[Drawing.Icon]::ExtractAssociatedIcon($Exe)
if($null -eq $shell){ throw 'Windows shell did not extract an associated icon' }
$referenceBitmap=[Drawing.Bitmap]::FromFile($Reference)
$window=$null
if($Hwnd){
  $handle=[IntPtr]([Int64]$Hwnd)
  foreach($which in 1,0,2){ $raw=[IconNative]::SendMessage($handle,0x007F,[IntPtr]$which,[IntPtr]::Zero); if($raw -ne [IntPtr]::Zero){ $window=[Drawing.Icon]::FromHandle($raw); break } }
}
$width=1200; $height=390
$sheet=New-Object Drawing.Bitmap $width,$height
$graphics=[Drawing.Graphics]::FromImage($sheet)
function Similarity($left,$right) {
  $a=New-Object Drawing.Bitmap 64,64; $b=New-Object Drawing.Bitmap 64,64
  $ga=[Drawing.Graphics]::FromImage($a);$gb=[Drawing.Graphics]::FromImage($b)
  try {
    $ga.Clear([Drawing.Color]::White);$gb.Clear([Drawing.Color]::White)
    $ga.DrawImage($left,[Drawing.Rectangle]::new(0,0,64,64));$gb.DrawImage($right,[Drawing.Rectangle]::new(0,0,64,64))
    [double]$difference=0
    for($y=0;$y -lt 64;$y++){for($x=0;$x -lt 64;$x++){$p=$a.GetPixel($x,$y);$q=$b.GetPixel($x,$y);$difference+=[Math]::Abs($p.R-$q.R)+[Math]::Abs($p.G-$q.G)+[Math]::Abs($p.B-$q.B)}}
    return 1-($difference/(64*64*255*3))
  } finally {$ga.Dispose();$gb.Dispose();$a.Dispose();$b.Dispose()}
}
$shellBitmap=$shell.ToBitmap();$windowBitmap=if($window){$window.ToBitmap()}else{$null}
$shellSimilarity=Similarity $referenceBitmap $shellBitmap
$windowSimilarity=if($windowBitmap){Similarity $referenceBitmap $windowBitmap}else{$null}
try {
  $graphics.Clear([Drawing.Color]::White)
  $font=New-Object Drawing.Font -ArgumentList @('Segoe UI',12)
  $bold=New-Object Drawing.Font -ArgumentList @('Segoe UI',14,[Drawing.FontStyle]::Bold)
  $graphics.DrawString('ThreadTerm packaged icon - source, Shell and live BrowserWindow',[Drawing.Font]$bold,[Drawing.Brushes]::Black,16,10)
  $columns=@(@{x=70;title='Reference PNG (shown at 256 px)'},@{x=455;title='Windows Shell associated icon (scaled to 256 px)'},@{x=840;title='BrowserWindow WM_GETICON (scaled to 256 px)'})
  for($index=0;$index -lt $columns.Count;$index++){
    $column=$columns[$index];$x=[int]$column.x
    $graphics.DrawString($column.title,[Drawing.Font]$font,[Drawing.Brushes]::Black,$x,48)
    if($index -eq 0){$graphics.DrawImage($referenceBitmap,[Drawing.Rectangle]::new($x,76,256,256))}
    elseif($index -eq 1){$graphics.DrawIcon($shell,[Drawing.Rectangle]::new($x,76,256,256))}
    elseif($window){$graphics.DrawIcon($window,[Drawing.Rectangle]::new($x,76,256,256))}
  }
  $graphics.DrawString('Comparison uses normalized 64 px RGB similarity; the large views are visual evidence and do not claim Shell native-frame size.',[Drawing.Font]$font,[Drawing.Brushes]::Black,16,350)
  $sheet.Save((Join-Path $Output 'icon-contact-sheet.png'),[Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose();$sheet.Dispose();$shellBitmap.Dispose();if($windowBitmap){$windowBitmap.Dispose()};$referenceBitmap.Dispose();$shell.Dispose();if($window){$window.Dispose()} }
[pscustomobject]@{groupIcons=$groups;icons=$icons;shell=$true;windowIcon=($null -ne $window);shellSimilarity=$shellSimilarity;windowSimilarity=$windowSimilarity} | ConvertTo-Json -Compress
`;
await mkdir(output, { recursive: true });
// Windows PowerShell 5 reads UTF-8 without a BOM as the local ANSI codepage.
await writeFile(probeScript, `\ufeff${probeSource}`, 'utf8');
function runProbe(handle) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript, '-Exe', executable, '-Reference', referenceIcon, '-Output', output, '-Hwnd', handle ?? ''], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectProbe);
    child.once('exit', code => code === 0 ? resolveProbe(JSON.parse(stdout.trim())) : rejectProbe(Error(`icon probe failed (${code}): ${stderr || stdout}`)));
  });
}
function isolatedEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url'].includes(key.toLowerCase())));
  return Object.assign(env, {
    PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-app-icon-${randomUUID()}`,
  });
}
try {
  const pe = await runProbe();
  assert.ok(pe.groupIcons > 0 && pe.icons > 0 && pe.shell, 'packaged EXE contains shell-readable group/icon resources');
  assert.ok(pe.shellSimilarity > 0.75, `Shell icon differs from source asset (${pe.shellSimilarity})`);
  report.checks.push(`PE has ${pe.groupIcons} RT_GROUP_ICON and ${pe.icons} RT_ICON resources; Windows Shell extracted the custom icon`);
  app = await electron.launch({ executablePath: executable, args: [], env: isolatedEnv(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 20_000 });
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const handle = window.getNativeWindowHandle();
    return { packaged: app.isPackaged, handle: handle.readBigUInt64LE().toString(), visible: window.isVisible() };
  });
  assert.equal(identity.packaged, true);
  assert.equal(identity.visible, true);
  const live = await runProbe(identity.handle);
  assert.equal(live.windowIcon, true, 'BrowserWindow exposes a live WM_GETICON handle');
  assert.ok(live.windowSimilarity > 0.75, `BrowserWindow icon differs from source asset (${live.windowSimilarity})`);
  report.checks.push('packaged BrowserWindow has a live custom window/taskbar icon; source configuration sets the packaged AppUserModelId to com.threadterm.v3 (unpackaged Win32 has no package-identity API for an independent native readback)');
  const snapshot = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
  await page.evaluate(({ revision }) => window.threadterm.request('settings.update', { patch: { notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: revision, operationId: crypto.randomUUID() }), { revision: snapshot.settings.revision });
  await page.screenshot({ path: join(output, 'packaged-window.png'), animations: 'disabled' });
  report.images.push('icon-contact-sheet.png', 'packaged-window.png');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? 'APP ICON QA PASSED' : `APP ICON QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
