import React, { createContext, useContext, useEffect, useState } from 'react';
import { auth as tauriAuth } from '../lib/tauri-bridge';

const AuthContext = createContext({
  user: { username: 'default-user' },
  token: null,
  login: () => {},
  register: () => {},
  logout: () => {},
  isLoading: false,
  needsSetup: false,
  hasCompletedOnboarding: true,
  refreshOnboardingStatus: () => {},
  error: null,
  isAuthenticated: true
});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState({ username: 'default-user' });
  const [token, setToken] = useState(() => localStorage.getItem('auth_token'));
  const [isLoading, setIsLoading] = useState(false);
  const [needsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Verify existing token on mount
    if (token) {
      tauriAuth.verify(token)
        .then((userInfo) => {
          setUser({ username: userInfo.username, ...userInfo });
          setHasCompletedOnboarding(userInfo.has_completed_onboarding);
        })
        .catch(() => {
          // Token invalid — clear it
          localStorage.removeItem('auth_token');
          setToken(null);
        });
    }
  }, []);

  const refreshOnboardingStatus = async () => {
    if (token) {
      try {
        const userInfo = await tauriAuth.verify(token);
        setHasCompletedOnboarding(userInfo.has_completed_onboarding);
      } catch {
        setHasCompletedOnboarding(true);
      }
    }
  };

  const login = async (username, password) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await tauriAuth.login(username, password);
      setToken(result.token);
      setUser({ username: result.user.username, ...result.user });
      localStorage.setItem('auth_token', result.token);
      return { success: true };
    } catch (err) {
      setError(String(err));
      return { success: false, error: String(err) };
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (username, password) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await tauriAuth.register(username, password);
      setToken(result.token);
      setUser({ username: result.user.username, ...result.user });
      localStorage.setItem('auth_token', result.token);
      return { success: true };
    } catch (err) {
      setError(String(err));
      return { success: false, error: String(err) };
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    if (token) {
      try {
        await tauriAuth.logout(token);
      } catch {
        // Best-effort
      }
    }
    localStorage.removeItem('auth_token');
    setToken(null);
    setUser({ username: 'default-user' });
  };

  const value = {
    user,
    token,
    login,
    register,
    logout,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    refreshOnboardingStatus,
    error,
    isAuthenticated: !!token || user.username === 'default-user'
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
