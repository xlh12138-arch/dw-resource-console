import {
  bulkDeleteResultSchema,
  bulkDeleteSchema,
  importResultSchema,
  ipCheckResultSchema,
  pagedSchema,
  resourceChildSchema,
  resourceCreateSchema,
  resourceDetailSchema,
  resourceImportSchema,
  resourceQuerySchema,
  resourceSchema,
  resourceTimelineSchema,
  resourceUpdateSchema,
} from '@dw/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf } from '../../lib/actor.js';
import { withTransaction } from '../../db/index.js';
import { auditRepository } from '../audit/repository.js';
import { resourceRepository } from './repository.js';
import { resourceService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export const resourceRoutes: FastifyPluginAsyncZod = async (app) => {
  const guard = { preHandler: app.authenticate };
  const writeGuard = { preHandler: [app.authenticate, app.authorize('resource:write')] };

  app.get(
    '/resources',
    {
      ...guard,
      schema: {
        querystring: resourceQuerySchema,
        response: { 200: pagedSchema(resourceSchema) },
      },
    },
    async (request) => resourceService.list(request.query),
  );

  app.get(
    '/resources/check-ip',
    {
      ...guard,
      schema: { querystring: z.object({ ip: z.string() }), response: { 200: ipCheckResultSchema } },
    },
    async (request) => resourceService.checkIp(request.query.ip),
  );

  app.get(
    '/resources/export',
    { ...guard, schema: { querystring: resourceQuerySchema } },
    async (request, reply) => {
      const csv = await resourceService.exportCsv(request.query);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="resources.csv"')
        .send(csv);
    },
  );

  /** 标签清单：台账筛选下拉与概览标签云 */
  app.get(
    '/resources/tags',
    {
      ...guard,
      schema: { response: { 200: z.array(z.object({ tag: z.string(), count: z.number().int() })) } },
    },
    async () => resourceRepository.tagCounts(),
  );

  app.post(
    '/resources/import',
    {
      preHandler: [app.authenticate, app.authorize('resource:write')],
      schema: { body: resourceImportSchema, response: { 200: importResultSchema } },
    },
    async (request) => resourceService.importCsv(request.body, actorOf(request), request.id),
  );

  app.post(
    '/resources/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('resource:delete')],
      schema: { body: bulkDeleteSchema, response: { 200: bulkDeleteResultSchema } },
    },
    async (request) =>
      withTransaction(() => resourceService.bulkRemove(request.body.ids, actorOf(request), request.id)),
  );

  // 详情：在资源 DTO 之上补充容量明细与「被哪些项目/环境引用」
  app.get(
    '/resources/:id',
    { ...guard, schema: { params: idParams, response: { 200: resourceDetailSchema } } },
    async (request) => resourceService.get(request.params.id),
  );

  app.get(
    '/resources/:id/audit',
    {
      ...guard,
      schema: {
        params: idParams,
        response: { 200: z.array(z.object({ action: z.string(), actorName: z.string(), createdAt: z.string(), changes: z.unknown() })) },
      },
    },
    async (request) => {
      const logs = await auditRepository.listByTarget('RESOURCE', String(request.params.id));
      return logs.map((l) => ({
        action: l.action,
        actorName: l.actorName,
        createdAt: new Date(l.createdAt).toISOString(),
        changes: l.changes,
      }));
    },
  );

  /** 子资源清单：父资源详情里直接展示，也支持单独查询 */
  app.get(
    '/resources/:id/children',
    { ...guard, schema: { params: idParams, response: { 200: z.array(resourceChildSchema) } } },
    async (request) => (await resourceService.get(request.params.id)).children,
  );

  /** 资源占用时间轴：跨项目 / 跨环境，含超期与区间重叠（共用） */
  app.get(
    '/resources/:id/timeline',
    { ...guard, schema: { params: idParams, response: { 200: resourceTimelineSchema } } },
    async (request) => resourceService.timeline(request.params.id),
  );

  app.post(
    '/resources',
    {
      ...writeGuard,
      schema: { body: resourceCreateSchema, response: { 201: resourceSchema } },
    },
    async (request, reply) => {
      const created = await withTransaction(() =>
        resourceService.create(request.body, actorOf(request), request.id),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/resources/:id',
    {
      ...writeGuard,
      schema: { params: idParams, body: resourceUpdateSchema, response: { 200: resourceSchema } },
    },
    async (request) =>
      withTransaction(() =>
        resourceService.update(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.delete(
    '/resources/:id',
    {
      preHandler: [app.authenticate, app.authorize('resource:delete')],
      schema: { params: idParams, response: { 200: z.object({ id: z.number() }) } },
    },
    async (request) =>
      withTransaction(() => resourceService.remove(request.params.id, actorOf(request), request.id)),
  );

  /** 供前端表单使用的「同类型已有资源」下拉（如 GDS 上游节点选择） */
  app.get(
    '/resources/:type/options',
    {
      ...guard,
      schema: {
        params: z.object({ type: z.enum(['BATCH_SCHED_SERVER', 'BATCH_SCHED_PLATFORM_IP', 'COLLECT_EXCHANGE_PLATFORM_IP', 'NAS', 'GDS_SERVER']) }),
        response: { 200: z.array(z.object({ code: z.string(), name: z.string() })) },
      },
    },
    async (request) => {
      const rows = await resourceRepository.listAll({ type: request.params.type });
      return rows.map((r) => ({ code: r.code, name: r.name }));
    },
  );
};
