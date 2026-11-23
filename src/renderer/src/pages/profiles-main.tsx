import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfilesPage } from './ProfilesPage';
import './pages.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProfilesPage />
  </StrictMode>,
);
