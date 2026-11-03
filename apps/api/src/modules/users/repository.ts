import type { Role, UserStatus } from '@dw/shared';
import { asc, eq } from 'drizzle-orm';
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

  async create(values: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: Role;
    status?: UserStatus;
  }): Promise<UserRow> {
    const rows = await db.insert(users).values(values).returning();
    return rows[0]!;
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
