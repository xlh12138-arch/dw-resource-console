import { authResultSchema, loginSchema, refreshSchema, userSchema } from '@dw/shared';
import { config } from '../../config/env.js';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf } from '../../lib/actor.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { authService, toUserDto } from './service.js';
import { userRepository } from '../users/repository.js';
import { REFRESH_COOKIE, clearRefreshCookie, refreshTokenFrom, setRefreshCookie } from './cookie.js';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // 登录接口单独限流，抵御口令爆破
  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: config.rateLimitLogin.max, timeWindow: config.rateLimitLogin.timeWindow } },
      schema: { body: loginSchema, response: { 200: authResultSchema } },
    },
    async (request, reply) => {
      const result = await authService.login(request.body.username, request.body.password, {
        signAccessToken: app.signAccessToken,
        userAgent: request.headers['user-agent'],
        requestId: request.id,
        ip: request.ip,
      });
      // 刷新令牌同时写入 httpOnly Cookie：刷新页面后可静默续期
      setRefreshCookie(reply, result.refreshToken);
      return result;
    },
  );

  app.post(
    '/auth/refresh',
    {
      // 刷新令牌可来自 Cookie（页面刷新场景）或请求体（兼容无 Cookie 的调用方）
      // 无请求体时 Fastify 传入的是 null，故用 nullish 而不是 optional
      schema: { body: refreshSchema.nullish(), response: { 200: authResultSchema } },
    },
    async (request, reply) => {
      const token = refreshTokenFrom(request);
      if (!token) throw unauthorized('缺少刷新令牌，请重新登录');
      const result = await authService.refresh(token, {
        signAccessToken: app.signAccessToken,
        userAgent: request.headers['user-agent'],
      });
      setRefreshCookie(reply, result.refreshToken);
      return result;
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: app.authenticate, schema: { body: refreshSchema.nullish(), response: { 200: z.object({ success: z.boolean() }) } } },
    async (request, reply) => {
      const result = await authService.logout(refreshTokenFrom(request), actorOf(request));
      clearRefreshCookie(reply);
      return result;
    },
  );

  app.get(
    '/auth/me',
    { preHandler: app.authenticate, schema: { response: { 200: userSchema } } },
    async (request) => {
      const user = await userRepository.findById(request.currentUser!.id);
      if (!user) throw notFound('用户不存在');
      return toUserDto(user);
    },
  );
};

export { REFRESH_COOKIE };
