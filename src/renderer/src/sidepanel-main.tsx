import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SidePanelChrome } from './SidePanelChrome';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SidePanelChrome />
  </StrictMode>,
);
