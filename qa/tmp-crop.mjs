import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [src, out, x, y, w, h, scale = '4'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: 'C:/Users/demo/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe' });
const p = await b.newPage({ viewport: { width: Number(w) * Number(scale), height: Number(h) * Number(scale) } });
const data = readFileSync(src).toString('base64');
await p.setContent(`<body style="margin:0"><div style="width:${w * scale}px;height:${h * scale}px;background:url(data:image/png;base64,${data}) -${x * scale}px -${y * scale}px / auto no-repeat;image-rendering:pixelated;background-size:${'IMGW'}"></div></body>`.replace("'IMGW'", ''));
await p.evaluate(async ({ data, x, y, w, h, scale }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
  const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale; const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, w * scale, h * scale); document.body.innerHTML = ''; document.body.appendChild(c);
}, { data, x: Number(x), y: Number(y), w: Number(w), h: Number(h), scale: Number(scale) });
await p.screenshot({ path: out }); await b.close();
