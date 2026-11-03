import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../../config/env.js';
import { db } from '../../db/index.js';
import { refreshTokens, type UserRow } from '../../db/schema.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { hashPassword, randomToken, verifyPassword } from '../../lib/password.js';
import { auditRepository } from '../audit/repository.js';
import { userRepository } from '../users/repository.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type TokenSigner = (user: Pick<UserRow, 'id' | 'username' | 'role'>) => string;

export function toUserDto(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

export const authService = {
  /**
   * 老库兼容：早期版本的 VIEWER 归为 READONLY，OPERATOR 及其他未知值归为 USER。
   * 幂等，每次启动执行一次即可（无旧数据时 changes 为 0）。
   */
  async normalizeLegacyRoles(): Promise<number> {
    const viewerResult = await db.run(
      sql`UPDATE users SET role = 'READONLY' WHERE role = 'VIEWER'`,
    );
    const otherResult = await db.run(
      sql`UPDATE users SET role = 'USER' WHERE role NOT IN ('ADMIN', 'USER', 'READONLY')`,
    );
    const changed = Number(viewerResult.changes ?? 0) + Number(otherResult.changes ?? 0);
    if (changed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[auth] 已归一 ${changed} 个历史账号的角色（VIEWER → READONLY，其余旧值 → USER）`,
      );
    }
    return changed;
  },

  /** 首次启动时创建管理员、普通用户与只读用户，避免"装好没法登录" */
  async ensureBootstrapAdmin(): Promise<void> {
    await this.normalizeLegacyRoles();
    const count = await userRepository.count();
    if (count > 0) return;
    const passwordHash = await hashPassword(config.auth.bootstrapAdmin.password);
    await userRepository.create({
      username: config.auth.bootstrapAdmin.username,
      displayName: '系统管理员',
      passwordHash,
      role: 'ADMIN',
    });
    await userRepository.create({
      username: 'user',
      displayName: '普通用户',
      passwordHash: await hashPassword('User@12345'),
      role: 'USER',
    });
    await userRepository.create({
      username: 'readonly',
      displayName: '只读用户',
      passwordHash: await hashPassword('Readonly@12345'),
      role: 'READONLY',
    });
    // eslint-disable-next-line no-console
    console.log(
      `[auth] 已初始化默认账号：${config.auth.bootstrapAdmin.username} / ${config.auth.bootstrapAdmin.password}（ADMIN），user / User@12345（USER），readonly / Readonly@12345（READONLY）`,
    );
  },

  /** 重置密码后吊销该用户全部刷新令牌，强制其重新登录 */
  async revokeAllRefreshTokens(userId: number): Promise<void> {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  },

  async login(
    username: string,
    password: string,
    ctx: { signAccessToken: TokenSigner; userAgent?: string; requestId?: string; ip?: string },
  ) {
    const user = await userRepository.findByUsername(username);
    // 用户不存在时也执行一次哈希校验，避免时序差异泄露账号是否存在
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, 'scrypt$00$00');
    if (!user || !ok) throw unauthorized('用户名或密码错误');
    if (user.status !== 'ACTIVE') throw forbidden('账号已停用，请联系管理员');

    const accessToken = ctx.signAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user.id, ctx.userAgent);
    await userRepository.update(user.id, { lastLoginAt: new Date() });

    await auditRepository.record({
      actorId: user.id,
      actorName: user.displayName,
      action: 'LOGIN',
      targetType: 'AUTH',
      targetName: user.username,
      changes: [{ field: 'ip', label: '来源 IP', from: null, to: ctx.ip ?? null }],
      requestId: ctx.requestId ?? null,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: config.auth.accessTokenTtlSeconds,
      user: toUserDto(user),
    };
  },

  async issueRefreshToken(userId: number, userAgent?: string): Promise<string> {
    const token = randomToken(48);
    await db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000),
      userAgent: userAgent ?? null,
    });
    return token;
  },

  /** 刷新令牌轮换：旧令牌立即吊销，防止重放 */
  async refresh(token: string, ctx: { signAccessToken: TokenSigner; userAgent?: string }) {
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
    if (!row) throw unauthorized('刷新令牌无效，请重新登录');
    if (row.expiresAt.getTime() < Date.now()) throw unauthorized('刷新令牌已过期，请重新登录');

    const user = await userRepository.findById(row.userId);
    if (!user || user.status !== 'ACTIVE') throw unauthorized('账号不可用，请重新登录');

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));

    const refreshToken = await this.issueRefreshToken(user.id, ctx.userAgent);
    return {
      accessToken: ctx.signAccessToken(user),
      refreshToken,
      expiresIn: config.auth.accessTokenTtlSeconds,
      user: toUserDto(user),
    };
  },

  async logout(token: string | undefined, actor: { id: number | null; username: string }) {
    if (!token) return { success: true };
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, sha256(token)));
    if (row) {
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    }
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'LOGOUT',
      targetType: 'AUTH',
      targetName: actor.username,
    });
    return { success: true };
  },
};
