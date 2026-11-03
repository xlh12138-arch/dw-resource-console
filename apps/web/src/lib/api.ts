import type {
  AuditLogDto,
  AuthResult,
  ResourceDto,
  ResourceType,
  StatsOverview,
  UserDto,
} from '@dw/shared';

/** 同源代理（默认）或 .env 中的 VITE_API_BASE_URL */
const API_ROOT = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
export const API = `${API_ROOT}/api/v1`;

/**
 * 令牌策略：
 * - 访问令牌只保存在内存中，用于请求头；
 * - 刷新令牌由服务端以 httpOnly Cookie 下发（登录 / 续期时自动写入），
 *   前端拿不到也无需存储，页面刷新后可直接凭 Cookie 静默续期。
 * 这里保留一份内存副本，只为兼容「未启用 Cookie 的调用方」与主动刷新流程。
 */
let accessToken: string | null = null;
let refreshToken: string | null = null;
let onSessionExpired: (() => void) | null = null;
/** 并发请求同时 401 时只发一次续期请求 */
let refreshInFlight: Promise<AuthResult | null> | null = null;

export function setSessionExpiredHandler(fn: () => void): void {
  onSessionExpired = fn;
}

export function getTokens() {
  return { accessToken, refreshToken };
}

export function setTokens(tokens: { accessToken: string; refreshToken: string }): void {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 后端错误码 → 兜底文案（仅在服务端未给出可读信息时使用） */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  FORBIDDEN: '当前角色无权执行该操作',
  NOT_FOUND: '请求的资源不存在',
  CONFLICT: '资源冲突：该配置已被占用',
  VALIDATION_ERROR: '提交的数据校验未通过',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  BAD_REQUEST: '请求参数不合法',
  INTERNAL: '服务异常，请联系管理员',
};

/**
 * 结构化取出字段级校验明细，兼容两种返回形状：
 * - 业务校验：`details` 为 [{ field, message }]
 * - 框架校验：`details` 为 { issues: [{ field, message }] }
 */
export interface FieldIssue {
  field: string;
  message: string;
}

export function fieldIssues(error: unknown): FieldIssue[] {
  if (!(error instanceof ApiError) || !error.details) return [];
  const raw = error.details as unknown;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { issues?: unknown[] }).issues)
      ? (raw as { issues: unknown[] }).issues
      : [];
  const out: FieldIssue[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawField =
      typeof rec.field === 'string' ? rec.field : Array.isArray(rec.path) ? rec.path.join('.') : '';
    const message = typeof rec.message === 'string' ? rec.message : '校验失败';
    out.push({ field: rawField.replace(/^\//, '').replace(/\//g, '.'), message });
  }
  return out;
}

/**
 * 用户可读错误文案：优先展示服务端给出的具体原因，
 * 仅当服务端没有可用信息时才回退到错误码兜底文案，
 * 避免「校验未通过」这类无信息量的提示。
 */
export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const serverMessage = (error.message ?? '').trim();
    if (serverMessage) return serverMessage;
    return MESSAGES[error.code] ?? `操作失败（HTTP ${error.status}）`;
  }
  if (error instanceof TypeError) return '网络连接失败，请检查服务是否可用';
  return error instanceof Error ? error.message : '未知错误';
}

/**
 * 静默续期：优先用内存里的刷新令牌，没有则完全依赖服务端的 httpOnly Cookie。
 * 成功时同时拿到新的访问令牌与用户信息（用户的登录态据此恢复）。
 */
async function doRefresh(): Promise<AuthResult | null> {
  try {
    const payload = refreshToken ? JSON.stringify({ refreshToken }) : undefined;
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      // 关键：带上 Cookie，服务端据此识别会话
      credentials: 'include',
      // 无请求体时不能声明 application/json，否则 Fastify 会因空 body 返回 400
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as AuthResult;
    setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    return data;
  } catch {
    return null;
  }
}

/** 统一的续期入口：并发调用共享同一次请求 */
export function refreshSession(): Promise<AuthResult | null> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * 应用启动时尝试凭 Cookie 恢复登录态：
 * 无需把任何令牌写进 localStorage，刷新页面也能保持登录。
 */
export async function restoreSession(): Promise<UserDto | null> {
  const result = await refreshSession();
  return result?.user ?? null;
}

type Options = Omit<RequestInit, 'body'> & { body?: unknown; retries?: number };

async function request<T>(path: string, options: Options = {}, attempt = 0): Promise<T> {
  const { body, retries = 0, headers, ...rest } = options;
  const init: RequestInit = {
    ...rest,
    // 同源 / 代理场景都需要带上 Cookie，否则服务端的 httpOnly 刷新令牌收不到
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, init);
  } catch (err) {
    // 网络层失败：有限重试
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return request<T>(path, options, attempt + 1);
    }
    throw err instanceof Error ? err : new Error('网络请求失败');
  }

  // 401：先尝试静默刷新（内存令牌或 httpOnly Cookie），成功则重放一次请求
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    const refreshed = await refreshSession();
    if (refreshed) return request<T>(path, options, attempt);
    clearTokens();
    onSessionExpired?.();
    throw new ApiError('登录状态已失效，请重新登录', 'UNAUTHORIZED', 401);
  }

  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      /* 忽略非 JSON 响应 */
    }
    throw new ApiError(
      payload.error?.message ?? `请求失败（HTTP ${res.status}）`,
      payload.error?.code ?? 'INTERNAL',
      res.status,
      payload.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, retries = 2) => request<T>(path, { method: 'GET', retries }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
  /** CSV 导出等非 JSON 响应 */
  text: async (path: string): Promise<string> => {
    const res = await fetch(`${API}${path}`, {
      credentials: 'include',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) throw new ApiError('导出失败', 'INTERNAL', res.status);
    return res.text();
  },
};

export type { ResourceDto, ResourceType, StatsOverview, UserDto, AuditLogDto, AuthResult };
