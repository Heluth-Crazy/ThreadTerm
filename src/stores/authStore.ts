import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthUser {
  username: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  setUser: (user: AuthUser | null) => void;
  setToken: (token: string | null) => void;
  setHasCompletedOnboarding: (completed: boolean) => void;
  setError: (error: string | null) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      hasCompletedOnboarding: false,
      error: null,
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      setToken: (token) => set({ token }),
      setHasCompletedOnboarding: (completed) =>
        set({ hasCompletedOnboarding: completed }),
      setError: (error) => set({ error }),
      logout: () =>
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          error: null,
        }),
    }),
    { name: 'openwork-auth' }
  )
);
