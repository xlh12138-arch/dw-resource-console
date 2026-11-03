import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/toast';
import { AuthProvider } from './lib/auth';
import { DictProvider } from './lib/dict';
import { queryClient } from './lib/query';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DictProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </DictProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
