import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TasksPage } from './TasksPage';
import './pages.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TasksPage />
  </StrictMode>,
);
