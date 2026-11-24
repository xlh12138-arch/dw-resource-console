import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../../config/env.js';
import { db, execSql, withTransaction } from '../../db/index.js';
import { refreshTokens, type UserRow } from '../../db/schema.js';
import { checkPasswordStrength, type ChangePasswordInput } from '@dw/shared';
import { forbidden, unauthorized, validationError } from '../../lib/errors.js';
import { hashPassword, randomToken, verifyPassword } from '../../lib/password.js';
import { auditRepository } from '../audit/repository.js';
import { userRepository } from '../users/repository.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  idleTimeoutSeconds: number;
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
    mustChangePassword: user.mustChangePassword === true,
  };
}

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

export const authService = {
  /**
   * 老库兼容：早期版本的 VIEWER 归为 READONLY，OPERATOR 及其他未知值归为 USER。
   * 幂等，每次启动执行一次即可（无旧数据时 changes 为 0）。
   */
  async normalizeLegacyRoles(): Promise<number> {
    const changed = await withTransaction(async () => {
      const viewerResult = await execSql(
        sql`UPDATE users SET role = 'READONLY' WHERE role = 'VIEWER'`,
      );
      const otherResult = await execSql(
        sql`UPDATE users SET role = 'USER' WHERE role NOT IN ('ADMIN', 'USER', 'READONLY')`,
      );
      return Number(viewerResult.changes) + Number(otherResult.changes);
    });
    if (changed > 0) {
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
    const demoPasswordHash = await hashPassword('User@12345');
    const readonlyPasswordHash = await hashPassword('Readonly@12345');
    await withTransaction(async () => {
      if ((await userRepository.count()) > 0) return;
      await userRepository.create({
        username: config.auth.bootstrapAdmin.username,
        displayName: '系统管理员',
        passwordHash,
        role: 'ADMIN',
        mustChangePassword: true,
      });
      await userRepository.create({
        username: 'user',
        displayName: '普通用户',
        passwordHash: demoPasswordHash,
        role: 'USER',
        mustChangePassword: true,
      });
      await userRepository.create({
        username: 'readonly',
        displayName: '只读用户',
        passwordHash: readonlyPasswordHash,
        role: 'READONLY',
        mustChangePassword: true,
      });
    });
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

  /** 删除用户前清理刷新令牌，等价于原外键的 ON DELETE CASCADE */
  async deleteAllRefreshTokens(userId: number): Promise<void> {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
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

    return withTransaction(async () => {
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
        idleTimeoutSeconds: config.auth.idleTimeoutSeconds,
        user: toUserDto(user),
      };
    });
  },

  /**
   * 自助修改密码：先校验当前密码，再按共享的复杂度规则校验新密码，
   * 成功后清除「必须改密」标记并吊销其他会话的刷新令牌。
   */
  async changePassword(
    user: UserRow,
    input: ChangePasswordInput,
    ctx: { requestId?: string } = {},
  ) {
    const ok = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!ok) throw validationError('当前密码不正确', { reason: 'WRONG_CURRENT_PASSWORD' });
    if (input.currentPassword === input.newPassword) {
      throw validationError('新密码不能与当前密码相同', { reason: 'PASSWORD_POLICY' });
    }

    const issues = checkPasswordStrength(
      input.newPassword,
      { username: user.username, displayName: user.displayName },
      { oldPassword: input.currentPassword },
    );
    if (issues.length > 0) {
      throw validationError(`新密码不符合要求：${issues.map((i) => i.message).join('；')}`, {
        reason: 'PASSWORD_POLICY',
        issues,
      });
    }

    const passwordHash = await hashPassword(input.newPassword);
    const updated = await userRepository.updatePassword(user.id, passwordHash);
    await auditRepository.record({
      actorId: user.id,
      actorName: user.displayName,
      action: 'UPDATE',
      targetType: 'USER',
      targetId: String(user.id),
      targetName: user.username,
      changes: [{ field: 'password', label: '密码', from: null, to: '已修改' }],
      requestId: ctx.requestId ?? null,
    });
    return updated;
  },

  /**
   * 为本人签发一套新令牌并吊销旧令牌（含当前浏览器手上的那个）。
   * 改密后调用：本端拿到新令牌继续用，其他设备上的会话全部作废。
   */
  async rotateOwnSession(user: UserRow, ctx: { signAccessToken: TokenSigner; userAgent?: string }) {
    await this.revokeAllRefreshTokens(user.id);
    const refreshToken = await this.issueRefreshToken(user.id, ctx.userAgent);
    return {
      accessToken: ctx.signAccessToken(user),
      refreshToken,
      expiresIn: config.auth.accessTokenTtlSeconds,
      idleTimeoutSeconds: config.auth.idleTimeoutSeconds,
      user: toUserDto(user),
    };
  },

  async issueRefreshToken(userId: number, userAgent?: string): Promise<string> {
    const token = randomToken(48);
    const now = new Date();
    await db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + config.auth.refreshTokenTtlSeconds * 1000),
      // 签发即算一次使用，空闲计时从登录/续期时刻开始
      lastUsedAt: now,
      userAgent: userAgent ?? null,
    });
    return token;
  },

  /** 刷新令牌轮换：旧令牌立即吊销，防止重放 */
  async refresh(token: string, ctx: { signAccessToken: TokenSigner; userAgent?: string }) {
    return withTransaction(async () => {
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
      if (!row) throw unauthorized('刷新令牌无效，请重新登录');
      const now = Date.now();
      // 服务端空闲兜底：前端计时器只是体验层，服务端按 last_used_at 独立判定，
      // 避免前端被绕过（休眠、改系统时间、直接调接口）时刷新令牌无限续期。
      const idleMs = config.auth.idleTimeoutSeconds * 1000;
      if (now - row.lastUsedAt.getTime() > idleMs) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date(now) })
          .where(eq(refreshTokens.id, row.id));
        throw unauthorized('登录状态已超时，请重新登录');
      }
      if (row.expiresAt.getTime() < now) throw unauthorized('刷新令牌已过期，请重新登录');

      const user = await userRepository.findById(row.userId);
      if (!user || user.status !== 'ACTIVE') throw unauthorized('账号不可用，请重新登录');

      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date(now) })
        .where(eq(refreshTokens.id, row.id));

      const refreshToken = await this.issueRefreshToken(user.id, ctx.userAgent);
      return {
        accessToken: ctx.signAccessToken(user),
        refreshToken,
        expiresIn: config.auth.accessTokenTtlSeconds,
        idleTimeoutSeconds: config.auth.idleTimeoutSeconds,
        user: toUserDto(user),
      };
    });
  },

  async logout(token: string | undefined) {
    return withTransaction(async () => {
      if (!token) return { success: true };
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, sha256(token)));
      if (row) {
        const user = await userRepository.findById(row.userId);
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(refreshTokens.id, row.id));
        if (user) {
          await auditRepository.record({
            actorId: user.id,
            actorName: user.username,
            action: 'LOGOUT',
            targetType: 'AUTH',
            targetName: user.username,
          });
        }
      }
      return { success: true };
    });
  },
};
