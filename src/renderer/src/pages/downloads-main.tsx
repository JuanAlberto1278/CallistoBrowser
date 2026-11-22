import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DownloadsPage } from './DownloadsPage';
import './pages.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DownloadsPage />
  </StrictMode>,
);
