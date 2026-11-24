import { can, type Role, type UserDto } from '@dw/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  clearTokens,
  restoreSession,
  setSessionExpiredHandler,
  setSessionIdleDeadline,
  setTokens,
} from './api';

interface AuthState {
  user: UserDto | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  /** 自助修改姓名（所有登录用户） */
  updateProfile: (displayName: string) => Promise<void>;
  /** 自助修改密码：成功后服务端会换发新令牌，这里同步本地登录态 */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
const ACTIVITY_THROTTLE_MS = 5_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'scroll'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [ready, setReady] = useState(false);
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState(DEFAULT_IDLE_TIMEOUT_SECONDS);
  const lastActivityAt = useRef(Date.now());

  // 刷新令牌由服务端以 httpOnly Cookie 下发，这里凭 Cookie 静默续期恢复登录态：
  // 刷新页面 / 新开标签页都不必重新登录，且令牌本身不落 localStorage。
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setSessionIdleDeadline(null);
      setUser(null);
    });
    let cancelled = false;
    void (async () => {
      try {
        const restored = await restoreSession();
        if (!cancelled && restored) {
          setIdleTimeoutSeconds(restored.idleTimeoutSeconds);
          setUser(restored.user);
        }
      } catch {
        /* Cookie 不存在或已过期：保持未登录，展示登录页 */
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.post<{
      accessToken: string;
      idleTimeoutSeconds: number;
      user: UserDto;
    }>('/auth/login', {
      username,
      password,
    });
    setTokens({ accessToken: result.accessToken });
    setIdleTimeoutSeconds(result.idleTimeoutSeconds);
    lastActivityAt.current = Date.now();
    setUser(result.user);
  }, []);

  const updateProfile = useCallback(async (displayName: string) => {
    const updated = await api.patch<UserDto>('/auth/profile', { displayName });
    setUser(updated);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    // 服务端校验通过后会轮换令牌：旧的刷新令牌全部作废，用返回的新令牌继续本端会话
    const result = await api.post<{
      accessToken: string;
      idleTimeoutSeconds: number;
      user: UserDto;
    }>('/auth/password', { currentPassword, newPassword });
    setTokens({ accessToken: result.accessToken });
    setIdleTimeoutSeconds(result.idleTimeoutSeconds);
    lastActivityAt.current = Date.now();
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* 登出失败也要清理本地状态 */
    }
    clearTokens();
    setUser(null);
  }, []);

  useEffect(() => {
    if (!user) return;
    const timeoutMs = idleTimeoutSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiring = false;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const expire = () => {
      if (expiring) return;
      expiring = true;
      clearTimer();
      void logout();
    };
    const arm = (delay = timeoutMs) => {
      clearTimer();
      timer = setTimeout(expire, Math.max(0, delay));
    };
    const refreshDeadline = () => {
      const deadline = lastActivityAt.current + timeoutMs;
      setSessionIdleDeadline(deadline);
      arm(deadline - Date.now());
    };
    const onActivity = () => {
      if (expiring) return;
      const now = Date.now();
      if (now - lastActivityAt.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt.current = now;
      refreshDeadline();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() >= lastActivityAt.current + timeoutMs) {
        expire();
      } else {
        refreshDeadline();
      }
    };

    lastActivityAt.current = Date.now();
    refreshDeadline();
    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearTimer();
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [idleTimeoutSeconds, logout, user]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      login,
      logout,
      can: (permission: string) => (user ? can(user.role as Role, permission) : false),
      updateProfile,
      changePassword,
    }),
    [user, ready, login, logout, updateProfile, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
