import type { Role, UserStatus } from '@dw/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, firstRow } from '../../db/index.js';
import { users, type UserRow } from '../../db/schema.js';

export const userRepository = {
  findByUsername(username: string): Promise<UserRow | undefined> {
    return firstRow<UserRow>(db.select().from(users).where(eq(users.username, username)));
  },

  findById(id: number): Promise<UserRow | undefined> {
    return firstRow<UserRow>(db.select().from(users).where(eq(users.id, id)));
  },

  list(): Promise<UserRow[]> {
    return db.select().from(users).orderBy(asc(users.id));
  },

  findByIds(ids: number[]): Promise<UserRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return db.select().from(users).where(inArray(users.id, ids));
  },

  /** 批量改状态；调用方负责事务，返回值不参与业务判断 */
  async updateStatusMany(ids: number[], status: UserStatus): Promise<void> {
    if (ids.length === 0) return;
    await db.update(users).set({ status, updatedAt: new Date() }).where(inArray(users.id, ids));
  },

  async create(values: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: Role;
    status?: UserStatus;
    /** 新建账号（管理员创建 / 导入 / 初始化）一律要求首次登录改密 */
    mustChangePassword?: boolean;
  }): Promise<UserRow> {
    const rows = await db.insert(users).values(values).returning();
    return rows[0]!;
  },

  async update(
    id: number,
    values: Partial<{
      displayName: string;
      role: Role;
      status: UserStatus;
      lastLoginAt: Date;
      mustChangePassword: boolean;
    }>,
  ): Promise<UserRow> {
    const rows = await db
      .update(users)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!rows[0]) throw new Error('用户不存在');
    return rows[0];
  },

  async count(): Promise<number> {
    const rows = await db.select().from(users);
    return rows.length;
  },

  async removeDisabled(id: number): Promise<boolean> {
    const rows = await db
      .delete(users)
      .where(and(eq(users.id, id), eq(users.status, 'DISABLED')))
      .returning({ id: users.id });
    return rows.length > 0;
  },

  async updatePassword(id: number, passwordHash: string): Promise<UserRow> {
    const rows = await db
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!rows[0]) throw new Error('用户不存在');
    return rows[0];
  },
};
