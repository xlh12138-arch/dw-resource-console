import { createUserSchema, pagedSchema, resetPasswordResultSchema, updateUserSchema, userSchema } from '@dw/shared';
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
      return { items, meta: { page: 1, pageSize: items.length, total: items.length, totalPages: 1 } };
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
    { ...adminGuard, schema: { params: idParams, body: updateUserSchema, response: { 200: userSchema } } },
    async (request) =>
      withTransaction(() =>
        userService.update(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.post(
    '/users/:id/reset-password',
    { ...adminGuard, schema: { params: idParams, response: { 200: resetPasswordResultSchema } } },
    async (request) =>
      withTransaction(() => userService.resetPassword(request.params.id, actorOf(request), request.id)),
  );
};
