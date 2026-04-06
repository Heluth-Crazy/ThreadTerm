import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import AppContent from './components/app/AppContent';
import i18n from './i18n/config.js';
import { useSessionStatusTracker } from './hooks/useSessionStatusTracker';

function AppInitializer() {
  useSessionStatusTracker();
  return null;
}

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <WebSocketProvider>
            <AppInitializer />
            <Router basename={window.__ROUTER_BASENAME__ || ''}>
              <Routes>
                <Route path="/" element={<AppContent />} />
                <Route path="/session/:sessionId" element={<AppContent />} />
              </Routes>
            </Router>
          </WebSocketProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
