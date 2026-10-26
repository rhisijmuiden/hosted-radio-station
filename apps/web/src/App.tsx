import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { isAdmin, useMe } from './lib/auth';
import { useTheme } from './lib/theme';
import { ThemeContext } from './lib/theme-context';
import { ApiKeysPage } from './pages/ApiKeys';
import { AuditLogPage } from './pages/AuditLog';
import { BackupsPage } from './pages/Backups';
import { CustomerDetailPage } from './pages/CustomerDetail';
import { CustomersPage } from './pages/Customers';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { MailServerPage } from './pages/MailServer';
import { NodeDetailPage } from './pages/NodeDetail';
import { NodesPage } from './pages/Nodes';
import { NotFoundPage } from './pages/NotFound';
import { ProfilePage } from './pages/Profile';
import { ResetPasswordPage } from './pages/ResetPassword';
import { StationDetailPage } from './pages/StationDetail';
import { StationsPage } from './pages/Stations';
import { StatisticsPage } from './pages/Statistics';
import { StatisticsSettingsPage } from './pages/StatisticsSettings';
import { StreamingPage } from './pages/Streaming';
import { StudioLinkPage, StudioPage } from './pages/Studio';
import { TopologyPage } from './pages/Topology';
import { UpdatesPage } from './pages/Updates';
import { UsersPage } from './pages/Users';
import { WebServerPage } from './pages/WebServer';

function RequireAuth({ admin, children }: { admin?: boolean; children: React.ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (me.isError || !me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (admin && !isAdmin(me.data)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const theme = useTheme();
  return (
    <ThemeContext.Provider value={theme}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:id" element={<CustomerDetailPage />} />
          <Route path="stations" element={<StationsPage />} />
          <Route path="stations/:id" element={<StationDetailPage />} />
          <Route path="statistics" element={<StatisticsPage />} />
          <Route path="nodes" element={<NodesPage />} />
          <Route path="nodes/:id" element={<NodeDetailPage />} />
          <Route path="topology" element={<TopologyPage />} />
          <Route path="studio" element={<StudioPage />} />
          <Route path="link" element={<StudioLinkPage />} />
          <Route path="settings/statistics" element={<RequireAuth admin><StatisticsSettingsPage /></RequireAuth>} />
          <Route path="users" element={<RequireAuth admin><UsersPage /></RequireAuth>} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="settings/mail" element={<RequireAuth admin><MailServerPage /></RequireAuth>} />
          <Route path="settings/web-server" element={<RequireAuth admin><WebServerPage /></RequireAuth>} />
          <Route path="settings/streaming" element={<RequireAuth admin><StreamingPage /></RequireAuth>} />
          <Route path="settings/backups" element={<RequireAuth admin><BackupsPage /></RequireAuth>} />
          <Route path="audit" element={<RequireAuth admin><AuditLogPage /></RequireAuth>} />
          <Route path="settings/updates" element={<RequireAuth admin><UpdatesPage /></RequireAuth>} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      <Toaster position="bottom-right" theme={theme.theme} richColors closeButton />
    </ThemeContext.Provider>
  );
}
