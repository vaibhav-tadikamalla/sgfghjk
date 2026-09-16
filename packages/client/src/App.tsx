import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/lib/auth/AuthContext';
import { LoadingScreen } from '@/components/LoadingScreen';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const LoginPage = lazy(() => import('@/features/auth/LoginPage').then(m => ({ default: m.LoginPage })));
const WorkspacePage = lazy(() => import('@/features/workspace/WorkspacePage').then(m => ({ default: m.WorkspacePage })));
const AdminDashboardPage = lazy(() => import('@/features/admin/AdminDashboardPage'));
const ADMIN_ALLOWED_EMAIL = 'tadikamallavaibhav@gmail.com';
const UI_MODE_KEY = 'peergrid-ui-mode';

type UiMode = 'admin' | 'user';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function isAllowedAdminUser(email: string): boolean {
  return email.toLowerCase() === ADMIN_ALLOWED_EMAIL;
}

function getStoredUiMode(): UiMode | null {
  const mode = window.sessionStorage.getItem(UI_MODE_KEY);
  return mode === 'admin' || mode === 'user' ? mode : null;
}

function setStoredUiMode(mode: UiMode): void {
  window.sessionStorage.setItem(UI_MODE_KEY, mode);
}

function clearStoredUiMode(): void {
  window.sessionStorage.removeItem(UI_MODE_KEY);
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;

  if (!isAllowedAdminUser(user.email)) {
    clearStoredUiMode();
    return <>{children}</>;
  }

  const mode = getStoredUiMode();
  if (!mode) return <Navigate to="/choose-mode" replace />;
  if (mode === 'admin') return <Navigate to="/admin" replace />;

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  const fromPath =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  if (isLoading) return <LoadingScreen />;
  if (user) {
    if (!isAllowedAdminUser(user.email)) {
      clearStoredUiMode();
      return <Navigate to={fromPath} replace />;
    }

    const mode = getStoredUiMode();
    if (!mode) return <Navigate to="/choose-mode" replace />;
    return <Navigate to={mode === 'admin' ? '/admin' : '/'} replace />;
  }

  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isAllowedAdminUser(user.email)) return <Navigate to="/" replace />;

  const mode = getStoredUiMode();
  if (mode !== 'admin') return <Navigate to="/choose-mode" replace />;

  return <>{children}</>;
}

function ChooseModeRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isAllowedAdminUser(user.email)) return <Navigate to="/" replace />;

  const onChoose = (mode: UiMode) => {
    setStoredUiMode(mode);
    navigate(mode === 'admin' ? '/admin' : '/', { replace: true });
  };

  return (
    <div className="min-h-screen bg-surface-0 flex items-center justify-center p-4">
      <div className="glass rounded-2xl p-8 w-full max-w-md">
        <h1 className="text-xl font-semibold text-text-primary">Choose UI Mode</h1>
        <p className="mt-2 text-sm text-text-muted">Select how you want to enter PeerGrid for this session.</p>

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-left hover:bg-surface-3 transition-colors"
            onClick={() => onChoose('admin')}
          >
            <div className="font-medium text-text-primary">Admin UI</div>
            <div className="text-xs text-text-muted mt-1">Open admin dashboard and controls</div>
          </button>
          <button
            type="button"
            className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-left hover:bg-surface-3 transition-colors"
            onClick={() => onChoose('user')}
          >
            <div className="font-medium text-text-primary">User UI</div>
            <div className="text-xs text-text-muted mt-1">Open standard editor workspace</div>
          </button>
        </div>
      </div>
    </div>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicRoute>
              <LoginPage />
            </PublicRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicRoute>
              <LoginPage initialTab="register" />
            </PublicRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <WorkspacePage />
            </ProtectedRoute>
          }
        />
        <Route path="/choose-mode" element={<ChooseModeRoute />} />
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminDashboardPage />
            </AdminRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
