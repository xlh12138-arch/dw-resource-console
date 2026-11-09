import {
  dictDeleteSchema,
  dictQuerySchema,
  dictReferencesSchema,
  dictSyncAttrsResultSchema,
  dictSyncAttrsSchema,
  dictSyncResultSchema,
  environmentDictCreateSchema,
  environmentDictSchema,
  environmentDictUpdateSchema,
  environmentMutationSchema,
  resourceTypeCreateSchema,
  resourceTypeCodeSyncResultSchema,
  resourceTypeDetailSchema,
  resourceTypeMutationSchema,
  resourceTypeSchema,
  resourceTypeUpdateSchema,
} from '@dw/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf } from '../../lib/actor.js';
import { withTransaction } from '../../db/index.js';
import { environmentService, resourceTypeService } from './service.js';

const idParams = z.object({ code: z.string().min(1).max(40) });

/**
 * 资源类型字典：可在页面新增 / 修改 / 删除。
 * 修改编码或删除时若已被引用，返回 409 + 引用明细，前端可带 sync / migrateTo 一键同步。
 */
export const resourceTypeRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: app.authenticate };
  const write = { preHandler: [app.authenticate, app.authorize('resource:write')] };
  const drop = { preHandler: [app.authenticate, app.authorize('resource:delete')] };

  app.get(
    '/resource-types',
    {
      ...read,
      schema: { querystring: dictQuerySchema, response: { 200: z.array(resourceTypeSchema) } },
    },
    async (request) => resourceTypeService.list(request.query.includeDisabled ?? true),
  );

  app.get(
    '/resource-types/options',
    {
      ...read,
      schema: {
        response: {
          200: z.array(z.object({ value: z.string(), label: z.string(), prefix: z.string() })),
        },
      },
    },
    async () => {
      const list = await resourceTypeService.list(false);
      return list.map((t) => ({ value: t.code, label: t.label, prefix: t.prefix }));
    },
  );

  app.post(
    '/resource-types',
    {
      ...write,
      schema: { body: resourceTypeCreateSchema, response: { 201: resourceTypeMutationSchema } },
    },
    async (request, reply) => {
      const detail = await withTransaction(() =>
        resourceTypeService.create(request.body, actorOf(request), request.id),
      );
      return reply.code(201).send({
        detail,
        sync: null,
        resourceCodeSynced: 0,
        pendingAttrSync: 0,
        references: await resourceTypeService.references(detail.code),
      });
    },
  );

  app.get(
    '/resource-types/:code',
    { ...read, schema: { params: idParams, response: { 200: resourceTypeDetailSchema } } },
    async (request) => resourceTypeService.get(request.params.code),
  );

  app.get(
    '/resource-types/:code/references',
    { ...read, schema: { params: idParams, response: { 200: dictReferencesSchema } } },
    async (request) => resourceTypeService.references(request.params.code),
  );

  app.patch(
    '/resource-types/:code',
    {
      ...write,
      schema: {
        params: idParams,
        body: resourceTypeUpdateSchema,
        response: { 200: resourceTypeMutationSchema },
      },
    },
    async (request) => {
      const { detail, sync, resourceCodeSynced, pendingAttrSync } = await withTransaction(() =>
        resourceTypeService.update(request.params.code, request.body, actorOf(request), request.id),
      );
      const references = await resourceTypeService.references(detail.code);
      return { detail, sync, resourceCodeSynced, pendingAttrSync, references };
    },
  );

  app.post(
    '/resource-types/:code/sync-attrs',
    {
      ...write,
      schema: {
        params: idParams,
        body: dictSyncAttrsSchema,
        response: { 200: dictSyncAttrsResultSchema },
      },
    },
    async (request) => {
      const updated = await withTransaction(() =>
        resourceTypeService.syncAttrs(request.params.code, {
          keyRenames: request.body.keyRenames,
          dropUnknown: request.body.dropUnknown,
        }),
      );
      const pending = await resourceTypeService.pendingAttrSyncCount(request.params.code);
      return { updated, pending };
    },
  );

  app.post(
    '/resource-types/:code/sync-resource-codes',
    {
      ...write,
      schema: { params: idParams, response: { 200: resourceTypeCodeSyncResultSchema } },
    },
    async (request) =>
      withTransaction(() =>
        resourceTypeService.syncResourceCodes(request.params.code, actorOf(request), request.id),
      ),
  );

  app.delete(
    '/resource-types/:code',
    {
      ...drop,
      schema: {
        params: idParams,
        body: dictDeleteSchema.nullable().optional(),
        response: { 200: dictSyncResultSchema },
      },
    },
    async (request) =>
      withTransaction(() =>
        resourceTypeService.remove(
          request.params.code,
          request.body?.migrateTo ?? undefined,
          actorOf(request),
          request.id,
        ),
      ),
  );
};

/** 环境字典：不再固定为生产 / 准生产 / 开发测试，可自定义 */
export const environmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: app.authenticate };
  const write = { preHandler: [app.authenticate, app.authorize('resource:write')] };
  const drop = { preHandler: [app.authenticate, app.authorize('resource:delete')] };

  app.get(
    '/environments',
    {
      ...read,
      schema: { querystring: dictQuerySchema, response: { 200: z.array(environmentDictSchema) } },
    },
    async (request) => environmentService.list(request.query.includeDisabled ?? true),
  );

  app.get(
    '/environments/options',
    {
      ...read,
      schema: {
        response: {
          200: z.array(z.object({ value: z.string(), label: z.string(), tone: z.string() })),
        },
      },
    },
    async () => {
      const list = await environmentService.list(false);
      return list.map((e) => ({ value: e.code, label: e.label, tone: e.tone }));
    },
  );

  app.post(
    '/environments',
    {
      ...write,
      schema: { body: environmentDictCreateSchema, response: { 201: environmentMutationSchema } },
    },
    async (request, reply) => {
      const detail = await withTransaction(() =>
        environmentService.create(request.body, actorOf(request), request.id),
      );
      return reply
        .code(201)
        .send({ detail, sync: null, references: null, pendingNameSync: 0, nameSynced: 0 });
    },
  );

  app.get(
    '/environments/:code/references',
    { ...read, schema: { params: idParams, response: { 200: dictReferencesSchema } } },
    async (request) => environmentService.references(request.params.code),
  );

  app.patch(
    '/environments/:code',
    {
      ...write,
      schema: {
        params: idParams,
        body: environmentDictUpdateSchema,
        response: { 200: environmentMutationSchema },
      },
    },
    async (request) => {
      const { detail, sync, pendingNameSync, nameSynced } = await withTransaction(() =>
        environmentService.update(request.params.code, request.body, actorOf(request), request.id),
      );
      const references = await environmentService.references(detail.code);
      return { detail, sync, references, pendingNameSync, nameSynced };
    },
  );

  app.delete(
    '/environments/:code',
    {
      ...drop,
      schema: {
        params: idParams,
        body: dictDeleteSchema.nullable().optional(),
        response: { 200: dictSyncResultSchema },
      },
    },
    async (request) =>
      withTransaction(() =>
        environmentService.remove(
          request.params.code,
          request.body?.migrateTo ?? undefined,
          actorOf(request),
          request.id,
        ),
      ),
  );
};
