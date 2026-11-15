// The browser toolbar keeps Back, Reload, the address, Design Mode, Agent access and Page console. Forward, Screenshot
// to Chat, Find in page, Developer tools and Open in browser are in its "More page actions" menu, and Read/Control/Off
// are in the "Agent access" dropdown (Design Mode, ad4730d). Probes reach any of them by its old name through these
// helpers, which also accept the earlier one-button-per-action toolbar.

const AGENT = /^Agent access (Off|Read|Control)$/;

function trigger(scope, name) {
 return scope.getByRole('button', { name: AGENT.test(name) ? 'Agent access' : 'More page actions', exact: true });
}

/** Opens the menu holding `name` and returns its item; the caller clicks it or reads it, then closes the menu. */
async function openItem(page, scope, name) {
 await trigger(scope, name).first().click();
 const item = page.getByRole('menuitem', { name, exact: true });
 await item.waitFor();
 return item;
}

/** Clicks a page action by name, from the toolbar when it is a button there, else from its menu. */
export async function clickPageAction(page, scope, name) {
 const direct = scope.getByRole('button', { name, exact: true });
 if (await direct.count()) return direct.first().click();
 await (await openItem(page, scope, name)).click();
}

/** Whether a page action is disabled, read without running it. */
export async function pageActionDisabled(page, scope, name) {
 const direct = scope.getByRole('button', { name, exact: true });
 if (await direct.count()) return direct.first().isDisabled();
 const item = await openItem(page, scope, name);
 const disabled = (await item.getAttribute('aria-disabled')) === 'true';
 await page.keyboard.press('Escape');
 await item.waitFor({ state: 'detached' });
 return disabled;
}

/** The agent access level shown by the toolbar: 'off', 'read' or 'control'. */
export async function agentAccessLevel(scope) {
 const pressed = scope.locator('[aria-label^="Agent access "][aria-pressed="true"]');
 if (await pressed.count()) return (await pressed.first().getAttribute('aria-label')).slice('Agent access '.length).toLowerCase();
 const text = (await trigger(scope, 'Agent access Off').first().innerText()).trim();
 return /Control|控制/.test(text) ? 'control' : /Read|读取/.test(text) ? 'read' : 'off';
}
