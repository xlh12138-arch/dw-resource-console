import {
  ATTR_FIELDS,
  RESOURCE_STATUSES,
  RESOURCE_STATUS_LABELS,
  ROLES,
  ROLE_LABELS,
  TYPE_COLUMNS,
} from '@dw/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { environmentService, resourceTypeService } from '../dict/service.js';
import { getTypeMeta, toAttrFieldDefs } from '../dict/validator.js';

const metaSchema = z.object({
  resourceTypes: z.array(z.object({ value: z.string(), label: z.string(), prefix: z.string() })),
  environments: z.array(z.object({ value: z.string(), label: z.string(), tone: z.string() })),
  statuses: z.array(z.object({ value: z.enum(RESOURCE_STATUSES), label: z.string() })),
  roles: z.array(z.object({ value: z.enum(ROLES), label: z.string() })),
  attrFields: z.record(z.string(), z.array(z.unknown())),
  typeColumns: z.record(z.string(), z.array(z.string())),
});

/**
 * 元数据接口：前端下拉框与动态表单的单一数据源。
 * 资源类型与环境均取自字典（可在「字典配置」页面维护），内置常量仅作兜底。
 */
export const metaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/meta',
    { preHandler: app.authenticate, schema: { response: { 200: metaSchema } } },
    async () => {
      const [types, envs] = await Promise.all([
        resourceTypeService.list(false),
        environmentService.list(false),
      ]);

      const attrFields: Record<string, unknown[]> = {};
      const typeColumns: Record<string, string[]> = {};
      for (const t of types) {
        const meta = await getTypeMeta(t.code);
        attrFields[t.code] =
          meta.fields.length > 0
            ? toAttrFieldDefs(meta.fields)
            : ((ATTR_FIELDS as unknown as Record<string, unknown[]>)[t.code] ?? []);
        typeColumns[t.code] =
          meta.listColumns.length > 0
            ? meta.listColumns
            : ((TYPE_COLUMNS as unknown as Record<string, string[]>)[t.code] ?? []);
      }

      return {
        resourceTypes: types.map((t) => ({ value: t.code, label: t.label, prefix: t.prefix })),
        environments: envs.map((e) => ({ value: e.code, label: e.label, tone: e.tone })),
        statuses: RESOURCE_STATUSES.map((s) => ({ value: s, label: RESOURCE_STATUS_LABELS[s] })),
        roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
        attrFields,
        typeColumns,
      };
    },
  );
};
