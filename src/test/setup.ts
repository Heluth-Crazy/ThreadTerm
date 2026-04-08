import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock localStorage for zustand persist middleware (happy-dom has incomplete support)
const _store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => _store[key] ?? null,
    setItem: (key: string, value: string) => { _store[key] = value; },
    removeItem: (key: string) => { delete _store[key]; },
    clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
    get length() { return Object.keys(_store).length; },
    key: (i: number) => Object.keys(_store)[i] ?? null,
  },
  writable: true,
});

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
