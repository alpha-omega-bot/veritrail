import { App } from './App.tsx';
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import '@cloudscape-design/global-styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
