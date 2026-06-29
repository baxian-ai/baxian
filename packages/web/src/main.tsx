import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { AuthGate } from './components/auth-gate.tsx';
import { ToastProvider } from './components/toast.tsx';
import { PendingRestartProvider } from './hooks/use-pending-restart.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PendingRestartProvider>
      <ToastProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </ToastProvider>
    </PendingRestartProvider>
  </StrictMode>,
);
