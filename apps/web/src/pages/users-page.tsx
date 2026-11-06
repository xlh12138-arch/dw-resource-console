import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { ROLES, ROLE_LABELS, USER_STATUS_LABELS, type Role, type UserDto, type UserStatus } from '@dw/shared';
import { usersApi } from '../lib/endpoints';
import { friendlyMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Td,
  Th,
  Table,
} from '../components/ui';

export function UsersPage() {
  const { push } = useToast();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'USER' as Role });
  const [roleTarget, setRoleTarget] = useState<{ user: UserDto; role: Role } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserDto | null>(null);

  /** 待重置密码的用户；null 表示未打开重置流程 */
  const [resetTarget, setResetTarget] = useState<UserDto | null>(null);
  /** 重置成功后返回的新密码，展示一次 */
  const [resetResult, setResetResult] = useState<{ username: string; password: string } | null>(null);

  const query = useQuery({ queryKey: ['users'], queryFn: usersApi.list });

  const createMutation = useMutation({
    mutationFn: () => usersApi.create(form),
    onSuccess: () => {
      push('success', '用户已创建');
      setOpen(false);
      setForm({ username: '', password: '', displayName: '', role: 'USER' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: number; patch: { role?: Role; status?: UserStatus } }) =>
      usersApi.update(vars.id, vars.patch),
    onSuccess: () => {
      push('success', '已更新');
      setRoleTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => {
      setRoleTarget(null);
      push('error', friendlyMessage(err));
    },
  });

  const resetMutation = useMutation({
    mutationFn: (id: number) => usersApi.resetPassword(id),
    onSuccess: (res) => {
      setResetTarget(null);
      setResetResult({ username: res.user.username, password: res.password });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      push('success', '用户已删除');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const users = query.data?.items ?? [];

  const copyPassword = async () => {
    if (!resetResult) return;
    try {
      await navigator.clipboard.writeText(resetResult.password);
      push('success', '新密码已复制到剪贴板');
    } catch {
      push('error', '浏览器不允许自动复制，请手动选中密码复制');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">用户管理</h1>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus size={14} />
          新建用户
        </Button>
      </div>

      <Card>
        <CardHeader title="账号列表" desc={`共 ${users.length} 个账号`} />
        {query.isError && <div className="px-5 pb-4"><ErrorBanner message={friendlyMessage(query.error)} /></div>}
        {query.isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : users.length === 0 ? (
          <EmptyState title="暂无用户" />
        ) : (
          <Table
            head={
              <tr>
                <Th>用户名</Th>
                <Th>姓名</Th>
                <Th>角色</Th>
                <Th>状态</Th>
                <Th>最近登录</Th>
                <Th>创建时间</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50">
                <Td className="font-medium">{u.username}</Td>
                <Td>{u.displayName}</Td>
                <Td>
                  <Select
                    className="h-8 w-32 text-xs"
                    value={u.role}
                    aria-label={`修改 ${u.displayName} 的角色`}
                    options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                    onChange={(e) => {
                      const role = e.target.value as Role;
                      if (role !== u.role) setRoleTarget({ user: u, role });
                    }}
                  />
                </Td>
                <Td>
                  <Badge tone={u.status === 'ACTIVE' ? 'green' : 'gray'}>{USER_STATUS_LABELS[u.status as UserStatus]}</Badge>
                </Td>
                <Td className="text-xs text-slate-500">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}
                </Td>
                <Td className="text-xs text-slate-500">{new Date(u.createdAt).toLocaleString('zh-CN')}</Td>
                <Td className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setResetTarget(u)}>
                      <KeyRound size={12} />
                      重置密码
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        updateMutation.mutate({
                          id: u.id,
                          patch: { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
                        })
                      }
                    >
                      {u.status === 'ACTIVE' ? '停用' : '启用'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={u.status !== 'DISABLED' || u.id === currentUser?.id}
                      aria-label={
                        u.id === currentUser?.id
                          ? `不能删除当前登录账号 ${u.username}`
                          : u.status !== 'DISABLED'
                            ? `用户 ${u.username} 需要先停用才能删除`
                            : `删除用户 ${u.username}`
                      }
                      title={
                        u.id === currentUser?.id
                          ? '不能删除当前登录账号'
                          : u.status !== 'DISABLED'
                            ? '请先停用用户后再删除'
                            : `删除用户 ${u.username}`
                      }
                      onClick={() => setDeleteTarget(u)}
                    >
                      <Trash2
                        size={13}
                        className={
                          u.status === 'DISABLED' && u.id !== currentUser?.id
                            ? 'text-rose-600'
                            : 'text-slate-400'
                        }
                      />
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        title="新建用户"
        desc="密码至少 8 位，创建后立即生效"
        width="max-w-md"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
              {createMutation.isPending ? '创建中…' : '创建'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="用户名" required>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
            <Field label="姓名" required>
              <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </Field>
          </div>
          <Field label="初始密码" required hint="至少 8 位；忘记后可由管理员重置">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="角色" required>
            <Select
              value={form.role}
              options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={roleTarget !== null}
        title="修改用户角色"
        desc="角色变更会立即生效，并影响该账号可访问的功能和数据操作范围"
        width="max-w-md"
        onClose={() => setRoleTarget(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setRoleTarget(null)}>
              取消
            </Button>
            <Button
              disabled={updateMutation.isPending}
              onClick={() =>
                roleTarget &&
                updateMutation.mutate({ id: roleTarget.user.id, patch: { role: roleTarget.role } })
              }
            >
              {updateMutation.isPending ? '修改中…' : '确认修改'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-600">
          将账号 <span className="font-medium text-slate-900">{roleTarget?.user.displayName ?? ''}</span> 的角色从{' '}
          <span className="font-medium text-slate-900">
            {roleTarget ? ROLE_LABELS[roleTarget.user.role] : ''}
          </span>{' '}
          修改为{' '}
          <span className="font-medium text-brand-700">{roleTarget ? ROLE_LABELS[roleTarget.role] : ''}</span>。
        </p>
      </Modal>

      {/* 第一步：确认 */}
      <Modal
        open={resetTarget !== null}
        title="重置密码"
        desc={`将为账号 ${resetTarget?.username ?? ''} 生成一个新的随机密码`}
        width="max-w-md"
        onClose={() => setResetTarget(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button
              disabled={resetMutation.isPending}
              onClick={() => resetTarget && resetMutation.mutate(resetTarget.id)}
            >
              {resetMutation.isPending ? '重置中…' : '确认重置'}
            </Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-slate-600">
          重置后原密码立即失效，该账号所有已登录会话会被强制下线，需要用新密码重新登录。
        </p>
      </Modal>

      {/* 第二步：展示新密码（仅本次可见） */}
      <Modal
        open={resetResult !== null}
        title="密码已重置"
        desc="请把新密码告知用户，关闭后无法再次查看"
        width="max-w-md"
        onClose={() => setResetResult(null)}
        footer={
          <>
            <Button variant="outline" onClick={copyPassword}>
              <Copy size={14} />
              复制密码
            </Button>
            <Button onClick={() => setResetResult(null)}>我已记录</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="账号">
            <Input readOnly value={resetResult?.username ?? ''} />
          </Field>
          <Field label="新密码" hint="仅本次展示，服务端只保存哈希">
            <Input
              readOnly
              value={resetResult?.password ?? ''}
              className="font-mono text-base tracking-wider"
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <p className="text-xs text-slate-500">建议提醒用户登录后尽快修改为自己的密码。</p>
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title="删除用户"
        desc="仅已停用的账号可以删除"
        width="max-w-md"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            确认删除账号 <span className="font-medium">{deleteTarget?.username ?? ''}</span> 吗？
          </p>
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            删除后不可恢复，该账号的登录会话与刷新令牌会一并清除。
          </p>
        </div>
      </Modal>
    </div>
  );
}
