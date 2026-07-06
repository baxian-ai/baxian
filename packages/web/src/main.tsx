import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { AuthGate } from './components/auth-gate.tsx';
import { ToastProvider } from './components/toast.tsx';
import { ConfirmProvider } from './components/confirm-dialog.tsx';
import { PendingRestartProvider } from './hooks/use-pending-restart.tsx';
import { I18nProvider } from './i18n/index.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <PendingRestartProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AuthGate>
              <App />
            </AuthGate>
          </ConfirmProvider>
        </ToastProvider>
      </PendingRestartProvider>
    </I18nProvider>
  </StrictMode>,
);
