import type {
  Role,
  UserImportErrorDetails,
  UserImportIssueDto,
  UserImportResult,
  UserImportRow,
  UserStatus,
} from '@dw/shared';
import type { UserRow } from '../../db/schema.js';
import { conflict, notFound, validationError } from '../../lib/errors.js';
import { generatePassword, hashPassword } from '../../lib/password.js';
import { auditRepository } from '../audit/repository.js';
import { authService, toUserDto } from '../auth/service.js';
import { userRepository } from './repository.js';

type Actor = { id: number | null; username: string };

/** 批量操作失败时携带的明细，前端据此提示「本次操作已整体回滚」 */
export type BulkFailure = {
  userId: number;
  username: string;
  message: string;
};

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: '管理员',
  USER: '普通用户',
  READONLY: '只读用户',
};

/** 停用账号时吊销其全部刷新令牌，避免已登录会话继续访问 */
async function revokeSessionsIfDisabled(id: number, status: UserStatus): Promise<void> {
  if (status === 'DISABLED') await authService.revokeAllRefreshTokens(id);
}

export const userService = {
  async list() {
    const users = await userRepository.list();
    return users.map(toUserDto);
  },

  async create(
    input: { username: string; password: string; displayName: string; role: Role },
    actor: Actor,
    requestId?: string,
  ) {
    if (await userRepository.findByUsername(input.username)) {
      throw conflict(`用户名 ${input.username} 已存在`);
    }
    const passwordHash = await hashPassword(input.password);
    const user = await userRepository.create({
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      role: input.role,
    });
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'USER',
      targetId: String(user.id),
      targetName: user.username,
      changes: [{ field: 'role', label: '角色', from: null, to: user.role }],
      requestId,
    });
    return toUserDto(user);
  },

  async update(
    id: number,
    patch: { displayName?: string; role?: Role; status?: UserStatus },
    actor: Actor,
    requestId?: string,
  ) {
    const before = await userRepository.findById(id);
    if (!before) throw notFound('用户不存在');
    const user = await userRepository.update(id, patch);
    // 停用时立即吊销刷新令牌；启用时不恢复任何历史会话。
    if (patch.status) await revokeSessionsIfDisabled(id, patch.status);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'USER',
      targetId: String(id),
      targetName: user.username,
      changes: [
        ...(patch.displayName
          ? [
              {
                field: 'displayName',
                label: '姓名',
                from: before.displayName,
                to: patch.displayName,
              },
            ]
          : []),
        ...(patch.role
          ? [{ field: 'role', label: '角色', from: before.role, to: patch.role }]
          : []),
        ...(patch.status
          ? [{ field: 'status', label: '状态', from: before.status, to: patch.status }]
          : []),
      ],
      requestId,
    });
    return toUserDto(user);
  },

  async remove(id: number, actor: Actor, requestId?: string): Promise<{ id: number }> {
    const before = await userRepository.findById(id);
    if (!before) throw notFound('用户不存在');
    if (id === actor.id) throw conflict('不能删除当前登录账号');
    if (before.status !== 'DISABLED') {
      throw conflict('该用户仍处于启用状态，请先停用后再删除');
    }

    // DWS 不使用外键级联，删除用户前显式清理刷新令牌。
    await authService.deleteAllRefreshTokens(id);
    if (!(await userRepository.removeDisabled(id))) {
      throw conflict('用户状态已发生变化，请刷新后重试');
    }

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'USER',
      targetId: String(id),
      targetName: before.username,
      changes: [{ field: 'status', label: '状态', from: before.status, to: '已删除' }],
      requestId,
    });
    return { id };
  },

  /**
   * 管理员重置密码：生成新口令、落库、并吊销该用户全部刷新令牌（强制重新登录）。
   * 明文密码只在本次响应里返回一次，不写日志、不入库、不进审计明细。
   */
  async resetPassword(
    id: number,
    actor: Actor,
    requestId?: string,
  ): Promise<{ user: ReturnType<typeof toUserDto>; password: string }> {
    const before = await userRepository.findById(id);
    if (!before) throw notFound('用户不存在');

    const password = generatePassword(12);
    const user = await userRepository.updatePassword(id, await hashPassword(password));
    await authService.revokeAllRefreshTokens(id);
    await recordPasswordReset(user, actor, requestId);

    return { user: toUserDto(user), password };
  },

  /**
   * 批量启用 / 停用。
   * 调用方必须在外层 withTransaction 里执行；任一用户不满足条件即抛错，整批回滚。
   * 幂等：已经是目标状态的用户原样保留，不重复写审计。
   */
  async bulkSetStatus(ids: number[], status: UserStatus, actor: Actor, requestId?: string) {
    const rows = await loadAll(ids);
    const changed: UserRow[] = [];
    for (const row of rows) {
      if (row.status === status) continue;
      if (status === 'DISABLED' && row.id === actor.id) {
        throw conflict('不能停用当前登录账号', failed(row, '不能停用当前登录账号'));
      }
      changed.push(row);
    }

    if (changed.length > 0) {
      await userRepository.updateStatusMany(
        changed.map((row) => row.id),
        status,
      );
      // 停用后立即踢掉在线会话；启用不恢复任何历史会话。
      if (status === 'DISABLED') {
        for (const row of changed) await authService.revokeAllRefreshTokens(row.id);
      }
      for (const row of changed) {
        await auditRepository.record({
          actorId: actor.id,
          actorName: actor.username,
          action: status === 'DISABLED' ? 'DISABLE' : 'ENABLE',
          targetType: 'USER',
          targetId: String(row.id),
          targetName: row.username,
          changes: [{ field: 'status', label: '状态', from: row.status, to: status }],
          requestId,
        });
      }
    }

    return { status, updated: changed.length, ids: ids };
  },

  /** 批量重置密码：调用方必须在 withTransaction 内执行，任一步失败整批回滚 */
  async bulkResetPassword(ids: number[], actor: Actor, requestId?: string) {
    const rows = await loadAll(ids);
    const results: { id: number; username: string; password: string }[] = [];
    for (const row of rows) {
      const password = generatePassword(12);
      const user = await userRepository.updatePassword(row.id, await hashPassword(password));
      await authService.revokeAllRefreshTokens(row.id);
      await recordPasswordReset(user, actor, requestId);
      results.push({ id: user.id, username: user.username, password });
    }
    return { updated: results.length, users: results };
  },

  /**
   * 批量删除：调用方必须在 withTransaction 内执行。
   * 删除前置条件（已停用、非本人）与单条删除一致；任何一个不满足就整体失败。
   */
  async bulkRemove(ids: number[], actor: Actor, requestId?: string) {
    const rows = await loadAll(ids);

    for (const row of rows) {
      if (row.id === actor.id)
        throw conflict('不能删除当前登录账号', failed(row, '不能删除当前登录账号'));
      if (row.status !== 'DISABLED') {
        throw conflict(
          `账号 ${row.username} 仍处于启用状态，请先停用后再删除`,
          failed(row, '该用户仍处于启用状态，请先停用后再删除'),
        );
      }
    }

    for (const row of rows) {
      // DWS 不使用外键级联，删除前显式清理刷新令牌与登录日志关联。
      await authService.deleteAllRefreshTokens(row.id);
      if (!(await userRepository.removeDisabled(row.id))) {
        throw conflict(
          `账号 ${row.username} 状态已发生变化，请刷新后重试`,
          failed(row, '用户状态已发生变化，请刷新后重试'),
        );
      }
      await auditRepository.record({
        actorId: actor.id,
        actorName: actor.username,
        action: 'DELETE',
        targetType: 'USER',
        targetId: String(row.id),
        targetName: row.username,
        changes: [{ field: 'status', label: '状态', from: row.status, to: '已删除' }],
        requestId,
      });
    }

    return { deleted: rows.length, ids };
  },

  /**
   * 批量导入。
   * 1) 先做全量校验（字段格式、用户名重复、库内已存在），**不写库**；
   * 2) 全部通过才在调用方的事务里逐条创建，任何一条失败整体回滚。
   * 明文口令只在本响应里返回一次。
   */
  async importUsers(
    rows: UserImportRow[],
    actor: Actor,
    requestId?: string,
  ): Promise<UserImportResult> {
    if (rows.length === 0) throw validationError('导入内容为空');
    const errors: UserImportIssueDto[] = [];
    const seen = new Map<string, number>();
    // 每次导入都重新读库，避免页面停留期间新建的账号漏检
    const existing = new Set((await userRepository.list()).map((u) => u.username));

    for (const input of rows) {
      const username = input.username.trim();
      const displayName = input.displayName.trim();
      const roleText = input.role.trim();
      const password = (input.password ?? '').trim();

      if (username.length < 3 || username.length > 32) {
        errors.push({ row: input.row, username, message: '用户名需为 3～32 个字符' });
      } else if (existing.has(username)) {
        errors.push({ row: input.row, username, message: `用户名 ${username} 已存在` });
      } else if (seen.has(username)) {
        errors.push({
          row: input.row,
          username,
          message: `与第 ${seen.get(username)} 行重复，同一份导入里用户名不能重复`,
        });
      } else {
        seen.set(username, input.row);
      }

      if (displayName.length < 1 || displayName.length > 32) {
        errors.push({ row: input.row, username, message: '姓名需为 1～32 个字符' });
      }

      const role = resolveRole(roleText);
      if (!role) {
        errors.push({
          row: input.row,
          username,
          message: `角色「${roleText || '空'}」无法识别，请填 管理员 / 普通用户 / 只读用户`,
        });
      }

      if (password && (password.length < 8 || password.length > 128)) {
        errors.push({ row: input.row, username, message: '初始密码留空自动生成，或填 8～128 位' });
      }
    }

    if (errors.length > 0) throw importInvalid(errors);

    const created: UserImportResult['users'] = [];
    // 事务内再查一次已存在账号：同一时刻另一个导入或手工建号可能刚好占用了用户名。
    // 这里抛出同样结构的逐行错误，调用方的事务整体回滚，不会留下半批账号。
    const taken = new Set((await userRepository.list()).map((u) => u.username));
    for (const input of rows) {
      const username = input.username.trim();
      if (taken.has(username)) {
        throw importInvalid([
          { row: input.row, username, message: `用户名 ${username} 已被占用，请更换后重试` },
        ]);
      }
      taken.add(username);
      const plain = (input.password ?? '').trim() || generatePassword(12);
      let user;
      try {
        user = await userRepository.create({
          username,
          displayName: input.displayName.trim(),
          passwordHash: await hashPassword(plain),
          role: resolveRole(input.role.trim())!,
        });
      } catch (err) {
        // 并发写入撞上唯一索引时也给出可读原因，而不是 500
        if (isUniqueViolation(err)) {
          throw importInvalid([{ row: input.row, username, message: `用户名 ${username} 已存在` }]);
        }
        throw err;
      }
      created.push({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        password: plain,
      });
    }

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'IMPORT',
      targetType: 'USER',
      targetId: 'bulk',
      targetName: `批量导入 ${created.length} 个用户`,
      changes: created.map((user) => ({
        field: 'username',
        label: `新增用户 ${user.username}`,
        from: null,
        to: user.displayName,
      })),
      requestId,
    });

    return { created: created.length, users: created };
  },
};

/** 把「同一个 id 列表」解析成完整用户行；缺任何一个就整体失败，避免部分生效 */
async function loadAll(ids: number[]): Promise<UserRow[]> {
  const rows = await userRepository.findByIds(ids);
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw notFound(`用户不存在或已被删除：ID ${missing.join('、')}`);
  }
  // 保持调用方的顺序，便于前端逐条对应
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)!);
}

function failed(row: UserRow, message: string): { reason: 'BULK_PRECHECK'; user: BulkFailure } {
  return { reason: 'BULK_PRECHECK', user: { userId: row.id, username: row.username, message } };
}

/** 导入校验失败：details 带上每一行的问题，前端直接展开到对应 Excel 行 */
function importInvalid(errors: UserImportIssueDto[]) {
  const details: UserImportErrorDetails = { reason: 'IMPORT_INVALID', errors };
  return validationError(`有 ${errors.length} 处内容需要修正，本次未写入任何用户`, details);
}

/**
 * 唯一索引冲突：PostgreSQL/DWS 报 23505（constraint），SQLite 报 UNIQUE constraint failed。
 * 并发导入同一个用户名时靠它把 500 变成「同名账号已存在」。
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { code?: unknown; cause?: unknown; message?: unknown };
  if (record.code === '23505') return true;
  if (isUniqueViolation(record.cause)) return true;
  return typeof record.message === 'string' && /UNIQUE constraint failed/i.test(record.message);
}

async function recordPasswordReset(user: UserRow, actor: Actor, requestId?: string) {
  await auditRepository.record({
    actorId: actor.id,
    actorName: actor.username,
    action: 'UPDATE',
    targetType: 'USER',
    targetId: String(user.id),
    targetName: user.username,
    changes: [{ field: 'password', label: '密码', from: '已设置', to: '已重置（不记录明文）' }],
    requestId,
  });
}

/** 接受角色编码或中文名，返回规范编码 */
export function resolveRole(text: string): Role | null {
  const normalized = text.trim();
  if (normalized === 'ADMIN' || normalized === '管理员') return 'ADMIN';
  if (normalized === 'USER' || normalized === '普通用户') return 'USER';
  if (normalized === 'READONLY' || normalized === '只读用户' || normalized === '只读') {
    return 'READONLY';
  }
  return null;
}

export { ROLE_LABELS as USER_ROLE_LABELS };
