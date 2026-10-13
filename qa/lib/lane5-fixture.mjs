/** Fixtures acknowledge in a parent passive effect, after child listeners mount.
 * DOM existence alone can refer to the previous React commit. Never OS-focus a
 * QA window to make a selection or keyboard handoff appear to work. */
export async function waitForLane5Fixture(page, selector, revision, width) {
  await page.waitForFunction(({ selector, revision, width }) => {
    const fixture = document.querySelector(selector);
    return fixture?.dataset.qaReady === String(revision) && (width === undefined || window.innerWidth === width);
  }, { selector, revision, width });
}
export async function renderLane5Fixture(page, selector, locale, state) {
  const revision = await page.evaluate(([locale, state]) => window.qaRender(locale, state), [locale, state]);
  await waitForLane5Fixture(page, selector, revision);
}

/** Wait until a content-size change has gone quiet. Selection dismisses on resize,
 * so a late resize event must not arrive after the harness selects text. */
export async function settleContentSize(app, page, width, height = 900) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
  }, { width, height });
  await page.evaluate(target => new Promise(resolve => {
    let last = performance.now();
    const mark = () => { last = performance.now(); };
    window.addEventListener('resize', mark);
    const started = performance.now();
    const check = () => {
      const quiet = performance.now() - last > 200;
      if (window.innerWidth === target && quiet) {
        window.removeEventListener('resize', mark);
        resolve();
        return;
      }
      if (performance.now() - started > 3000) {
        window.removeEventListener('resize', mark);
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  }), width);
}

/** file:// resource timing is empty in this Electron. The esbuild metafile is the
 * proof that Mermaid, KaTeX, and the card chunks are split out of the eager bundle. */
export function assertSplitChunks(metafile, { excludedFromEager, requiredInChunks }) {
  const outputs = Object.entries(metafile?.outputs ?? {});
  const eager = outputs.find(([file]) => /(^|[/\\])qa\.js$/.test(file));
  if (!eager) throw new Error(`eager qa.js missing from esbuild metafile: ${outputs.map(([file]) => file).join(', ')}`);
  const eagerInputs = Object.keys(eager[1].inputs ?? {});
  for (const needle of excludedFromEager) {
    const hit = eagerInputs.find(input => input.replaceAll('\\', '/').includes(needle));
    if (hit) throw new Error(`eager qa.js includes ${needle} via ${hit}`);
  }
  const chunks = outputs.filter(([file]) => /\.js$/.test(file) && !/(^|[/\\])qa\.js$/.test(file));
  const chunkInputs = chunks.flatMap(([, output]) => Object.keys(output.inputs ?? {}));
  if (chunks.length === 0) throw new Error('esbuild emitted no split JS chunk');
  for (const needle of requiredInChunks) {
    if (!chunkInputs.some(input => input.replaceAll('\\', '/').includes(needle))) {
      throw new Error(`no split chunk includes ${needle}`);
    }
  }
  return chunks.map(([file]) => file.split(/[/\\]/).pop());
}
