import {
  Boxes,
  Database,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings2,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS, type Role } from '@dw/shared';
import { useAuth } from '../lib/auth';
import { cn } from './ui';

const NAV = [
  { to: '/', label: '资源概览', shortLabel: '概览', icon: LayoutDashboard },
  { to: '/resources', label: '资源台账', shortLabel: '台账', icon: Database },
  { to: '/projects', label: '需求项目', shortLabel: '项目', icon: FolderKanban },
  { to: '/templates', label: '环境模板', shortLabel: '模板', icon: Boxes },
  { to: '/dict', label: '字典配置', shortLabel: '字典', icon: Settings2, permission: 'resource:read' },
  { to: '/audit', label: '变更审计', shortLabel: '审计', icon: FileClock, permission: 'audit:read' },
  { to: '/users', label: '用户管理', shortLabel: '用户', icon: Users, permission: 'user:manage' },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-signal-400 text-brand-700">
        <Database size={18} strokeWidth={2.2} />
      </div>
      <div className={cn('min-w-0', compact && 'block')}>
        <p className="truncate text-[14px] font-medium leading-tight text-white">数据仓库资源控制台</p>
      </div>
    </div>
  );
}

export function Layout() {
  const { user, logout, can: canDo } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobilePanelRef = useRef<HTMLElement | null>(null);
  const mobileCloseRef = useRef<HTMLButtonElement | null>(null);

  const visibleNav = NAV.filter((item) => !item.permission || canDo(item.permission));
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
          mobile
            ? cn(
                'flex h-14 items-center gap-3 border-b border-white/10 px-1 text-[15px] transition-colors',
                isActive ? 'text-signal-400' : 'text-white/70 hover:text-white',
              )
            : cn(
                'relative flex h-16 items-center px-3 text-[13px] font-medium transition-colors',
                isActive ? 'text-white' : 'text-white/55 hover:text-white',
              )
        }
      >
        {({ isActive }) => (
          <>
            <item.icon size={mobile ? 18 : 14} strokeWidth={1.8} />
            <span className="ml-2">{mobile ? item.label : item.shortLabel}</span>
            {!mobile && isActive ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 bg-signal-400" aria-hidden />
            ) : null}
          </>
        )}
      </NavLink>
    ));

  return (
    <div className="min-h-screen bg-[#f7f7f7]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[100] focus:rounded-[6px] focus:bg-signal-400 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-700"
      >
        跳到主要内容
      </a>

      <header className="sticky top-0 z-40 border-b border-white/10 bg-brand-600 text-white">
        <div className="mx-auto flex h-16 max-w-[1560px] items-center gap-6 px-4 sm:px-6 lg:px-8">
          <NavLink to="/" aria-label="返回资源概览" className="shrink-0 focus:outline-none">
            <Brand />
          </NavLink>

          <nav className="hidden h-full flex-1 items-center justify-center gap-1 xl:flex" aria-label="主导航">
            {renderNavigation()}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-2.5 md:flex">
              <div className="text-right">
                <p className="max-w-28 truncate text-[13px] font-medium leading-tight text-white">
                  {user?.displayName}
                </p>
                <p className="mt-0.5 text-[11px] leading-tight text-white/45">
                  {ROLE_LABELS[(user?.role ?? 'USER') as Role]}
                </p>
              </div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 text-xs font-medium text-white">
                {user?.displayName?.slice(0, 1) ?? 'U'}
              </div>
            </div>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-[8px] text-white/55 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
              aria-label="退出登录"
              title="退出登录"
              onClick={() => void signOut()}
            >
              <LogOut size={16} />
            </button>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-white/20 text-white/75 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400 xl:hidden"
              aria-label="打开导航"
              title="打开导航"
              aria-expanded={mobileOpen}
              aria-controls="mobile-navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={18} />
            </button>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="min-w-0 px-4 py-6 focus:outline-none sm:px-6 sm:py-8 lg:px-8">
        <div className="mx-auto max-w-[1560px]">
          <Outlet />
        </div>
      </main>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 xl:hidden">
          <aside
            id="mobile-navigation"
            ref={mobilePanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="主导航"
            className="flex h-full w-full flex-col overflow-y-auto bg-brand-600 px-5 text-white"
          >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10">
              <Brand compact />
              <button
                ref={mobileCloseRef}
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-[8px] text-white/65 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                aria-label="关闭导航"
                title="关闭导航"
                onClick={() => setMobileOpen(false)}
              >
                <X size={19} />
              </button>
            </div>

            <nav className="py-4" aria-label="移动端主导航">
              {renderNavigation(true)}
            </nav>

            <div className="mt-auto border-t border-white/10 py-5">
              <p className="text-sm font-medium">{user?.displayName}</p>
              <p className="mt-1 text-xs text-white/45">
                {user?.username} · {ROLE_LABELS[(user?.role ?? 'USER') as Role]}
              </p>
              <button
                type="button"
                onClick={() => void signOut()}
                className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-white/20 text-sm font-medium text-white transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
              >
                <LogOut size={15} />
                退出登录
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
