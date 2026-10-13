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
