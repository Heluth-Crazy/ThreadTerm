import { describe, expect, it } from 'vitest';
import {
  buildPreviewFrame,
  dirnameOf,
  joinWorkspacePath,
  type PreviewContext,
  type PreviewFrame,
} from './WorkspaceCodeEditor';

const tauriCtx: PreviewContext = {
  tauri: true,
  fileSrc: (absPath) => `asset://${absPath}`,
};

const browserCtx: PreviewContext = {
  tauri: false,
  fileSrc: (absPath) => absPath,
};

function expectIframeFrame(frame: PreviewFrame): Extract<PreviewFrame, { kind: 'iframe' }> {
  expect(frame.kind).toBe('iframe');
  if (frame.kind !== 'iframe') throw new Error(`expected iframe frame, received ${frame.kind}`);
  return frame;
}

function expectServiceRequiredFrame(
  frame: PreviewFrame,
): Extract<PreviewFrame, { kind: 'service-required' }> {
  expect(frame.kind).toBe('service-required');
  if (frame.kind !== 'service-required') {
    throw new Error(`expected service-required frame, received ${frame.kind}`);
  }
  return frame;
}

describe('buildPreviewFrame', () => {
  it('serves saved HTML files through the asset protocol inside Tauri', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame(
        '<html><body>draft</body></html>',
        'html',
        '/repo/docs/page.html',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame).toEqual({
      kind: 'iframe',
      src: 'asset:///repo/docs/page.html',
      sandbox: 'allow-scripts allow-popups',
    });
  });

  it('shows a service-required state for Vite-style HTML instead of a blank iframe', () => {
    const frame = expectServiceRequiredFrame(
      buildPreviewFrame(
        '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
        'html',
        '/repo/index.html',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame.requirement).toEqual({
      kind: 'workspace-source',
      path: '/src/main.tsx',
    });
    expect(frame).not.toHaveProperty('src');
    expect(frame).not.toHaveProperty('srcDoc');
  });

  it('shows a service-required state for root-absolute HTML resources', () => {
    const frame = expectServiceRequiredFrame(
      buildPreviewFrame(
        '<html><head><link rel="stylesheet" href="/assets/app.css"></head></html>',
        'html',
        '/repo/docs/page.html',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame.requirement).toEqual({
      kind: 'root-absolute-resource',
      path: '/assets/app.css',
    });
  });

  it('detects inline module imports that need a project service', () => {
    const frame = expectServiceRequiredFrame(
      buildPreviewFrame(
        '<script type="module">import app from "/src/app.ts";</script>',
        'html',
        '/repo/docs/page.html',
        '/repo',
        browserCtx,
      ),
    );

    expect(frame.requirement).toEqual({
      kind: 'workspace-source',
      path: '/src/app.ts',
    });
  });

  it('falls back to inline HTML with an injected base URL outside Tauri', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame(
        '<html><head><title>Page</title></head><body><img src="./asset.png"></body></html>',
        'html',
        '/outside/page.html',
        undefined,
        browserCtx,
      ),
    );

    expect(frame.src).toBeUndefined();
    expect(frame.sandbox).toBe('allow-scripts allow-popups');
    expect(frame.srcDoc).toContain(`<head><base href="${document.baseURI}">`);
  });

  it('renders markdown into srcdoc without allow-scripts in the sandbox', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame('# Title', 'markdown', '/repo/readme.md', '/repo', tauriCtx),
    );

    expect(frame.src).toBeUndefined();
    expect(frame.sandbox).toBe('allow-popups');
    expect(frame.sandbox).not.toContain('allow-scripts');
    expect(frame.srcDoc).toContain('<h1>Title</h1>');
  });

  it('rewrites relative markdown images through fileSrc inside Tauri', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame(
        '![a](./img.png)\n\n![b](../up.png)\n\n![c](https://x/y.png)',
        'markdown',
        '/repo/docs/readme.md',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame.srcDoc).toContain('<img src="asset:///repo/docs/img.png" alt="a">');
    expect(frame.srcDoc).toContain('<img src="asset:///repo/up.png" alt="b">');
    expect(frame.srcDoc).toContain('<img src="https://x/y.png" alt="c">');
  });

  it('keeps images that escape the workspace root untouched', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame(
        '![out](../../other-repo/secret.png)',
        'markdown',
        '/repo/docs/readme.md',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame.srcDoc).toContain('<img src="../../other-repo/secret.png" alt="out">');
    expect(frame.srcDoc).not.toContain('asset://');
  });

  it('keeps relative markdown images untouched without a workspace root', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame('![a](./img.png)', 'markdown', '/repo/docs/readme.md', undefined, tauriCtx),
    );

    expect(frame.srcDoc).toContain('<img src="./img.png" alt="a">');
  });

  it('keeps relative markdown images untouched outside Tauri', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame('![a](./img.png)', 'markdown', '/repo/docs/readme.md', '/repo', browserCtx),
    );

    expect(frame.srcDoc).toContain('<img src="./img.png" alt="a">');
  });

  it('opens external markdown links in a new window with rel protection', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame(
        '[ext](https://example.com/page) and [frag](#section)',
        'markdown',
        '/repo/readme.md',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame.srcDoc).toContain(
      '<a href="https://example.com/page" target="_blank" rel="noopener noreferrer">ext</a>',
    );
    expect(frame.srcDoc).toContain('<a href="#section">frag</a>');
  });

  it('highlights fenced code blocks with hljs classes', () => {
    const frame = expectIframeFrame(
      buildPreviewFrame(
        '```ts\nconst x: number = 1;\n```',
        'markdown',
        '/repo/readme.md',
        '/repo',
        tauriCtx,
      ),
    );

    expect(frame.srcDoc).toContain('class="hljs language-ts"');
    expect(frame.srcDoc).toContain('hljs-keyword');
  });
});

describe('dirnameOf', () => {
  it('returns the directory portion with backslashes normalized', () => {
    expect(dirnameOf('/repo/docs/readme.md')).toBe('/repo/docs');
    expect(dirnameOf('C:\\repo\\docs\\readme.md')).toBe('C:/repo/docs');
  });

  it('handles paths without a directory', () => {
    expect(dirnameOf('readme.md')).toBe('');
    expect(dirnameOf('/readme.md')).toBe('/');
  });
});

describe('joinWorkspacePath', () => {
  it('resolves ./ and nested segments', () => {
    expect(joinWorkspacePath('/repo/docs', './img/pic.png')).toBe('/repo/docs/img/pic.png');
  });

  it('clamps ../ chains at the filesystem root', () => {
    expect(joinWorkspacePath('/repo/docs', '../../../pic.png')).toBe('/pic.png');
  });

  it('normalizes Windows separators in the relative part', () => {
    expect(joinWorkspacePath('C:/root/docs', '.\\win\\path.png')).toBe('C:/root/docs/win/path.png');
  });

  it('does not escape a Windows drive root', () => {
    expect(joinWorkspacePath('C:/root', '../../pic.png')).toBe('C:/pic.png');
  });
});
