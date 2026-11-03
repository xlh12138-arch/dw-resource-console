import { AppError } from '../lib/errors.js';
import fp from 'fastify-plugin';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * 把校验失败明细整理成「字段：原因」的可读列表。
 * 同时兼容 Zod 原始 issue（instancePath / path）与业务校验（field）两种结构。
 */
type Issue = { field: string; message: string };

function collectIssues(validation: unknown): Issue[] {
  const list = Array.isArray(validation) ? validation : [];
  const out: Issue[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const raw =
      typeof item.field === 'string'
        ? item.field
        : Array.isArray(item.path)
          ? item.path.join('.')
          : typeof item.instancePath === 'string'
            ? item.instancePath
            : '';
    const field = raw.replace(/^\//, '').replace(/\//g, '.').replace(/^(body|params|querystring|query)\./, '');
    const message = typeof item.message === 'string' ? item.message : '校验失败';
    out.push({ field: field || ('attrs' in item ? 'attrs' : ''), message });
  }
  return out;
}

function readableValidationMessage(issues: Issue[]): string {
  if (issues.length === 0) return '请求参数校验失败';
  const shown = issues.slice(0, 3).map((i) => (i.field ? `${i.field}：${i.message}` : i.message));
  const rest = issues.length > shown.length ? ` 等 ${issues.length} 项` : '';
  return `请求参数校验失败：${shown.join('；')}${rest}`;
}

const errorHandlerImpl: FastifyPluginAsyncZod = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, requestId }, error.message);
      } else {
        request.log.warn({ code: error.code, requestId }, error.message);
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          requestId,
        },
      });
    }

    const anyError = error as { statusCode?: number; validation?: unknown; code?: string };

    if (anyError.validation) {
      const issues = collectIssues(anyError.validation);
      const message = readableValidationMessage(issues);
      request.log.warn({ requestId, issues }, '请求参数校验失败');
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message,
          details: { issues, raw: anyError.validation },
          requestId,
        },
      });
    }

    if (anyError.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: '操作过于频繁，请稍后再试', requestId },
      });
    }

    const statusCode = typeof anyError.statusCode === 'number' ? anyError.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    request.log.error({ err: error, requestId }, '未处理异常');
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? 'INTERNAL' : 'BAD_REQUEST',
        message: statusCode === 500 ? '服务内部错误，请联系管理员' : message,
        requestId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `接口不存在: ${request.method} ${request.url}`, requestId: request.id },
    }),
  );
};

/** fp 打破封装：错误处理器必须对根作用域及所有路由生效 */
export const errorHandlerPlugin = fp(errorHandlerImpl, { name: 'dw-error-handler' });
