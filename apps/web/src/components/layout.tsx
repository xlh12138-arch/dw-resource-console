import {
  Boxes,
  ChevronRight,
  Database,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Server,
  Settings2,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS, type Role } from '@dw/shared';
import { useAuth } from '../lib/auth';
import { Badge, Button } from './ui';

const NAV_GROUPS = [
  {
    label: '工作台',
    items: [{ to: '/', label: '资源概览', icon: LayoutDashboard }],
  },
  {
    label: '资源治理',
    items: [
      { to: '/resources', label: '资源台账', icon: Database },
      { to: '/projects', label: '需求项目', icon: FolderKanban },
      { to: '/templates', label: '环境模板', icon: Boxes },
      { to: '/dict', label: '字典配置', icon: Settings2, permission: 'resource:read' },
    ],
  },
  {
    label: '系统管理',
    items: [
      { to: '/audit', label: '变更审计', icon: FileClock, permission: 'audit:read' },
      { to: '/users', label: '用户管理', icon: Users, permission: 'user:manage' },
    ],
  },
] as const;

function currentNavLabel(pathname: string): string {
  if (pathname.startsWith('/resources')) return '资源台账';
  if (pathname.startsWith('/projects')) return '需求项目';
  if (pathname.startsWith('/templates')) return '环境模板';
  if (pathname.startsWith('/dict')) return '字典配置';
  if (pathname.startsWith('/audit')) return '变更审计';
  if (pathname.startsWith('/users')) return '用户管理';
  return '资源概览';
}

export function Layout() {
  const { user, logout, can: canDo } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const activeLabel = currentNavLabel(location.pathname);

  return (
    <div className="app-shell">
      <aside id="app-navigation" className={`app-sidebar${navOpen ? ' is-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark">
            <Server size={17} />
          </div>
          <div className="min-w-0">
            <p className="sidebar-brand-title">数据仓库资源台</p>
            <p className="sidebar-brand-meta">DW Resource Console</p>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {NAV_GROUPS.map((group) => {
            const visible = group.items.filter((item) => !('permission' in item) || canDo(item.permission));
            if (visible.length === 0) return null;
            return (
              <div key={group.label}>
                <p className="sidebar-section-label">{group.label}</p>
                {visible.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={() => setNavOpen(false)}
                    className={({ isActive }) => `sidebar-nav-link${isActive ? ' is-active' : ''}`}
                  >
                    <item.icon size={16} />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-health">
            <span className="health-dot" />
            服务运行正常
          </div>
          <div className="sidebar-user">
            <div className="sidebar-avatar">{user?.displayName?.slice(0, 1) ?? 'U'}</div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-200">{user?.displayName}</p>
              <p className="truncate text-[10px] text-slate-500">{user?.username}</p>
            </div>
          </div>
        </div>
      </aside>

      {navOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="app-workspace">
        <header className="app-topbar">
          <div className="topbar-context">
            <button
              type="button"
              className="mobile-menu-button"
              aria-label="打开导航"
              aria-controls="app-navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Menu size={16} />
            </button>
            <span>运营控制台</span>
            <ChevronRight size={13} className="topbar-separator" />
            <strong>{activeLabel}</strong>
          </div>
          <div className="topbar-actions">
            <span className="topbar-health">
              <span className="health-dot" />
              数据连接正常
            </span>
            <Badge tone="blue">{ROLE_LABELS[(user?.role ?? 'USER') as Role]}</Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              <LogOut size={14} />
              退出登录
            </Button>
          </div>
        </header>

        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
