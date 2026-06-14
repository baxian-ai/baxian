import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { AuthGate } from './components/auth-gate.tsx';
import { ToastProvider } from './components/toast.tsx';
import { TaskDetailProvider } from './components/task-detail-modal.tsx';
import { PendingRestartProvider } from './hooks/use-pending-restart.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PendingRestartProvider>
      <ToastProvider>
        <AuthGate>
          <TaskDetailProvider>
            <App />
          </TaskDetailProvider>
        </AuthGate>
      </ToastProvider>
    </PendingRestartProvider>
  </StrictMode>,
);
