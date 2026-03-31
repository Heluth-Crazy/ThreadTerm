import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { theme } from '../utils/electron';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

// Check if running in Electron environment
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

export const ThemeProvider = ({ children }) => {
  // Check for saved theme preference or default to system preference
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // Check localStorage first
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      return savedTheme === 'dark';
    }

    // Check system preference
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    return false;
  });

  // Apply theme to document
  const applyTheme = useCallback((dark) => {
    if (dark) {
      document.documentElement.classList.add('dark');

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', '#0c1117'); // Dark background color (hsl(222.2 84% 4.9%))
      }
    } else {
      document.documentElement.classList.remove('dark');

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', '#ffffff'); // Light background color
      }
    }
  }, []);

  // Update document class and localStorage when theme changes
  useEffect(() => {
    applyTheme(isDarkMode);
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode, applyTheme]);

  // Listen for system theme changes via Electron API
  useEffect(() => {
    // Only use Electron theme API if in Electron environment
    if (!isElectron()) {
      // Fallback to web media query API
      if (!window.matchMedia) return;

      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e) => {
        // Only update if user hasn't manually set a preference
        const savedTheme = localStorage.getItem('theme');
        if (!savedTheme) {
          setIsDarkMode(e.matches);
        }
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    // Use Electron's nativeTheme API
    // Get initial theme from Electron
    theme.getCurrent().then(currentTheme => {
      const savedTheme = localStorage.getItem('theme');
      // Only apply system theme if user hasn't manually set preference
      if (!savedTheme) {
        setIsDarkMode(currentTheme === 'dark');
      }
    });

    // Subscribe to theme changes from main process
    const unsubscribe = theme.onChange((newTheme) => {
      // Only update if user hasn't manually set a preference
      const savedTheme = localStorage.getItem('theme');
      if (!savedTheme) {
        setIsDarkMode(newTheme === 'dark');
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const toggleDarkMode = () => {
    setIsDarkMode(prev => !prev);
  };

  const value = {
    isDarkMode,
    toggleDarkMode,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};