import {
  Activity,
  Boxes,
  Database,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Server,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { ROLE_LABELS, type Role } from '@dw/shared';
import { useAuth } from '../lib/auth';
import { Badge, Button } from './ui';

const NAV = [
  { to: '/', label: '资源概览', icon: LayoutDashboard },
  { to: '/resources', label: '资源台账', icon: Database },
  { to: '/projects', label: '需求项目', icon: FolderKanban },
  { to: '/templates', label: '环境模板', icon: Boxes },
  { to: '/dict', label: '字典配置', icon: Settings2, permission: 'resource:read' },
  { to: '/audit', label: '变更审计', icon: FileClock, permission: 'audit:read' },
  { to: '/users', label: '用户管理', icon: Users, permission: 'user:manage' },
];

export function Layout() {
  const { user, logout, can: canDo } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen bg-[#f6f8fb]">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Server size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">数据仓库资源台</p>
            <p className="text-[11px] text-slate-500">DW Resource Console</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.filter((item) => !item.permission || canDo(item.permission)).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                [
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100',
                ].join(' ')
              }
            >
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-100 p-3">
          <div className="mb-2 flex items-center gap-2 px-2 text-xs text-slate-500">
            <Activity size={14} className="text-emerald-500" />
            服务运行正常
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
              {user?.displayName?.slice(0, 1) ?? 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-800">{user?.displayName}</p>
              <p className="truncate text-[11px] text-slate-500">{user?.username}</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <ShieldCheck size={15} className="text-brand-600" />
            批量调度 / 采集交换 / NAS / GDS 资源统一管理 · 按项目组织多套环境
          </div>
          <div className="flex items-center gap-3">
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

        <main className="min-w-0 flex-1 overflow-x-hidden p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
