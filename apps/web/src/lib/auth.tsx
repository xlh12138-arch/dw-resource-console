import { can, type Role, type UserDto } from '@dw/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, clearTokens, restoreSession, setSessionExpiredHandler, setTokens } from './api';

interface AuthState {
  user: UserDto | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [ready, setReady] = useState(false);

  // 刷新令牌由服务端以 httpOnly Cookie 下发，这里凭 Cookie 静默续期恢复登录态：
  // 刷新页面 / 新开标签页都不必重新登录，且令牌本身不落 localStorage。
  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
    let cancelled = false;
    void (async () => {
      try {
        const restored = await restoreSession();
        if (!cancelled && restored) setUser(restored);
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
    const result = await api.post<{ accessToken: string; user: UserDto }>('/auth/login', {
      username,
      password,
    });
    setTokens({ accessToken: result.accessToken });
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

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      login,
      logout,
      can: (permission: string) => (user ? can(user.role as Role, permission) : false),
    }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
