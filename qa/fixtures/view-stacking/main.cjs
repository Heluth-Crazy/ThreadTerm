// Which placement of a browser page is actually composited on screen: inside a WebContentsView, or beside it?
const { app, BrowserWindow, View, WebContentsView, desktopCapturer } = require('electron');
const page = color => `data:text/html,<body style="margin:0;background:${color}"></body>`;
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 400, x: 40, y: 40, show: true, backgroundColor: '#000000' });
  const root = new View();
  window.setContentView(root);
  // Left half: page as a CHILD of the app WebContentsView (current remote-view placement).
  const appA = new WebContentsView(); appA.setBounds({ x: 0, y: 0, width: 400, height: 400 }); root.addChildView(appA);
  await appA.webContents.loadURL(page('red'));
  const childA = new WebContentsView(); childA.setBounds({ x: 100, y: 100, width: 200, height: 200 }); appA.addChildView(childA);
  await childA.webContents.loadURL(page('lime'));
  // Right half: page as a SIBLING above the app WebContentsView inside a container (This PC placement).
  const container = new View(); container.setBounds({ x: 400, y: 0, width: 400, height: 400 }); root.addChildView(container);
  const appB = new WebContentsView(); appB.setBounds({ x: 0, y: 0, width: 400, height: 400 }); container.addChildView(appB);
  await appB.webContents.loadURL(page('red'));
  const childB = new WebContentsView(); childB.setBounds({ x: 100, y: 100, width: 200, height: 200 }); container.addChildView(childB);
  await childB.webContents.loadURL(page('lime'));
  // Hide and show both parents, like switching computers.
  if (process.env.TOGGLE !== '0') { appA.setVisible(false); container.setVisible(false); } await new Promise(r => setTimeout(r, 300));
  appA.setVisible(true); container.setVisible(true);
  await new Promise(r => setTimeout(r, 1500));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } });
  const source = sources.find(s => s.id === window.getMediaSourceId()) ?? sources.find(s => s.name === window.getTitle());
  const image = source.thumbnail, size = image.getSize(), bitmap = image.toBitmap();
  const content = window.getContentBounds(), frame = window.getBounds(), scale = size.width / frame.width;
  const at = (x, y) => { const px = Math.round((x + content.x - frame.x) * scale), py = Math.round((y + content.y - frame.y) * scale), i = (py * size.width + px) * 4; return `rgb(${bitmap[i + 2]},${bitmap[i + 1]},${bitmap[i]})`; };
  console.log(JSON.stringify({ size, childInsideWebContentsView: at(200, 200), childBesideInContainer: at(600, 200), appBackgroundLeft: at(30, 30) }));
  app.quit();
});
