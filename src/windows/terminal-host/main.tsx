import ReactDOM from 'react-dom/client';
import { TerminalHostApp } from './TerminalHostApp';

const root = document.getElementById('root');
if (!root) throw new Error('[terminal-host] missing #root');

// xterm owns imperative DOM, parser, and listener state that cannot survive
// React development StrictMode's synthetic mount -> dispose -> remount cycle.
ReactDOM.createRoot(root).render(
  <TerminalHostApp />,
);
