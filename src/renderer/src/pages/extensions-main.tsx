import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ExtensionsPage } from './ExtensionsPage';
import './pages.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExtensionsPage />
  </StrictMode>,
);
