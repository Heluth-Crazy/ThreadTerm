import { createRoot } from 'react-dom/client';
import { IslandApp } from './IslandApp';
import './island-tokens.css';
import './island.css';

createRoot(document.getElementById('island-root')!).render(<IslandApp />);
