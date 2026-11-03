import { auditLogSchema, auditQuerySchema, pagedSchema } from '@dw/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auditRepository } from './repository.js';

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/audit-logs',
    {
      // 变更审计仅管理员可读（普通用户 / 只读用户一律 403）
      preHandler: [app.authenticate, app.authorize('audit:read')],
      schema: { querystring: auditQuerySchema, response: { 200: pagedSchema(auditLogSchema) } },
    },
    async (request) => {
      const { items, total, totalPages } = await auditRepository.list(request.query);
      return {
        items: items.map((l) => ({
          id: l.id,
          actorId: l.actorId ?? null,
          actorName: l.actorName,
          action: l.action,
          targetType: l.targetType,
          targetId: l.targetId ?? null,
          targetName: l.targetName ?? null,
          changes: (l.changes ?? null) as never,
          requestId: l.requestId ?? null,
          createdAt: new Date(l.createdAt).toISOString(),
        })),
        meta: {
          page: request.query.page,
          pageSize: request.query.pageSize,
          total,
          totalPages,
        },
      };
    },
  );
};
