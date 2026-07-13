import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { ToastProvider } from '@/components/feedback/ToastProvider';
import ErrorBoundary from '@/components/ErrorBoundary';
import DiagnosticsPanel from '@/components/diagnostics/DiagnosticsPanel';
import RouteBreadcrumbs from '@/components/diagnostics/RouteBreadcrumbs';
import Layout from '@/components/layout/Layout';
import LoginPage from '@/pages/LoginPage';
import ReportsPage from '@/pages/ReportsPage';
import SystemConfigurationPage from '@/pages/SystemConfigurationPage';
import GeneratedTestCasesPage from '@/pages/GeneratedTestCasesPage';
import UserManagementPage from '@/pages/UserManagementPage';
import BugTrackerPage from '@/pages/BugTrackerPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      {/* Public routes — no landing page; go straight to login (or chat if signed in) */}
      <Route path="/" element={<Navigate to={isAuthenticated ? '/chat' : '/login'} replace />} />
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/chat" replace /> : <LoginPage />}
      />

      {/* Protected routes with sidebar layout */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* /chat is rendered persistently inside Layout to preserve running flows */}
        <Route path="/chat" element={null} />
        <Route path="/generated-tests" element={<GeneratedTestCasesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/bug-tracker" element={<BugTrackerPage />} />
        <Route path="/user-management" element={<UserManagementPage />} />
        <Route path="/system-configuration" element={<SystemConfigurationPage />} />
        {/* Backward-compat redirects */}
        <Route path="/configurations" element={<Navigate to="/system-configuration" replace />} />
        <Route path="/settings" element={<Navigate to="/system-configuration" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <RouteBreadcrumbs />
            <AppRoutes />
            <DiagnosticsPanel />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
