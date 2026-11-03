import type { FastifyRequest } from 'fastify';
import type { CurrentUser } from '../plugins/auth.js';

/** 统一的「操作者」提取，供审计日志使用 */
export function actorOf(request: FastifyRequest): { id: number | null; username: string } {
  const u = request.currentUser as CurrentUser | undefined;
  return { id: u?.id ?? null, username: u?.displayName ?? u?.username ?? 'system' };
}
