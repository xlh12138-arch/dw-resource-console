import {
  authResultSchema,
  changePasswordSchema,
  loginSchema,
  updateProfileSchema,
  userSchema,
} from '@dw/shared';
import { config } from '../../config/env.js';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTransaction } from '../../db/index.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { auditRepository } from '../audit/repository.js';
import { authService, toUserDto } from './service.js';
import { userRepository } from '../users/repository.js';
import { clearRefreshCookie, refreshTokenFrom, setRefreshCookie } from './cookie.js';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // 登录接口单独限流，抵御口令爆破
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: { max: config.rateLimitLogin.max, timeWindow: config.rateLimitLogin.timeWindow },
      },
      schema: { body: loginSchema, response: { 200: authResultSchema } },
    },
    async (request, reply) => {
      const result = await withTransaction(() =>
        authService.login(request.body.username, request.body.password, {
          signAccessToken: app.signAccessToken,
          userAgent: request.headers['user-agent'],
          requestId: request.id,
          ip: request.ip,
        }),
      );
      // 刷新令牌同时写入 httpOnly Cookie：刷新页面后可静默续期
      setRefreshCookie(reply, request, result.refreshToken);
      const { refreshToken: _refreshToken, ...response } = result;
      return response;
    },
  );

  app.post(
    '/auth/refresh',
    {
      // 刷新令牌只从 httpOnly Cookie 读取，不进入 JS 可访问的响应体。
      schema: { response: { 200: authResultSchema } },
    },
    async (request, reply) => {
      const token = refreshTokenFrom(request);
      if (!token) throw unauthorized('缺少刷新令牌，请重新登录');
      const result = await withTransaction(() =>
        authService.refresh(token, {
          signAccessToken: app.signAccessToken,
          userAgent: request.headers['user-agent'],
        }),
      );
      setRefreshCookie(reply, request, result.refreshToken);
      const { refreshToken: _refreshToken, ...response } = result;
      return response;
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: { response: { 200: z.object({ success: z.boolean() }) } },
    },
    async (request, reply) => {
      const result = await withTransaction(() => authService.logout(refreshTokenFrom(request)));
      clearRefreshCookie(reply, request);
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

  /*
   * 个人中心：所有登录用户（含只读）都能改自己的姓名与密码，
   * 因此不能挂在 /users 下面的 adminGuard 上。
   */

  app.patch(
    '/auth/profile',
    {
      preHandler: app.authenticate,
      schema: { body: updateProfileSchema, response: { 200: userSchema } },
    },
    async (request) => {
      const current = request.currentUser!;
      const before = await userRepository.findById(current.id);
      if (!before) throw notFound('用户不存在');
      if (before.displayName === request.body.displayName) return toUserDto(before);

      const updated = await withTransaction(async () => {
        const next = await userRepository.update(current.id, {
          displayName: request.body.displayName,
        });
        await auditRepository.record({
          actorId: current.id,
          actorName: next.displayName,
          action: 'UPDATE',
          targetType: 'USER',
          targetId: String(current.id),
          targetName: next.username,
          changes: [
            {
              field: 'displayName',
              label: '姓名',
              from: before.displayName,
              to: next.displayName,
            },
          ],
          requestId: request.id,
        });
        return next;
      });
      return toUserDto(updated);
    },
  );

  app.post(
    '/auth/password',
    {
      preHandler: app.authenticate,
      // 与登录接口同档限流，避免在线爆破当前密码
      config: {
        rateLimit: { max: config.rateLimitLogin.max, timeWindow: config.rateLimitLogin.timeWindow },
      },
      schema: { body: changePasswordSchema, response: { 200: authResultSchema } },
    },
    async (request, reply) => {
      const current = request.currentUser!;
      const user = await userRepository.findById(current.id);
      if (!user) throw notFound('用户不存在');
      const result = await withTransaction(async () => {
        const updated = await authService.changePassword(user, request.body, {
          requestId: request.id,
        });
        // 作废该用户所有旧会话后重新签发：本端拿新令牌继续用，其他设备被踢下线
        return authService.rotateOwnSession(updated, {
          signAccessToken: app.signAccessToken,
          userAgent: request.headers['user-agent'],
        });
      });
      setRefreshCookie(reply, request, result.refreshToken);
      const { refreshToken: _refreshToken, ...response } = result;
      return response;
    },
  );
};
