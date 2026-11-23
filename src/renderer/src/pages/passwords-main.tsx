import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PasswordsPage } from './PasswordsPage';
import './pages.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PasswordsPage />
  </StrictMode>,
);
