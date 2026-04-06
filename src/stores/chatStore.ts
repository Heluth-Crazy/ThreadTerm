import { create } from 'zustand';
import type { SessionProvider } from '../types/app';

type ChatPhase = 'idle' | 'thinking' | 'tool' | 'writing' | 'done';

interface ChatSession {
  id: string;
  projectPath: string;
  provider: SessionProvider;
  model: string;
  createdAt: number;
}

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  phase: ChatPhase;
  isSending: boolean;

  setActiveSession: (id: string | null) => void;
  addSession: (session: ChatSession) => void;
  removeSession: (id: string) => void;
  clearSessions: () => void;
  setPhase: (phase: ChatPhase) => void;
  setIsSending: (sending: boolean) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  sessions: [],
  activeSessionId: null,
  phase: 'idle',
  isSending: false,

  setActiveSession: (id) => set({ activeSessionId: id }),
  addSession: (session) =>
    set((state) => ({ sessions: [...state.sessions, session] })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId:
        state.activeSessionId === id ? null : state.activeSessionId,
    })),
  clearSessions: () => set({ sessions: [], activeSessionId: null }),
  setPhase: (phase) => set({ phase }),
  setIsSending: (sending) => set({ isSending: sending }),
}));
