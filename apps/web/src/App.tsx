import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { Layout } from './components/layout';
import { EmptyState, Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AuditPage } from './pages/audit-page';
import { DashboardPage } from './pages/dashboard-page';
import { DictPage } from './pages/dict-page';
import { LoginPage } from './pages/login-page';
import { ProjectDetailPage } from './pages/project-detail-page';
import { ProjectsPage } from './pages/projects-page';
import { ResourcesPage } from './pages/resources-page';
import { TemplatesPage } from './pages/templates-page';
import { UsersPage } from './pages/users-page';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAdmin({
  children,
  desc = '用户管理仅对管理员开放，请联系系统管理员开通权限',
}: {
  children: ReactNode;
  desc?: string;
}) {
  const { user } = useAuth();
  if (user && user.role !== 'ADMIN') {
    return (
      <div className="rounded-[12px] border border-slate-200 bg-white">
        <EmptyState title="无权访问" desc={desc} />
      </div>
    );
  }
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'resources', element: <ResourcesPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'dict', element: <DictPage /> },
      {
        path: 'audit',
        element: (
          <RequireAdmin desc="变更审计仅对管理员开放，请联系系统管理员开通权限">
            <AuditPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'users',
        element: (
          <RequireAdmin>
            <UsersPage />
          </RequireAdmin>
        ),
      },
      { path: '*', element: <EmptyState title="页面不存在" desc="请从左侧导航选择功能" /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
