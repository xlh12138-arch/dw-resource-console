import {
  bulkDeleteUserResultSchema,
  bulkResetPasswordResultSchema,
  bulkUserStatusResultSchema,
  createUserSchema,
  pagedSchema,
  resetPasswordResultSchema,
  updateUserSchema,
  userIdsSchema,
  userImportResultSchema,
  userImportSchema,
  userSchema,
} from '@dw/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf } from '../../lib/actor.js';
import { withTransaction } from '../../db/index.js';
import { userService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const adminGuard = { preHandler: [app.authenticate, app.authorize('user:manage')] };

  app.get(
    '/users',
    { ...adminGuard, schema: { response: { 200: pagedSchema(userSchema) } } },
    async () => {
      const items = await userService.list();
      return {
        items,
        meta: { page: 1, pageSize: items.length, total: items.length, totalPages: 1 },
      };
    },
  );

  app.post(
    '/users',
    { ...adminGuard, schema: { body: createUserSchema, response: { 201: userSchema } } },
    async (request, reply) => {
      const created = await withTransaction(() =>
        userService.create(request.body, actorOf(request), request.id),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/users/:id',
    {
      ...adminGuard,
      schema: { params: idParams, body: updateUserSchema, response: { 200: userSchema } },
    },
    async (request) =>
      withTransaction(() =>
        userService.update(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.delete(
    '/users/:id',
    {
      ...adminGuard,
      schema: {
        params: idParams,
        response: { 200: z.object({ id: z.number().int().positive() }) },
      },
    },
    async (request) =>
      withTransaction(() => userService.remove(request.params.id, actorOf(request), request.id)),
  );

  app.post(
    '/users/:id/reset-password',
    { ...adminGuard, schema: { params: idParams, response: { 200: resetPasswordResultSchema } } },
    async (request) =>
      withTransaction(() =>
        userService.resetPassword(request.params.id, actorOf(request), request.id),
      ),
  );

  /*
   * 批量接口：全部成功或全部回滚。
   * 一次事务内逐条处理，任意一条失败即抛错，withTransaction 回滚此前所有写入
   * （含审计日志），前端只会看到「本次操作未生效」。
   */

  app.post(
    '/users/bulk/status',
    {
      ...adminGuard,
      schema: {
        body: userIdsSchema.extend({ status: z.enum(['ACTIVE', 'DISABLED']) }),
        response: { 200: bulkUserStatusResultSchema },
      },
    },
    async (request) =>
      withTransaction(() =>
        userService.bulkSetStatus(
          request.body.ids,
          request.body.status,
          actorOf(request),
          request.id,
        ),
      ),
  );

  app.post(
    '/users/bulk/reset-password',
    {
      ...adminGuard,
      schema: { body: userIdsSchema, response: { 200: bulkResetPasswordResultSchema } },
    },
    async (request) =>
      withTransaction(() =>
        userService.bulkResetPassword(request.body.ids, actorOf(request), request.id),
      ),
  );

  app.post(
    '/users/bulk/delete',
    {
      ...adminGuard,
      schema: { body: userIdsSchema, response: { 200: bulkDeleteUserResultSchema } },
    },
    async (request) =>
      withTransaction(() => userService.bulkRemove(request.body.ids, actorOf(request), request.id)),
  );

  app.post(
    '/users/import',
    {
      ...adminGuard,
      schema: { body: userImportSchema, response: { 200: userImportResultSchema } },
    },
    async (request) =>
      withTransaction(() =>
        userService.importUsers(request.body.rows, actorOf(request), request.id),
      ),
  );
};
