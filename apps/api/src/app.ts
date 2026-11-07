import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from './config/env.js';
import { execSql } from './db/index.js';
import { newRequestId } from './lib/password.js';
import { authRoutes } from './modules/auth/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { environmentRoutes, resourceTypeRoutes } from './modules/dict/routes.js';
import { metaRoutes } from './modules/meta/routes.js';
import { bulkAssignRoutes, projectRoutes, templateRoutes } from './modules/projects/routes.js';
import { resourceRoutes } from './modules/resources/routes.js';
import { statsRoutes } from './modules/stats/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { securityPlugin } from './plugins/security.js';
import { sql } from 'drizzle-orm';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.log.level,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      transport: config.isProd
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    genReqId: () => newRequestId(),
    trustProxy: config.server.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod 即校验器也即序列化器：一份 schema 同时用于校验、OpenAPI 与响应裁剪
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin);
  // 刷新令牌以 httpOnly Cookie 下发：页面刷新后可凭 Cookie 静默续期，无需重新登录
  await app.register(cookie);
  await app.register(authPlugin);

  await app.register(swagger, {
    openapi: {
      info: {
        title: '数据仓库资源控制台 API',
        version: '0.1.0',
        description:
          '统一管理批量调度服务器、批量调度平台IP、采集交换平台IP、NAS 与 GDS 服务器的资源台账服务，' +
          '支持按需求项目建立多套环境，并通过环境模板一键套用资源组合。',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  /* ------------------ 健康检查（不鉴权，供 K8s / 监控探针使用） ------------------ */
  const healthSchema = {
    response: {
      200: z.object({
        status: z.string(),
        uptimeSeconds: z.number(),
        timestamp: z.string(),
      }),
      503: z.object({
        status: z.string(),
        uptimeSeconds: z.number(),
        timestamp: z.string(),
      }),
    },
  };

  app.get('/health', { schema: healthSchema }, async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', { schema: healthSchema }, async (_request, reply) => {
    const payload = () => ({
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
    try {
      await execSql(sql`select 1 as ok`);
      return { status: 'ready', ...payload() };
    } catch {
      return reply.code(503).send({ status: 'not-ready', ...payload() });
    }
  });

  /* ------------------ 业务路由 ------------------ */
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(metaRoutes);
      await v1.register(resourceTypeRoutes);
      await v1.register(environmentRoutes);
      await v1.register(resourceRoutes);
      await v1.register(bulkAssignRoutes);
      await v1.register(projectRoutes);
      await v1.register(templateRoutes);
      await v1.register(statsRoutes);
      await v1.register(auditRoutes);
      await v1.register(userRoutes);
    },
    { prefix: config.server.basePath },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
