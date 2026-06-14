import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Dashboard } from './pages/dashboard.tsx';
import { Project } from './pages/project.tsx';
import { Terminal } from './pages/terminal.tsx';
import { BrandToggle } from './components/brand-toggle.tsx';
import { PendingRestartBanner } from './components/pending-restart-banner.tsx';

function AppShell() {
  const location = useLocation();
  const showBottomBrand = !location.pathname.startsWith('/terminal/');

  return (
    <div className="flex h-dvh flex-col bg-page">
      <nav className="flex h-12 flex-none items-center border-b border-hairline bg-surface px-3 sm:px-6">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 font-display text-[15px] font-semibold tracking-tight text-og-1000"
        >
          <span aria-hidden className="block h-2.5 w-2.5 rounded-full bg-accent" />
          baxian
        </Link>
      </nav>
      <PendingRestartBanner />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:id" element={<Project />} />
          <Route path="/terminal/:agentId" element={<Terminal />} />
        </Routes>
        {showBottomBrand && (
          <footer className="mt-auto flex justify-center pb-4 pt-24">
            <BrandToggle />
          </footer>
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
