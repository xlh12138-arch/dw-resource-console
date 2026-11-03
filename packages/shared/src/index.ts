export * from './enums.js';
export * from './schemas.js';

/** 统一的错误响应结构：前端只消费 code + message，绝不暴露堆栈 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function isApiError(e: unknown): e is { error: { code: string; message: string } } {
  return typeof e === 'object' && e !== null && 'error' in e;
}
