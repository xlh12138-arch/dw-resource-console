import {
  Activity,
  Boxes,
  Database,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Server,
  Settings2,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS, type Role } from '@dw/shared';
import { useAuth } from '../lib/auth';
import { Badge, Button, cn } from './ui';

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
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobilePanelRef = useRef<HTMLElement | null>(null);
  const mobileCloseRef = useRef<HTMLButtonElement | null>(null);

  const visibleNav = NAV.filter((item) => !item.permission || canDo(item.permission));
  const currentItem = visibleNav.find((item) =>
    item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to),
  );

  const signOut = async () => {
    await logout();
    navigate('/login');
  };

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    mobileCloseRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !mobilePanelRef.current) return;

      const focusable = Array.from(
        mobilePanelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [mobileOpen]);

  const renderNavigation = (mobile = false) =>
    visibleNav.map((item) => (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === '/'}
        onClick={mobile ? () => setMobileOpen(false) : undefined}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
            isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100',
          )
        }
      >
        <item.icon size={16} />
        {item.label}
      </NavLink>
    ));

  const renderSidebar = (mobile = false) => (
    <>
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Server size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">数据仓库资源台</p>
          <p className="truncate text-[11px] text-slate-500">DW Resource Console</p>
        </div>
        {mobile ? (
          <button
            ref={mobileCloseRef}
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            aria-label="关闭导航"
            title="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={17} />
          </button>
        ) : null}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3" aria-label="主导航">
        {renderNavigation(mobile)}
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
    </>
  );

  return (
    <div className="min-h-screen bg-[#f4f6f8]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-slate-900 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        跳到主要内容
      </a>

      <div className="flex min-h-screen">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
          {renderSidebar()}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 shrink-0 px-0 lg:hidden"
                aria-label="打开导航"
                title="打开导航"
                aria-expanded={mobileOpen}
                aria-controls="mobile-navigation"
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={18} />
              </Button>
              <div className="flex min-w-0 items-center gap-2 lg:hidden">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white">
                  <Server size={14} />
                </div>
                <span className="truncate text-sm font-semibold text-slate-900">{currentItem?.label ?? '数据仓库资源台'}</span>
              </div>
              <p className="hidden text-sm font-medium text-slate-700 lg:block">{currentItem?.label ?? '数据仓库资源台'}</p>
            </div>

            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Badge tone="blue" className="hidden sm:inline-flex">
                {ROLE_LABELS[(user?.role ?? 'USER') as Role]}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                aria-label="退出登录"
                title="退出登录"
                onClick={() => void signOut()}
              >
                <LogOut size={14} />
                <span className="hidden sm:inline">退出登录</span>
              </Button>
            </div>
          </header>

          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 focus:outline-none sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-slate-900/45"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          />
          <aside
            id="mobile-navigation"
            ref={mobilePanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="主导航"
            className="relative flex h-full w-[min(18rem,calc(100vw-2.5rem))] flex-col border-r border-slate-200 bg-white shadow-2xl"
          >
            {renderSidebar(true)}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
