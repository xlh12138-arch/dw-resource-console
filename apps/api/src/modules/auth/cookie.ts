import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config/env.js';

/**
 * 刷新令牌的 Cookie 通道。
 *
 * 访问令牌仍只存内存（前端不落 localStorage），刷新令牌放在 httpOnly Cookie 里：
 * - 前端脚本读不到，降低 XSS 窃取风险；
 * - 页面刷新 / 新标签页打开时，前端可凭 Cookie 静默续期，用户无需重新登录。
 */

export const REFRESH_COOKIE = 'dw_refresh';

/** 下发刷新令牌 Cookie */
export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    maxAge: config.auth.refreshTokenTtlSeconds,
  });
}

/** 登出 / 刷新令牌失效时清除 Cookie */
export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: '/' });
}

/** 刷新令牌只从 httpOnly Cookie 读取。 */
export function refreshTokenFrom(request: FastifyRequest): string | undefined {
  return (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[
    REFRESH_COOKIE
  ];
}
