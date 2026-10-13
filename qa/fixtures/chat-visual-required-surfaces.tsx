// Supplementary production-ChatView fixture for V1 visual consistency. It does
// not start a provider: the bridge supplies only deterministic, contract-shaped
// snapshots for surfaces that cannot coexist in the ACP tool fixture.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '../../renderer/src/components/ChatView';
import { I18nProvider } from '../../renderer/src/i18n';
import { SessionSurfaceContext } from '../../renderer/src/components/SessionSurfaceContext';
import '../../renderer/src/styles.css';
import { requiredSurfaceItems, requiredSurfaceQueue, requiredSurfaceSession as session } from './chat-visual-required-data';

const connection = { sessionId: session.id, runtimeEpoch: 'fixture', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' };
const bridge = {
  onEvent: () => () => {},
  request: async (method: string) => {
    if (method === 'chat.snapshot') return { items: requiredSurfaceItems, revision: 1, repair: { offered: true, mode: 'rebuild', degraded: true, diagnostic: 'Fixture projection gap.' } };
    if (method === 'chat.draft.read') return { text: '', revision: 1 };
    if (method === 'chat.queue.read') return requiredSurfaceQueue;
    if (method === 'chat.connection' || method === 'chat.connect') return connection;
    if (method === 'chat.options') return { options: [], commands: [], loadState: 'ready' };
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 1 };
    if (method === 'session.release' || method === 'chat.approve' || method === 'chat.answer' || method === 'chat.repair') return null;
    throw new Error(`Unexpected required-surfaces bridge method: ${method}`);
  },
};

declare global { interface Window { threadterm: typeof bridge; qaRequiredSurfaces: { mount: (locale: 'en'|'zh-CN', theme: string) => void } } }
window.threadterm = bridge;
const root = createRoot(document.getElementById('root')!);
window.qaRequiredSurfaces = {
  mount(locale, theme) {
    document.documentElement.dataset.theme = theme === 'custom' ? 'dark' : theme;
    document.documentElement.dataset.customTheme = theme === 'custom' ? 'true' : 'false';
    const custom = theme === 'custom';
    document.documentElement.style.setProperty('--surface', custom ? '#182430' : '');
    document.documentElement.style.setProperty('--bg', custom ? '#0b1016' : '');
    document.documentElement.style.setProperty('--text', custom ? '#f2f6fb' : '');
    document.documentElement.style.setProperty('--primary', custom ? '#ff7a45' : '');
    root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{ primaryHost: null, menuHost: null, focused: true, openFile: () => {}, openDiff: () => {} }}><ChatView session={session} /></SessionSurfaceContext.Provider></I18nProvider>);
  },
};
