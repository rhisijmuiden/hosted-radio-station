import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../i18n';
import '../styles.css';
import { TabletApp } from './TabletApp';

// The tablet panel: served by RHIS Studio on the studio network (src-tauri/src/panel.rs).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TabletApp />
  </StrictMode>,
);
