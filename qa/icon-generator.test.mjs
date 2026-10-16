import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { iconDomHost } from './lib/icon-dom-host.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createRoot } = require('react-dom/client');
const { flushSync } = require('react-dom');

function loadComponent(source) {
  const module = { exports: {} };
  // Inspect every static entry without changing the generated module on disk.
  const compiled = ts.transpileModule(`${source}\nexport const iconNames=Object.keys(icons); export const brandNames=Object.keys(brands);`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, require });
  return module.exports;
}

test('real icon regeneration preserves the current component and stable SVG props', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'threadterm-icon-generator-'));
  try {
    for (const directory of ['qa', 'reference/prototype', 'renderer/src/components']) {
      await mkdir(join(fixture, directory), { recursive: true });
    }
    for (const path of ['qa/generate-prototype-icons.mjs', 'reference/prototype/app.js']) {
      await copyFile(resolve(path), join(fixture, path));
    }
    const result = spawnSync(process.execPath, [join(fixture, 'qa/generate-prototype-icons.mjs')], {
      cwd: fixture, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const generated = await readFile(join(fixture, 'renderer/src/components/PrototypeIcon.tsx'), 'utf8');
    const current = await readFile(resolve('renderer/src/components/PrototypeIcon.tsx'), 'utf8');
    const icons = loadComponent(generated);
    const baseline = loadComponent(current);
    assert.deepEqual(Object.keys(icons).sort(), Object.keys(baseline).sort(), 'public exports survive regeneration');
    assert.equal(JSON.stringify([...icons.iconNames].sort()), JSON.stringify([...baseline.iconNames].sort()));
    assert.equal(JSON.stringify([...icons.brandNames].sort()), JSON.stringify([...baseline.brandNames].sort()));
    const providers = [
      { id: 'plugin-image', icon: 'data:image/png;base64,AA==' },
      { id: 'plugin-remote', icon: 'https://example.invalid/icon.svg' },
    ];
    const render = (components, name, props) => renderToStaticMarkup(React.createElement(
      components.AgentIconsProvider, { providers }, React.createElement(components[name], props),
    ));
    const samples = [
      ...baseline.iconNames.map(name => ['Icon', { name }]),
      ['Icon', { name: 'settings', className: 'sample', width: 18, 'data-test': 'icon' }],
      ['Icon', { name: 'gear' }], ['Icon', { name: 'missing-icon' }],
      ...[...baseline.brandNames, 'Codex', 'Claude Code', 'Gemini', 'OpenCode', 'Kimi', 'Grok', 'unknown',
        'plugin-image', 'plugin-remote', 'constructor', '__proto__'].flatMap(provider =>
        [undefined, 20].map(size => ['AgentIcon', { provider, size }])),
    ];
    for (const [name, props] of samples) {
      assert.equal(render(icons, name, props), render(baseline, name, props), `${name} ${JSON.stringify(props)}`);
    }
    for (const provider of [...baseline.brandNames, 'unknown', 'constructor', '__proto__']) {
      assert.equal(icons.agentIconMarkup(provider), baseline.agentIconMarkup(provider), `launch markup ${provider}`);
    }
    for (const names of [['settings', 'gear'], ['missing-a', 'missing-b', 'file']]) {
      const values = names.map(name => icons.Icon({ name }).props.dangerouslySetInnerHTML);
      assert.ok(Object.isFrozen(values[0]));
      for (const value of values) assert.equal(value, values[0]);
    }
    // Render a probe inside the real provider so AgentIcon's context hook runs legally.
    const captured = [];
    function Probe() {
      captured.push(icons.AgentIcon({ provider: 'Codex' }).props.dangerouslySetInnerHTML);
      return null;
    }
    for (let index = 0; index < 3; index++) {
      renderToStaticMarkup(React.createElement(icons.AgentIconsProvider, { providers }, React.createElement(Probe)));
    }
    assert.ok(Object.isFrozen(captured[0]));
    for (const value of captured) assert.equal(value, captured[0]);

    for (const [name, props] of [['Icon', { name: 'back' }], ['AgentIcon', { provider: 'Codex' }]]) {
      const host = iconDomHost();
      const previousWindow = globalThis.window, previousDocument = globalThis.document;
      globalThis.window = host.window;
      globalThis.document = host.document;
      const root = createRoot(host.container);
      try {
        const renderDom = extra => flushSync(() => root.render(React.createElement(
          icons.AgentIconsProvider, { providers }, React.createElement(icons[name], { ...props, ...extra }),
        )));
        renderDom({});
        const svg = host.container.firstChild, children = [...svg.childNodes], writes = svg.htmlWrites;
        assert.ok(children.length > 0);
        for (let index = 0; index < 3; index++) {
          renderDom({ className: `render-${index}`, size: 20 + index });
          assert.equal(host.container.firstChild, svg);
          assert.equal(svg.childNodes.length, children.length);
          children.forEach((child, position) => assert.equal(svg.childNodes[position], child,
            `${name}: regenerated component retains the pressed SVG child`));
          assert.equal(svg.htmlWrites, writes, `${name}: regenerated component does not reset innerHTML`);
        }
      } finally {
        flushSync(() => root.unmount());
        await new Promise(resolve => setImmediate(resolve));
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
        if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
