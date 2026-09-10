import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled, not system-resolved: a packaged desktop build cannot assume either
// face is installed.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App';
import './index.css';
import { TitleBar } from './TitleBar';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <TitleBar title="Tether" />
    <App />
  </StrictMode>,
);
