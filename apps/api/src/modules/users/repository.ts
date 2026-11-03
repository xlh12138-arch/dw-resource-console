import type { Role, UserStatus } from '@dw/shared';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users, type UserRow } from '../../db/schema.js';

export const userRepository = {
  /** better-sqlite3 为同步驱动，.get() 直接返回行对象或 undefined */
  findByUsername(username: string): UserRow | undefined {
    return db.select().from(users).where(eq(users.username, username)).get();
  },

  findById(id: number): UserRow | undefined {
    return db.select().from(users).where(eq(users.id, id)).get();
  },

  list(): Promise<UserRow[]> {
    return db.select().from(users).orderBy(asc(users.id));
  },

  async create(values: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: Role;
    status?: UserStatus;
  }): Promise<UserRow> {
    return db.insert(users).values(values).returning().get();
  },

  async update(
    id: number,
    values: Partial<{ displayName: string; role: Role; status: UserStatus; lastLoginAt: Date }>,
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

  async updatePassword(id: number, passwordHash: string): Promise<UserRow> {
    const rows = await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!rows[0]) throw new Error('用户不存在');
    return rows[0];
  },
};
