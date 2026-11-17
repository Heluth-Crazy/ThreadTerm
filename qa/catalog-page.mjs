// Option A (owner 2026-11-17): a sidebar project or branch row folds on click, and its page opens from the row's
// ⋯ menu. Builds before that (and the parity reference) still open the page on a row click; their rows carry no
// aria-expanded, which tells the two apart. A branch with nothing to fold also opens its page on click.

const PAGE_ITEM = /^(打开项目页|打开分支页|Open project page|Open branch page)$/;

/** Opens the page of a `.proj-row` or `.tree-row` locator, the way a person would in this build. */
export async function openCatalogPage(row) {
  // A branch with no sessions sits in its project's "N other branches" fold until that opens.
  if (!(await row.isVisible())) {
    for (const fold of await row.page().locator('.other-fold-row[aria-expanded="false"]').all()) await fold.click();
  }
  await row.waitFor();
  if ((await row.getAttribute('aria-expanded')) === null) return row.click();
  const wrap = row.locator('xpath=..');
  await wrap.hover();
  await wrap.locator('.row-more').click();
  await row.page().locator('.catalogue-popover').getByRole('menuitem', { name: PAGE_ITEM }).click();
}
