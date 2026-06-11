import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installMockIfNeeded } from './mock';
import './index.css';

// In a plain browser (vite dev without Electron), provide a mock backend.
installMockIfNeeded();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
