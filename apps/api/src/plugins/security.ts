import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../config/env.js';

/** 安全基线：安全头 + 显式 CORS 来源 + 限流 */
const securityImpl: FastifyPluginAsyncZod = async (app) => {
  await app.register(helmet, {
    contentSecurityPolicy: config.isProd,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // 允许同源 / curl / 服务端直连（origin 为空）
      if (!origin) return cb(null, true);
      if (config.cors.origins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
    // 只使用 Fastify 按 TRUST_PROXY 配置解析后的地址。绝不能把客户端请求头
    // 再次拼进 key，否则攻击者可轮换 X-Forwarded-For 绕过限流。
    keyGenerator: (request) => request.ip,
  });
};

export const securityPlugin = fp(securityImpl, { name: 'dw-security' });
