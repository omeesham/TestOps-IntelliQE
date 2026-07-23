import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { FeatureToggleProvider, useFeature } from '@/contexts/FeatureToggleContext';
import { ToastProvider } from '@/components/feedback/ToastProvider';
import ErrorBoundary from '@/components/ErrorBoundary';
import DiagnosticsPanel from '@/components/diagnostics/DiagnosticsPanel';
import RouteBreadcrumbs from '@/components/diagnostics/RouteBreadcrumbs';
import FeatureUnavailable from '@/components/FeatureUnavailable';
import Layout from '@/components/layout/Layout';
import LoginPage from '@/pages/LoginPage';
import ReportsPage from '@/pages/ReportsPage';
import SystemConfigurationPage from '@/pages/SystemConfigurationPage';
import GeneratedTestCasesPage from '@/pages/GeneratedTestCasesPage';
import UserManagementPage from '@/pages/UserManagementPage';
import BugTrackerPage from '@/pages/BugTrackerPage';
import FeatureTogglesPage from '@/pages/FeatureTogglesPage';
import AgentPerformancePage from '@/pages/AgentPerformancePage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Gate a route behind a feature toggle for the current role. When disabled,
 * shows a friendly "unavailable" panel instead of the page (no redirect loop).
 */
function FeatureRoute({ feature, name, children }: { feature: string; name?: string; children: React.ReactNode }) {
  const enabled = useFeature(feature);
  if (!enabled) return <FeatureUnavailable name={name} />;
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
        <Route path="/generated-tests" element={<FeatureRoute feature="generated-tests" name="Generated Test Cases"><GeneratedTestCasesPage /></FeatureRoute>} />
        <Route path="/reports" element={<FeatureRoute feature="reports" name="Reports"><ReportsPage /></FeatureRoute>} />
        <Route path="/bug-tracker" element={<FeatureRoute feature="bug-tracker" name="Bug Tracker"><BugTrackerPage /></FeatureRoute>} />
        <Route path="/user-management" element={<FeatureRoute feature="user-management" name="User Management"><UserManagementPage /></FeatureRoute>} />
        <Route path="/system-configuration" element={<FeatureRoute feature="system-configuration" name="System Configuration"><SystemConfigurationPage /></FeatureRoute>} />
        {/* Feature Toggles dashboard — admin control panel, never feature-gated */}
        <Route path="/feature-toggles" element={<FeatureTogglesPage />} />
        {/* Agent Performance monitor — read-only telemetry, not feature-gated */}
        <Route path="/agent-performance" element={<AgentPerformancePage />} />
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
          <FeatureToggleProvider>
            <ToastProvider>
              <RouteBreadcrumbs />
              <AppRoutes />
              <DiagnosticsPanel />
            </ToastProvider>
          </FeatureToggleProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
