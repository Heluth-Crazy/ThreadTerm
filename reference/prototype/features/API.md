# ThreadTerm prototype extension API

`app.js` exposes `window.ThreadTermPrototype` before any feature script loads.
Feature scripts are classic, local scripts. They must use this API rather than
replacing the root shell or adding another document-level click delegate.

## Stable references and helpers

`store`, `ui`, `projects`, and `trees` are live mutable references. Call
`save()` after durable `store` changes and `render()` after a visible change.
The v3 persistence key is `threadterm.app.v3`; it is independent from v1.

```js
const tt = window.ThreadTermPrototype;
tt.sessions();                    // fresh array of seed + user sessions
tt.sessionById(id);               // session object or undefined
tt.displayName(item);             // current alias-aware name
tt.stateOf(item);                 // needs | running | failed | ended | stalled
tt.isEnded(item);
tt.isMissing(item);
tt.isUnavailable(item);
tt.fileKey(item, fileIndex);      // stable mock document key
tt.fileValue(item, fileIndex);    // saved value, draft value, or fixture
```

`store` owns durable core data. `ui` is intentionally transient: navigation,
workspace tabs, drafts, terminal input, splits, float state, and pending preset
commands. Do not replace either object.

## Rendering and overlays

```js
tt.save();
tt.render();
tt.navigate('#/inbox');
tt.setTheme('light' | 'dark');
tt.openSession(sessionId);
tt.openDialog(title, subtitle, bodyHtml, footerHtml = '', options = {}); // HTMLElement
tt.closeDialog(restoreFocus = true);
tt.openPopover(anchorElement, html, options = {}); // HTMLElement
tt.closePopover();
tt.toast(message);
tt.publishAttention({ session, kind, title, reason, identity });
tt.esc(value);                    // HTML escape
tt.icon(name, className = 'ico'); // SVG HTML string
tt.btn(labelHtml, action, attrs = {}, className = 'btn btn-ghost');
```

`openDialog` options support `invoker`, `wide`, and `palette`; `openPopover`
options support `width`, `align: 'right'`, and `cls`. HTML passed to these
methods must be escaped with `tt.esc()` when it contains dynamic text.

`publishAttention` adds a durable event to the existing inbox and notification
popover. `kind` is one of `approval`, `waiting`, `failed`, `review`, or
`stalled`; `identity` de-duplicates a session event. Reading a notification
only marks it read. Resolving it uses the existing resolve flow and never
approves a tool request or executes a command.

The legacy app replaces `#app` on renders. Preserve an editor instance or DOM
state with hooks:

```js
const disposeBefore = tt.onBeforeRender(({ ui }) => saveEditorDraft(ui));
const disposeAfter = tt.onRender(({ app, route, ui }) => mountOrRestore(app, route, ui));
disposeBefore(); disposeAfter();
```

Callbacks run synchronously once for each root render; failures are isolated
and logged. Hook registration does not render automatically. Hooks must not
call `render()` unconditionally, or they will recurse.

`render()` may defer the structural update while an input or contenteditable
element inside `#app` has an active composition. The host coalesces pending
renders and schedules one animation-frame update after `compositionend`,
focus loss, or window blur so the final browser input transaction can finish.
The eventual hooks receive the latest route and state; they do not run for
each deferred request. Feature code must not bypass this fence by replacing
`#app` itself. Streaming token updates should touch only their message nodes.

The editor extension retains each document's CodeMirror state, undo history,
selection and scroll before a structural render. Focus is restored only when
the editor owned it and another input or overlay has not acquired it. Compose
and save handlers must use the live document record rather than a copied draft.

`onReset(callback)` registers cleanup that runs before `resetPrototype()`
clears only `threadterm.app.v3` and reloads. Register timer/editor cleanup here.
The reset clears additive feature state and transient drafts through the reload;
it never clears `threadterm.app.v1` or writes to a real project.

## Actions and menus

`baseActions` is an immutable snapshot of core action handlers. Add unique
action names with `registerActions`; it returns a disposer and refuses to
overwrite a core or previously registered action.

```js
const removeActions = tt.registerActions({
  'settings-open': (el, event) => { /* data-action delegate */ },
});
```

`extendMenu(kind, callback)` appends returned HTML to an existing menu and
returns a disposer. Supported kinds are `project`, `tree`, `session`,
`settings`, `scenario`, and `notification`. The callback receives an identity
context: project/tree/session menus include `anchor` and their object plus id;
notification includes `anchor` and `items`; settings/scenario include `anchor`.
Return a string (normally buttons using `data-action`) or `{ html }`.

## Session creator

`registerCreator(callback)` installs the single mode-aware creation surface
used by every existing core path: new-terminal buttons, composer, command
palette, and `Ctrl/Cmd+Alt+N`. Its callback receives
`{ invoker, preferredTree, preferredProject, preferredAgent, preferredName }`
and should open its dialog. It returns a disposer; the core legacy dialog is
used until a creator is registered. Only one creator may be registered.

## Session terminator

`registerTerminator(callback)` installs the single end-session surface used by
every core `data-action="end-session"` entry. Its callback receives
`{ sessionId, invoker }` and should open its own confirmation/failure dialog.
It returns a disposer and refuses a second registration. Until registered, core
uses its existing `openEndSession` confirmation and `end-session-confirm`
fallback unchanged.

## Workspace slots

`registerContentSlot(kind, callback)` replaces the legacy workspace content
only when the callback returns an HTML string. Supported kinds are `file`,
`diff`, and `terminal`; multiple callbacks compose last-registered-first, and
`null` leaves the core content intact.

```js
tt.registerContentSlot('file', ({ item, path, fileIndex, tab, ui, value, draft }) =>
  `<section data-tt-feature-mounted="editor" data-path="${tt.esc(path)}"></section>`
);
```

The context includes `item`, `project`, `tree`, `path`, `fileIndex`, `tab`,
live `ui`, `value`, and `draft`. Use `onRender` to mount a CodeMirror instance
inside the returned element. Retain any dirty editor state before root renders.

## Durable feature state

```js
const settings = tt.featureState('settings', { appearance: { theme: 'light' } });
settings.appearance.theme = 'dark';
tt.save();
```

`featureState(name, defaults = {})` returns a live, persisted object under
`store.featureStates[name]`, creating it from a deep copy of defaults and
adding missing top-level default keys on later upgrades. Names are identifiers
made of letters, digits, and hyphens. Feature state is retained across reloads
and core upgrades, but reset flows may intentionally clear it.

## Boundaries

All data and actions remain synthetic. Do not perform network, CLI, filesystem,
or native-window operations. Preserve the existing route structure, root shell,
and global document handlers.
