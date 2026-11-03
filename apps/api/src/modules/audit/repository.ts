import type { AuditAction, AuditTargetType } from '@dw/shared';
import { and, asc, count, desc, eq, like } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { auditLogs, type AuditLogRow } from '../../db/schema.js';
import type { z } from 'zod';
import type { auditQuerySchema } from '@dw/shared';

export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AuditChange = { field: string; label?: string; from: unknown; to: unknown };

export const auditRepository = {
  async record(entry: {
    actorId: number | null;
    actorName: string;
    action: AuditAction;
    targetType: AuditTargetType;
    targetId?: string | null;
    targetName?: string | null;
    changes?: AuditChange[] | null;
    requestId?: string | null;
  }): Promise<void> {
    await db.insert(auditLogs).values({
      actorId: entry.actorId,
      actorName: entry.actorName,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      targetName: entry.targetName ?? null,
      changes: entry.changes ?? null,
      requestId: entry.requestId ?? null,
      createdAt: new Date(),
    });
  },

  async list(q: AuditQuery): Promise<{ items: AuditLogRow[]; total: number; totalPages: number }> {
    const clauses = [];
    if (q.targetType) clauses.push(eq(auditLogs.targetType, q.targetType));
    if (q.targetId) clauses.push(eq(auditLogs.targetId, q.targetId));
    if (q.actor) clauses.push(like(auditLogs.actorName, `%${q.actor}%`));
    if (q.action) clauses.push(eq(auditLogs.action, q.action));
    const where = clauses.length ? and(...clauses) : undefined;

    const [{ value: total }] = await db.select({ value: count() }).from(auditLogs).where(where);
    const items = await db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
  },

  listByTarget(targetType: AuditTargetType, targetId: string): Promise<AuditLogRow[]> {
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, targetType), eq(auditLogs.targetId, targetId)))
      .orderBy(asc(auditLogs.createdAt));
  },
};
