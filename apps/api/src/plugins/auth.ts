import fastifyJwt from '@fastify/jwt';
import { can, type Role } from '@dw/shared';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { userRepository } from '../modules/users/repository.js';

export interface CurrentUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
  interface FastifyInstance {
    /** 校验访问令牌并挂载 request.currentUser */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** RBAC：要求当前角色具备指定权限之一（实际是全部校验） */
    authorize: (
      ...permissions: string[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    signAccessToken: (user: { id: number; username: string; role: Role }) => string;
  }
}

/**
 * 用 fastify-plugin 打破封装：authenticate / authorize / signAccessToken
 * 需要在所有业务路由插件中可见。
 */
const authPluginImpl: FastifyPluginAsyncZod = async (app) => {
  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: config.auth.accessTokenTtlSeconds },
  });

  app.decorate('signAccessToken', (user: { id: number; username: string; role: Role }) =>
    app.jwt.sign({ sub: user.id, username: user.username, role: user.role }),
  );

  app.decorate('authenticate', async (request) => {
    try {
      await request.jwtVerify<{ sub: number }>();
    } catch {
      throw unauthorized('未登录或访问令牌已失效');
    }
    const payload = request.user as { sub?: number };
    const id = Number(payload?.sub ?? 0);
    if (!id) throw unauthorized('令牌载荷不合法');

    const user = await userRepository.findById(id);
    if (!user) throw unauthorized('用户不存在');
    if (user.status !== 'ACTIVE') throw forbidden('账号已停用');

    request.currentUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    };
  });

  app.decorate('authorize', (...permissions: string[]) => async (request: FastifyRequest) => {
    const user = request.currentUser;
    if (!user) throw unauthorized();
    for (const permission of permissions) {
      if (!can(user.role, permission)) {
        throw forbidden(`需要 ${permission} 权限，当前角色为 ${user.role}`);
      }
    }
  });
};

export const authPlugin = fp(authPluginImpl, { name: 'dw-auth' });
