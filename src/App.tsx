import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { TauriEventProvider } from './contexts/TauriEventContext';
import AppContent from './components/app/AppContent';
import i18n from './i18n/config.js';
import { useSessionStatusTracker } from './hooks/useSessionStatusTracker';
import { useLiveGridSnapshotSync } from './hooks/useLiveGridSnapshotSync';
import { useAttentionRouter } from './hooks/useAttentionRouter';
import { useAutoExecutor } from './hooks/useAutoExecutor';
import { useWebSocket } from './contexts/TauriEventContext';

function AppInitializer() {
  useSessionStatusTracker();
  useLiveGridSnapshotSync();
  useAttentionRouter();
  const { sendMessage } = useWebSocket();
  useAutoExecutor(sendMessage);
  return null;
}

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <TauriEventProvider>
            <AppInitializer />
            <Router basename={window.__ROUTER_BASENAME__ || ''}>
              <Routes>
                <Route path="/" element={<AppContent />} />
                <Route path="/session/:sessionId" element={<AppContent />} />
              </Routes>
            </Router>
          </TauriEventProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
