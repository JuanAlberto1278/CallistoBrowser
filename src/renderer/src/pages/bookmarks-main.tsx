import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BookmarksPage } from './BookmarksPage';
import './pages.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BookmarksPage />
  </StrictMode>,
);
