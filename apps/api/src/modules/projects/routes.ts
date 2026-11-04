import {
  bulkAssignResultSchema,
  bulkAssignSchema,
  envSlotAssignSchema,
  envSlotCreateSchema,
  envSlotPeriodSchema,
  envSlotRenewSchema,
  envSlotSchema,
  envSlotUpdateSchema,
  envTimelineSchema,
  envTemplateCreateSchema,
  envTemplateDetailSchema,
  envTemplateQuerySchema,
  envTemplateSchema,
  envTemplateUpdateSchema,
  instantiateTemplateSchema,
  pagedSchema,
  projectCreateSchema,
  projectDetailSchema,
  projectEnvCreateSchema,
  projectDetachResultSchema,
  projectDetachSchema,
  projectEnvDetailSchema,
  projectEnvSchema,
  projectEnvUpdateSchema,
  projectQuerySchema,
  projectSchema,
  projectUpdateSchema,
  slotAssignWarningSchema,
  slotCandidatesSchema,
} from '@dw/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf } from '../../lib/actor.js';
import { withTransaction } from '../../db/index.js';
import { resourceService } from '../resources/service.js';
import { projectEnvService, projectService, templateService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const envIdParams = z.object({ id: z.coerce.number().int().positive() });
const slotParams = z.object({
  id: z.coerce.number().int().positive(),
  slotId: z.coerce.number().int().positive(),
});

/** 需求项目 + 项目环境（含槽位与模板套用） */
export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: app.authenticate };
  const write = { preHandler: [app.authenticate, app.authorize('resource:write')] };
  const drop = { preHandler: [app.authenticate, app.authorize('resource:delete')] };

  /* ------------------------------ 项目 ------------------------------ */

  app.get(
    '/projects',
    { ...read, schema: { querystring: projectQuerySchema, response: { 200: pagedSchema(projectSchema) } } },
    async (request) => projectService.list(request.query),
  );

  app.get(
    '/projects/options',
    { ...read, schema: { response: { 200: z.array(projectSchema) } } },
    async () => projectService.listOptions(),
  );

  app.post(
    '/projects',
    { ...write, schema: { body: projectCreateSchema, response: { 201: projectSchema } } },
    async (request, reply) => {
      const created = await withTransaction(() =>
        projectService.create(request.body, actorOf(request), request.id),
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/projects/:id',
    { ...read, schema: { params: idParams, response: { 200: projectDetailSchema } } },
    async (request) => projectService.get(request.params.id),
  );

  app.patch(
    '/projects/:id',
    { ...write, schema: { params: idParams, body: projectUpdateSchema, response: { 200: projectSchema } } },
    async (request) =>
      withTransaction(() =>
        projectService.update(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.delete(
    '/projects/:id',
    { ...drop, schema: { params: idParams, response: { 200: z.object({ id: z.number() }) } } },
    async (request) =>
      withTransaction(() => projectService.remove(request.params.id, actorOf(request), request.id)),
  );

  app.get(
    '/projects/:id/environments',
    { ...read, schema: { params: idParams, response: { 200: z.array(projectEnvSchema) } } },
    async (request) => projectEnvService.listByProject(request.params.id),
  );

  app.post(
    '/projects/:id/environments',
    {
      ...write,
      schema: {
        params: idParams,
        body: projectEnvCreateSchema.omit({ projectId: true }),
        response: { 201: projectEnvDetailSchema },
      },
    },
    async (request, reply) => {
      const created = await withTransaction(() =>
        projectEnvService.create(
          { ...request.body, projectId: request.params.id },
          actorOf(request),
          request.id,
        ),
      );
      return reply.code(201).send(created);
    },
  );

  /* 把资源移出项目：可一并解除该项目下所有环境槽位引用 */
  app.post(
    '/projects/:id/resources/:resourceId/detach',
    {
      ...write,
      schema: {
        params: z.object({ id: z.coerce.number().int().positive(), resourceId: z.coerce.number().int().positive() }),
        body: projectDetachSchema.default({ includeSlots: false }),
        response: { 200: projectDetachResultSchema },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectService.detach(
          request.params.id,
          request.params.resourceId,
          request.body?.includeSlots ?? false,
          actorOf(request),
          request.id,
        ),
      ),
  );

  /* --------------------------- 项目环境 --------------------------- */

  app.get(
    '/project-environments/:id',
    { ...read, schema: { params: envIdParams, response: { 200: projectEnvDetailSchema } } },
    async (request) => projectEnvService.get(request.params.id),
  );

  app.patch(
    '/project-environments/:id',
    {
      ...write,
      schema: { params: envIdParams, body: projectEnvUpdateSchema, response: { 200: projectEnvDetailSchema } },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.update(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.delete(
    '/project-environments/:id',
    { ...drop, schema: { params: envIdParams, response: { 200: z.object({ id: z.number() }) } } },
    async (request) =>
      withTransaction(() =>
        projectEnvService.remove(request.params.id, actorOf(request), request.id),
      ),
  );

  app.post(
    '/project-environments/:id/slots',
    {
      ...write,
      schema: { params: envIdParams, body: envSlotCreateSchema, response: { 200: projectEnvDetailSchema } },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.addSlots(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.patch(
    '/project-environments/:id/slots/:slotId',
    {
      ...write,
      schema: {
        params: slotParams,
        body: envSlotUpdateSchema,
        response: { 200: z.object({ slot: envSlotSchema, env: projectEnvDetailSchema }) },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.updateSlot(
          request.params.id,
          request.params.slotId,
          request.body,
          actorOf(request),
          request.id,
        ),
      ),
  );

  /** 候选资源：放开环境限制并标注跨环境 / 已被占用 / 时间重叠 / 容量余量，供绑定前提示 */
  app.get(
    '/project-environments/:id/slots/:slotId/candidates',
    {
      ...read,
      schema: {
        params: slotParams,
        querystring: z.object({
          startAt: z.string().optional(),
          endAt: z.string().optional(),
        }),
        response: { 200: slotCandidatesSchema },
      },
    },
    async (request) =>
      projectEnvService.slotCandidates(request.params.id, request.params.slotId, {
        startAt: request.query.startAt ?? null,
        endAt: request.query.endAt ?? null,
      }),
  );

  app.post(
    '/project-environments/:id/slots/:slotId/assign',
    {
      ...write,
      schema: {
        params: slotParams,
        body: envSlotAssignSchema,
        response: {
          200: z.object({ slot: envSlotSchema, env: projectEnvDetailSchema, warnings: z.array(slotAssignWarningSchema) }),
        },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.assignSlot(
          request.params.id,
          request.params.slotId,
          request.body,
          actorOf(request),
          request.id,
        ),
      ),
  );

  /** 续期：延长占用结束时间，或 endAt=null 转为长期占用 */
  app.post(
    '/project-environments/:id/slots/:slotId/renew',
    {
      ...write,
      schema: {
        params: slotParams,
        body: envSlotRenewSchema,
        response: {
          200: z.object({
            slot: envSlotSchema,
            env: projectEnvDetailSchema,
            message: z.string(),
          }),
        },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.renewSlot(
          request.params.id,
          request.params.slotId,
          request.body,
          actorOf(request),
          request.id,
        ),
      ),
  );

  /** 释放：立即释放占用（含容量），槽位保留可再次分配 */
  app.post(
    '/project-environments/:id/slots/:slotId/release',
    {
      ...write,
      schema: {
        params: slotParams,
        response: { 200: z.object({ slot: envSlotSchema, env: projectEnvDetailSchema }) },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.releaseSlot(
          request.params.id,
          request.params.slotId,
          actorOf(request),
          request.id,
        ),
      ),
  );

  /** 调整占用期限（不改变绑定关系） */
  app.patch(
    '/project-environments/:id/slots/:slotId/period',
    {
      ...write,
      schema: {
        params: slotParams,
        body: envSlotPeriodSchema,
        response: { 200: z.object({ slot: envSlotSchema, env: projectEnvDetailSchema }) },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.updateSlotPeriod(
          request.params.id,
          request.params.slotId,
          request.body,
          actorOf(request),
          request.id,
        ),
      ),
  );

  /** 环境占用时间轴：按区间展示各槽位的占用与共用情况 */
  app.get(
    '/project-environments/:id/timeline',
    { ...read, schema: { params: envIdParams, response: { 200: envTimelineSchema } } },
    async (request) => projectEnvService.timeline(request.params.id),
  );

  app.delete(
    '/project-environments/:id/slots/:slotId/assign',
    {
      ...write,
      schema: {
        params: slotParams,
        response: { 200: z.object({ slot: envSlotSchema, env: projectEnvDetailSchema }) },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.unassignSlot(
          request.params.id,
          request.params.slotId,
          actorOf(request),
          request.id,
        ),
      ),
  );

  // 删除槽位属于环境日常维护，写权限即可（不需要删除资源的权限）
  app.delete(
    '/project-environments/:id/slots/:slotId',
    { ...write, schema: { params: slotParams, response: { 200: projectEnvDetailSchema } } },
    async (request) =>
      withTransaction(() =>
        projectEnvService.removeSlot(
          request.params.id,
          request.params.slotId,
          actorOf(request),
          request.id,
        ),
      ),
  );

  app.post(
    '/project-environments/:id/apply-template',
    {
      ...write,
      schema: {
        params: envIdParams,
        body: z.object({ templateId: z.coerce.number().int().positive() }),
        response: { 200: projectEnvDetailSchema },
      },
    },
    async (request) =>
      withTransaction(() =>
        projectEnvService.applyTemplate(
          request.params.id,
          request.body.templateId,
          actorOf(request),
          request.id,
        ),
      ),
  );
};

/* --------------------------- 模板路由 --------------------------- */

export const templateRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: app.authenticate };
  const write = { preHandler: [app.authenticate, app.authorize('resource:write')] };
  const drop = { preHandler: [app.authenticate, app.authorize('resource:delete')] };

  app.get(
    '/env-templates',
    { ...read, schema: { querystring: envTemplateQuerySchema, response: { 200: pagedSchema(envTemplateSchema) } } },
    async (request) => templateService.list(request.query),
  );

  app.get(
    '/env-templates/options',
    { ...read, schema: { response: { 200: z.array(envTemplateSchema) } } },
    async () => templateService.listOptions(),
  );

  app.post(
    '/env-templates',
    { ...write, schema: { body: envTemplateCreateSchema, response: { 201: envTemplateDetailSchema } } },
    async (request, reply) => {
      const created = await withTransaction(() =>
        templateService.create(request.body, actorOf(request), request.id),
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/env-templates/:id',
    { ...read, schema: { params: idParams, response: { 200: envTemplateDetailSchema } } },
    async (request) => templateService.get(request.params.id),
  );

  app.patch(
    '/env-templates/:id',
    {
      ...write,
      schema: { params: idParams, body: envTemplateUpdateSchema, response: { 200: envTemplateDetailSchema } },
    },
    async (request) =>
      withTransaction(() =>
        templateService.update(request.params.id, request.body, actorOf(request), request.id),
      ),
  );

  app.delete(
    '/env-templates/:id',
    { ...drop, schema: { params: idParams, response: { 200: z.object({ id: z.number() }) } } },
    async (request) =>
      withTransaction(() => templateService.remove(request.params.id, actorOf(request), request.id)),
  );

  app.post(
    '/env-templates/:id/clone',
    { ...write, schema: { params: idParams, response: { 201: envTemplateDetailSchema } } },
    async (request, reply) => {
      const cloned = await withTransaction(() =>
        templateService.clone(request.params.id, actorOf(request), request.id),
      );
      return reply.code(201).send(cloned);
    },
  );

  app.post(
    '/env-templates/:id/instantiate',
    {
      ...write,
      schema: { params: idParams, body: instantiateTemplateSchema, response: { 201: projectEnvDetailSchema } },
    },
    async (request, reply) => {
      const env = await withTransaction(() =>
        templateService.instantiate(request.params.id, request.body, actorOf(request), request.id),
      );
      return reply.code(201).send(env);
    },
  );
};

/** 资源批量标注项目 */
export const bulkAssignRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/resources/bulk-assign',
    {
      preHandler: [app.authenticate, app.authorize('resource:write')],
      schema: { body: bulkAssignSchema, response: { 200: bulkAssignResultSchema } },
    },
    async (request) =>
      withTransaction(() => resourceService.bulkAssign(request.body, actorOf(request), request.id)),
  );
};
