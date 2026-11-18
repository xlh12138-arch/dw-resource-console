import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * 刷新令牌的 Cookie 通道。
 *
 * 访问令牌仍只存内存（前端不落 localStorage），刷新令牌放在 httpOnly Cookie 里：
 * - 前端脚本读不到，降低 XSS 窃取风险；
 * - 页面刷新 / 新标签页打开时，前端可凭 Cookie 静默续期，用户无需重新登录。
 */

export const REFRESH_COOKIE = 'dw_refresh';

/** 下发刷新令牌 Cookie */
export function setRefreshCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  token: string,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 内网部署可能使用 HTTP；只有实际使用 HTTPS 时才加 Secure，否则浏览器不会保存 Cookie。
    secure: request.protocol === 'https',
    path: '/',
    // 不设置 maxAge / expires：这是浏览器会话 Cookie，关闭浏览器后即失效。
  });
}

/** 登出 / 刷新令牌失效时清除 Cookie */
export function clearRefreshCookie(reply: FastifyReply, request: FastifyRequest): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
    path: '/',
  });
}

/** 刷新令牌只从 httpOnly Cookie 读取。 */
export function refreshTokenFrom(request: FastifyRequest): string | undefined {
  return (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[
    REFRESH_COOKIE
  ];
}
