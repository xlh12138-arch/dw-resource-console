import type { Role, UserStatus } from '@dw/shared';
import { conflict, notFound } from '../../lib/errors.js';
import { generatePassword, hashPassword } from '../../lib/password.js';
import { auditRepository } from '../audit/repository.js';
import { authService, toUserDto } from '../auth/service.js';
import { userRepository } from './repository.js';

export const userService = {
  async list() {
    const users = await userRepository.list();
    return users.map(toUserDto);
  },

  async create(
    input: { username: string; password: string; displayName: string; role: Role },
    actor: { id: number | null; username: string },
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
    actor: { id: number | null; username: string },
    requestId?: string,
  ) {
    const before = await userRepository.findById(id);
    if (!before) throw notFound('用户不存在');
    const user = await userRepository.update(id, patch);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'USER',
      targetId: String(id),
      targetName: user.username,
      changes: [
        ...(patch.displayName ? [{ field: 'displayName', label: '姓名', from: before.displayName, to: patch.displayName }] : []),
        ...(patch.role ? [{ field: 'role', label: '角色', from: before.role, to: patch.role }] : []),
        ...(patch.status ? [{ field: 'status', label: '状态', from: before.status, to: patch.status }] : []),
      ],
      requestId,
    });
    return toUserDto(user);
  },

  async remove(
    id: number,
    actor: { id: number | null; username: string },
    requestId?: string,
  ): Promise<{ id: number }> {
    const before = await userRepository.findById(id);
    if (!before) throw notFound('用户不存在');
    if (id === actor.id) throw conflict('不能删除当前登录账号');
    if (before.status !== 'DISABLED') {
      throw conflict('该用户仍处于启用状态，请先停用后再删除');
    }

    // 删除用户后刷新令牌会随用户记录级联清除；这里显式吊销，便于在事务内表达会话回收意图。
    await authService.revokeAllRefreshTokens(id);
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
    actor: { id: number | null; username: string },
    requestId?: string,
  ): Promise<{ user: ReturnType<typeof toUserDto>; password: string }> {
    const before = await userRepository.findById(id);
    if (!before) throw notFound('用户不存在');

    const password = generatePassword(12);
    const user = await userRepository.updatePassword(id, await hashPassword(password));
    await authService.revokeAllRefreshTokens(id);

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'USER',
      targetId: String(id),
      targetName: user.username,
      changes: [{ field: 'password', label: '密码', from: '已设置', to: '已重置（不记录明文）' }],
      requestId,
    });

    return { user: toUserDto(user), password };
  },
};
