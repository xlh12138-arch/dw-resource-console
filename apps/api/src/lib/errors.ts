import type { ErrorCode } from '@dw/shared';

/**
 * 类型化错误体系：业务层只抛 AppError，全局错误处理器统一转成规范化 JSON，
 * 客户端永远不会看到堆栈或内部细节。
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = '请求参数不合法', details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = '未登录或令牌已失效') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = '当前角色无权执行该操作') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = '资源冲突', details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const validationError = (message = '参数校验失败', details?: unknown) =>
  new AppError(422, 'VALIDATION_ERROR', message, details);

export const internal = (message = '服务内部错误') => new AppError(500, 'INTERNAL', message);
