import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

// Self-hosted. Google Fonts would put a request to a third party on the first
// paint of a page whose entire argument is that data stays where it is.
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/index.css';

import { App } from './App';
import { startAnalytics } from './lib/analytics';
import { AuthProvider } from './lib/auth/AuthProvider';

// Wires consent changes to vendor activation. No vendor loads from this call —
// it only subscribes. See lib/analytics/index.ts.
startAnalytics();

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element in index.html.');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
