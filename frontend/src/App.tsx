import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { FeatureFlagsProvider } from '@/contexts/FeatureFlagsContext';
import { ToastProvider } from '@/components/feedback/ToastProvider';
import ErrorBoundary from '@/components/ErrorBoundary';
import Layout from '@/components/layout/Layout';
import LandingPage from '@/pages/LandingPage';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import ReportsPage from '@/pages/ReportsPage';
import ExecutionRecordingsPage from '@/pages/ExecutionRecordingsPage';
import AgentMonitorPage from '@/pages/AgentMonitorPage';
import SystemConfigurationPage from '@/pages/SystemConfigurationPage';
import GeneratedTestCasesPage from '@/pages/GeneratedTestCasesPage';
import AutomationScriptsPage from '@/pages/AutomationScriptsPage';
import UserManagementPage from '@/pages/UserManagementPage';
import FeatureTogglesPage from '@/pages/FeatureTogglesPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<LandingPage />} />
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
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/generated-tests" element={<GeneratedTestCasesPage />} />
        <Route path="/automation-scripts" element={<AutomationScriptsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/execution-recordings" element={<ExecutionRecordingsPage />} />
        <Route path="/agents" element={<AgentMonitorPage />} />
        <Route path="/user-management" element={<UserManagementPage />} />
        <Route path="/system-configuration" element={<SystemConfigurationPage />} />
        {/* Feature switchboard — always reachable (never self-disabled) */}
        <Route path="/feature-toggles" element={<FeatureTogglesPage />} />
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
          <FeatureFlagsProvider>
            <ToastProvider>
              <AppRoutes />
            </ToastProvider>
          </FeatureFlagsProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
