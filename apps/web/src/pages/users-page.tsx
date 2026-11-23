import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  KeyRound,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import { useMemo, useState, type ChangeEvent } from 'react';
import {
  ROLES,
  ROLE_LABELS,
  USER_STATUS_LABELS,
  type Role,
  type UserDto,
  type UserStatus,
} from '@dw/shared';
import { usersApi } from '../lib/endpoints';
import { ApiError, friendlyMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  USER_IMPORT_MAX_ROWS,
  downloadUserImportTemplate,
  parseUserImportFile,
  type ParsedUserImport,
  type UserImportIssue,
} from '../lib/user-import';
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
  PageHeader,
  Select,
  SortableTh,
  Spinner,
  Td,
  Th,
  Table,
  sortRows,
  useTableSort,
} from '../components/ui';

type UserSortKey = 'username' | 'displayName' | 'role' | 'status' | 'lastLoginAt' | 'createdAt';

/** 批量操作的类型，驱动确认弹窗的文案与禁用规则 */
type BulkAction = 'enable' | 'disable' | 'reset' | 'delete';

const BULK_META: Record<
  BulkAction,
  { title: string; pending: string; verb: string; danger: boolean; desc: string }
> = {
  enable: {
    title: '批量启用账号',
    pending: '启用中…',
    verb: '启用',
    danger: false,
    desc: '启用后账号可立即登录；不会恢复任何历史会话，用户需要重新登录。',
  },
  disable: {
    title: '批量停用账号',
    pending: '停用中…',
    verb: '停用',
    danger: false,
    desc: '停用后账号无法登录，已登录的会话会被立即踢下线。',
  },
  reset: {
    title: '批量重置密码',
    pending: '重置中…',
    verb: '重置密码',
    danger: false,
    desc: '为每个账号生成新的随机密码，原密码与已登录会话立即失效。',
  },
  delete: {
    title: '批量删除账号',
    pending: '删除中…',
    verb: '删除',
    danger: true,
    desc: '删除后不可恢复；只有已停用的账号才能删除。',
  },
};

/**
 * 导入被后端拒绝时取出逐行原因（用户名已存在、角色无法识别等）。
 * 服务端返回的是「哪一行、什么问题」，直接展开到对应 Excel 行，
 * 而不是只给一句「有 N 处需要修正」。
 */
function importServerIssues(
  error: unknown,
): { row: number; username: string; messages: string[] }[] {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') {
    return [];
  }
  const errors = (error.details as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  const grouped = new Map<number, { row: number; username: string; messages: string[] }>();
  for (const item of errors) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { row?: unknown; username?: unknown; message?: unknown };
    if (typeof rec.row !== 'number' || typeof rec.message !== 'string') continue;
    const hit = grouped.get(rec.row) ?? {
      row: rec.row,
      username: typeof rec.username === 'string' ? rec.username : '',
      messages: [],
    };
    hit.messages.push(rec.message);
    grouped.set(rec.row, hit);
  }
  return [...grouped.values()].sort((a, b) => a.row - b.row);
}

/** 批量接口失败时从 details 里取出「哪条用户卡住了」，用于回滚提示 */
function bulkBlocker(error: unknown): { username: string; message: string } | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') {
    return null;
  }
  const user = (error.details as { user?: { username?: unknown; message?: unknown } }).user;
  if (!user || typeof user.username !== 'string' || typeof user.message !== 'string') return null;
  return { username: user.username, message: user.message };
}

export function UsersPage() {
  const { push } = useToast();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    username: '',
    password: '',
    displayName: '',
    role: 'USER' as Role,
  });
  const [roleTarget, setRoleTarget] = useState<{ user: UserDto; role: Role } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserDto | null>(null);

  /** 待重置密码的用户；null 表示未打开重置流程 */
  const [resetTarget, setResetTarget] = useState<UserDto | null>(null);
  /** 重置成功后返回的新密码，展示一次 */
  const [resetResult, setResetResult] = useState<{ username: string; password: string } | null>(
    null,
  );

  /* 多选与批量操作 */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  /** 批量重置后的密码清单；null 表示未打开 */
  const [bulkPasswords, setBulkPasswords] = useState<
    { username: string; password: string }[] | null
  >(null);
  /** 批量操作被整体回滚时的提示：展示卡住的那一条 */
  const [bulkFailure, setBulkFailure] = useState<{
    action: BulkAction;
    message: string;
    username?: string;
    detail?: string;
  } | null>(null);

  /* 批量导入 */
  const [importOpen, setImportOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedUserImport | null>(null);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [imported, setImported] = useState<{ username: string; password: string }[] | null>(null);
  /** 后端拒绝时的逐行原因，按 Excel 行号展示在导入弹窗里 */
  const [serverIssues, setServerIssues] = useState<
    { row: number; username: string; messages: string[] }[]
  >([]);

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

  /**
   * 批量操作：服务端在单个事务里处理，任一条失败会整体回滚，
   * 所以这里只处理「全部成功」与「整批未生效」两种结果，不存在半成功。
   */
  const bulkMutation = useMutation({
    mutationFn: async (vars: { action: BulkAction; ids: number[] }) => {
      if (vars.action === 'enable') return usersApi.bulkSetStatus(vars.ids, 'ACTIVE');
      if (vars.action === 'disable') return usersApi.bulkSetStatus(vars.ids, 'DISABLED');
      if (vars.action === 'reset') return usersApi.bulkResetPassword(vars.ids);
      return usersApi.bulkRemove(vars.ids);
    },
    onSuccess: (result, vars) => {
      const action = vars.action;
      if (action === 'reset') {
        const users = (result as { users: { username: string; password: string }[] }).users;
        setBulkPasswords(users);
        push('success', `已为 ${users.length} 个账号重置密码，请及时转告`);
      } else if (action === 'delete') {
        push('success', `已删除 ${(result as { deleted: number }).deleted} 个账号`);
      } else {
        const updated = (result as { updated: number }).updated;
        const skipped = vars.ids.length - updated;
        push(
          'success',
          skipped > 0
            ? `已${BULK_META[action].verb} ${updated} 个账号，${skipped} 个已是目标状态已跳过`
            : `已${BULK_META[action].verb} ${updated} 个账号`,
        );
      }
      setBulkAction(null);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err, vars) => {
      const blocker = bulkBlocker(err);
      setBulkAction(null);
      // 回滚提示比 toast 停留更久，用户往往需要看完再决定下一步
      setBulkFailure({
        action: vars.action,
        message: friendlyMessage(err),
        username: blocker?.username,
        detail: blocker?.message,
      });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const importMutation = useMutation({
    mutationFn: (rows: ParsedUserImport['rows']) => usersApi.importUsers(rows),
    onSuccess: (result) => {
      setImported(result.users.map((u) => ({ username: u.username, password: u.password })));
      setServerIssues([]);
      setParsed(null);
      setImportOpen(false);
      push('success', `已导入 ${result.created} 个账号`);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => {
      // 服务端逐行原因比一句汇总更有用，留在弹窗里让用户照着改表
      setServerIssues(importServerIssues(err));
      push('error', friendlyMessage(err));
    },
  });

  const users = useMemo(() => query.data?.items ?? [], [query.data]);
  const userSort = useTableSort<UserSortKey>('username', 'asc');
  const sortedUsers = sortRows(users, userSort, (user, key) => {
    if (key === 'lastLoginAt') return user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    if (key === 'createdAt') return new Date(user.createdAt);
    return user[key];
  });

  const selectedUsers = useMemo(() => users.filter((u) => selected.has(u.id)), [users, selected]);
  const selectedIds = selectedUsers.map((u) => u.id);
  const allChecked = users.length > 0 && selected.size === users.length;

  /** 批量删除的前置条件与单条删除一致：必须已停用、且不能包含当前登录账号 */
  const deleteBlockers = selectedUsers.filter(
    (u) => u.status !== 'DISABLED' || u.id === currentUser?.id,
  );

  const toggleOne = (id: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      push('success', '已复制到剪贴板');
    } catch {
      push('error', '浏览器不允许自动复制，请手动选中后复制');
    }
  };

  const copyPassword = async () => {
    if (!resetResult) return;
    await copyText(resetResult.password);
  };

  const confirmBulk = () => {
    if (!bulkAction) return;
    if (bulkAction === 'delete' && deleteBlockers.length > 0) {
      push('error', '存在未停用或当前登录的账号，无法批量删除');
      return;
    }
    bulkMutation.mutate({ action: bulkAction, ids: selectedIds });
  };

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setParsed(null);
    setParseError('');
    setServerIssues([]);
    if (!/\.xlsx$/i.test(file.name)) {
      setParseError('请上传 .xlsx 文件；如果是 .xls，请先在 Excel 中另存为 .xlsx');
      return;
    }
    setParsing(true);
    try {
      setParsed(await parseUserImportFile(file));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const importIssues: UserImportIssue[] = parsed?.issues ?? [];
  const canImport =
    Boolean(parsed) &&
    importIssues.length === 0 &&
    (parsed?.rows.length ?? 0) > 0 &&
    !importMutation.isPending;

  const doImport = () => {
    if (!canImport || !parsed) return;
    importMutation.mutate(parsed.rows);
  };

  const closeImport = () => {
    if (importMutation.isPending) return;
    setImportOpen(false);
    setParsed(null);
    setParseError('');
    setServerIssues([]);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="用户管理"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload size={14} />
              批量导入
            </Button>
            <Button onClick={() => setOpen(true)}>
              <UserPlus size={14} />
              新建用户
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader title="账号列表" desc={`共 ${users.length} 个账号`} />
        {query.isError && (
          <div className="px-5 pb-4">
            <ErrorBanner message={friendlyMessage(query.error)} />
          </div>
        )}

        {selected.size > 0 && (
          <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-brand-800">
              <Users size={14} />
              已选 {selected.size} 个账号
            </span>
            <span className="text-[11px] text-slate-500">
              批量操作在一个事务里执行，任一条失败则整批回滚
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={bulkMutation.isPending}
                onClick={() => setBulkAction('enable')}
              >
                批量启用
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={bulkMutation.isPending}
                onClick={() => setBulkAction('disable')}
              >
                批量停用
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={bulkMutation.isPending}
                onClick={() => setBulkAction('reset')}
              >
                <KeyRound size={12} />
                批量重置密码
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={bulkMutation.isPending || deleteBlockers.length > 0}
                title={
                  deleteBlockers.length > 0
                    ? `有 ${deleteBlockers.length} 个账号未停用或为当前登录账号，批量删除要求全部已停用`
                    : '删除所选账号'
                }
                onClick={() => setBulkAction('delete')}
              >
                <Trash2 size={12} className="text-rose-600" />
                批量删除
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
            </div>
          </div>
        )}
        {deleteBlockers.length > 0 && selected.size > 0 && (
          <p className="mx-5 mb-3 text-[11px] text-amber-700">
            以下账号不满足删除条件（需先停用且不能是当前登录账号）：
            {deleteBlockers.map((u) => u.username).join('、')}
          </p>
        )}

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
                <Th className="w-12">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-600"
                    aria-label="全选账号"
                    checked={allChecked}
                    ref={(node) => {
                      if (node) node.indeterminate = selected.size > 0 && !allChecked;
                    }}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(users.map((u) => u.id)) : new Set())
                    }
                  />
                </Th>
                <SortableTh
                  label="用户名"
                  sortKey="username"
                  sortBy={userSort.sortBy}
                  sortOrder={userSort.sortOrder}
                  onSort={userSort.onSort}
                />
                <SortableTh
                  label="姓名"
                  sortKey="displayName"
                  sortBy={userSort.sortBy}
                  sortOrder={userSort.sortOrder}
                  onSort={userSort.onSort}
                />
                <SortableTh
                  label="角色"
                  sortKey="role"
                  sortBy={userSort.sortBy}
                  sortOrder={userSort.sortOrder}
                  onSort={userSort.onSort}
                />
                <SortableTh
                  label="状态"
                  sortKey="status"
                  sortBy={userSort.sortBy}
                  sortOrder={userSort.sortOrder}
                  onSort={userSort.onSort}
                />
                <SortableTh
                  label="最近登录"
                  sortKey="lastLoginAt"
                  sortBy={userSort.sortBy}
                  sortOrder={userSort.sortOrder}
                  onSort={userSort.onSort}
                />
                <SortableTh
                  label="创建时间"
                  sortKey="createdAt"
                  sortBy={userSort.sortBy}
                  sortOrder={userSort.sortOrder}
                  onSort={userSort.onSort}
                />
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {sortedUsers.map((u) => {
              const isSelf = u.id === currentUser?.id;
              return (
                <tr
                  key={u.id}
                  className={selected.has(u.id) ? 'bg-brand-50/70' : 'hover:bg-slate-50'}
                >
                  <Td>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-600"
                      aria-label={`选择账号 ${u.username}`}
                      checked={selected.has(u.id)}
                      onChange={(e) => toggleOne(u.id, e.target.checked)}
                    />
                  </Td>
                  <Td className="font-medium">
                    {u.username}
                    {isSelf && (
                      <span className="ml-1.5 text-[11px] text-slate-400">（当前登录）</span>
                    )}
                  </Td>
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
                    <Badge tone={u.status === 'ACTIVE' ? 'green' : 'gray'}>
                      {USER_STATUS_LABELS[u.status as UserStatus]}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {new Date(u.createdAt).toLocaleString('zh-CN')}
                  </Td>
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
                        disabled={u.status !== 'DISABLED' || isSelf}
                        aria-label={
                          isSelf
                            ? `不能删除当前登录账号 ${u.username}`
                            : u.status !== 'DISABLED'
                              ? `用户 ${u.username} 需要先停用才能删除`
                              : `删除用户 ${u.username}`
                        }
                        title={
                          isSelf
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
                            u.status === 'DISABLED' && !isSelf ? 'text-rose-600' : 'text-slate-400'
                          }
                        />
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
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
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Field>
            <Field label="姓名" required>
              <Input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
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
          将账号{' '}
          <span className="font-medium text-slate-900">{roleTarget?.user.displayName ?? ''}</span>{' '}
          的角色从{' '}
          <span className="font-medium text-slate-900">
            {roleTarget ? ROLE_LABELS[roleTarget.user.role] : ''}
          </span>{' '}
          修改为{' '}
          <span className="font-medium text-brand-700">
            {roleTarget ? ROLE_LABELS[roleTarget.role] : ''}
          </span>
          。
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
            <Button variant="outline" onClick={() => void copyPassword()}>
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

      {/* 批量操作确认 */}
      <Modal
        open={bulkAction !== null}
        title={bulkAction ? BULK_META[bulkAction].title : ''}
        desc={`将对所选 ${selectedUsers.length} 个账号执行，任一条失败则整批不生效`}
        width="max-w-lg"
        onClose={() => !bulkMutation.isPending && setBulkAction(null)}
        footer={
          <>
            <Button
              variant="outline"
              disabled={bulkMutation.isPending}
              onClick={() => setBulkAction(null)}
            >
              取消
            </Button>
            <Button
              variant={bulkAction && BULK_META[bulkAction].danger ? 'danger' : 'primary'}
              disabled={
                bulkMutation.isPending ||
                selectedUsers.length === 0 ||
                (bulkAction === 'delete' && deleteBlockers.length > 0)
              }
              onClick={confirmBulk}
            >
              {bulkMutation.isPending
                ? bulkAction
                  ? BULK_META[bulkAction].pending
                  : '处理中…'
                : `确认${bulkAction ? BULK_META[bulkAction].verb : ''}`}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {bulkAction && (
            <p className="text-xs leading-relaxed text-slate-600">{BULK_META[bulkAction].desc}</p>
          )}
          <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">用户名</th>
                  <th className="px-3 py-2 font-medium">姓名</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">角色</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {selectedUsers.map((u) => (
                  <tr
                    key={u.id}
                    className={
                      bulkAction === 'delete' && deleteBlockers.some((b) => b.id === u.id)
                        ? 'bg-rose-50'
                        : undefined
                    }
                  >
                    <td className="px-3 py-1.5 font-medium text-slate-800">{u.username}</td>
                    <td className="px-3 py-1.5 text-slate-600">{u.displayName}</td>
                    <td className="px-3 py-1.5 text-slate-600">
                      {USER_STATUS_LABELS[u.status as UserStatus]}
                      {u.id === currentUser?.id ? '（当前登录）' : ''}
                    </td>
                    <td className="px-3 py-1.5 text-slate-600">{ROLE_LABELS[u.role]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bulkAction === 'delete' && deleteBlockers.length > 0 && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              以下账号不满足删除条件：{deleteBlockers.map((u) => u.username).join('、')}
              。请先停用这些账号并取消勾选当前登录账号。
            </p>
          )}
          {bulkAction === 'reset' && (
            <p className="text-[11px] text-slate-500">
              重置后新密码只会在结果弹窗里展示一次，请及时复制并转告对应人员。
            </p>
          )}
        </div>
      </Modal>

      {/* 批量重置结果：新密码只展示一次 */}
      <Modal
        open={bulkPasswords !== null}
        title="密码已批量重置"
        desc="新密码仅本次展示，关闭后无法再次查看"
        width="max-w-lg"
        onClose={() => setBulkPasswords(null)}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() =>
                bulkPasswords &&
                void copyText(bulkPasswords.map((u) => `${u.username}\t${u.password}`).join('\n'))
              }
            >
              <Copy size={14} />
              复制全部
            </Button>
            <Button onClick={() => setBulkPasswords(null)}>我已记录</Button>
          </>
        }
      >
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">账号</th>
                <th className="px-3 py-2 font-medium">新密码</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(bulkPasswords ?? []).map((u) => (
                <tr key={u.username}>
                  <td className="px-3 py-1.5 font-medium text-slate-800">{u.username}</td>
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      className="select-all font-mono text-slate-700 hover:text-brand-700"
                      onClick={() => void copyText(u.password)}
                      title="点击复制"
                    >
                      {u.password}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>

      {/* 批量失败：整批回滚提示 */}
      <Modal
        open={bulkFailure !== null}
        title={bulkFailure ? `${BULK_META[bulkFailure.action].title}未生效` : ''}
        desc="批量操作要求整批一致，未产生任何变更"
        width="max-w-lg"
        onClose={() => setBulkFailure(null)}
        footer={<Button onClick={() => setBulkFailure(null)}>知道了</Button>}
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>{bulkFailure?.message}</p>
          {bulkFailure?.username && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              卡住的账号：
              <span className="font-medium">{bulkFailure.username}</span>
              {bulkFailure.detail ? ` —— ${bulkFailure.detail}` : ''}
            </p>
          )}
          <p className="text-xs leading-relaxed text-slate-500">
            本次操作已在数据库事务中整体回滚：其他账号的密码、状态与审计记录都没有变化，
            列表数据已重新拉取。修正上面的问题后可以重新提交。
          </p>
        </div>
      </Modal>

      {/* 批量导入 */}
      <Modal
        open={importOpen}
        title="批量导入用户"
        desc="下载模板填写后上传，全部校验通过才会写入"
        width="max-w-3xl"
        onClose={closeImport}
        footer={
          <>
            <Button variant="outline" disabled={importMutation.isPending} onClick={closeImport}>
              取消
            </Button>
            <Button disabled={!canImport} onClick={doImport}>
              <Upload size={14} />
              {importMutation.isPending ? '导入中…' : '导入'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <FileSpreadsheet size={14} className="text-brand-600" />第 1 步 · 下载 Excel 模板
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                列：用户名、姓名、角色、初始密码；角色列为下拉选择，初始密码留空则自动生成
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void downloadUserImportTemplate().catch((err: unknown) =>
                  push(
                    'error',
                    `模板下载失败：${err instanceof Error ? err.message : String(err)}`,
                  ),
                )
              }
            >
              <Download size={14} />
              下载模板
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium text-slate-700">第 2 步 · 填写后上传 .xlsx 文件</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                单次最多 {USER_IMPORT_MAX_ROWS} 行；上传后先逐行校验，有问题会列出 Excel 行号与字段
              </p>
            </div>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => void onImportFile(e)}
              className="block w-full cursor-pointer text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-brand-700 hover:file:bg-brand-100"
            />
            {parsing && <p className="text-xs text-slate-500">正在解析并校验 Excel…</p>}
            {parsed && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                <CheckCircle2 size={14} />
                已解析「{parsed.fileName}」：{parsed.rows.length} 行可导入
                {importIssues.length > 0 ? `，${importIssues.length} 行需要修正` : '，校验通过'}
              </p>
            )}
          </div>

          {parseError && <ErrorBanner message={parseError} />}

          {importIssues.length > 0 && (
            <div className="rounded-lg border border-rose-200">
              <p className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                以下行未通过校验，修正后请重新上传（有问题的行不会提交）
              </p>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="w-20 px-3 py-1.5 font-medium">Excel 行</th>
                      <th className="px-3 py-1.5 font-medium">用户名</th>
                      <th className="px-3 py-1.5 font-medium">问题</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {importIssues.map((issue, index) => (
                      <tr key={`${issue.row}-${index}`}>
                        <td className="px-3 py-1.5 text-slate-500">第 {issue.row} 行</td>
                        <td className="px-3 py-1.5 font-medium text-slate-800">
                          {issue.username || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-rose-700">
                          {issue.fields
                            .map((f) => `${f.label}${f.cell ? `（${f.cell}）` : ''}：${f.message}`)
                            .join('；')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {serverIssues.length > 0 && (
            <div className="rounded-lg border border-amber-200">
              <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                系统未写入任何账号：以下内容需要修正后重新上传
              </p>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="w-20 px-3 py-1.5 font-medium">Excel 行</th>
                      <th className="px-3 py-1.5 font-medium">用户名</th>
                      <th className="px-3 py-1.5 font-medium">原因</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {serverIssues.map((issue) => (
                      <tr key={issue.row}>
                        <td className="px-3 py-1.5 text-slate-500">第 {issue.row} 行</td>
                        <td className="px-3 py-1.5 font-medium text-slate-800">
                          {issue.username || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-amber-800">{issue.messages.join('；')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-slate-500">
            导入在后端一个事务内完成：任一行写入失败则整批回滚，不会出现「导入了一半」的账号。
          </p>
        </div>
      </Modal>

      {/* 导入结果：初始密码只展示一次 */}
      <Modal
        open={imported !== null}
        title="导入完成"
        desc="请把初始密码转告对应人员，关闭后无法再次查看"
        width="max-w-lg"
        onClose={() => setImported(null)}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() =>
                imported &&
                void copyText(imported.map((u) => `${u.username}\t${u.password}`).join('\n'))
              }
            >
              <Copy size={14} />
              复制全部
            </Button>
            <Button onClick={() => setImported(null)}>我已记录</Button>
          </>
        }
      >
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">账号</th>
                <th className="px-3 py-2 font-medium">初始密码</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(imported ?? []).map((u) => (
                <tr key={u.username}>
                  <td className="px-3 py-1.5 font-medium text-slate-800">{u.username}</td>
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      className="select-all font-mono text-slate-700 hover:text-brand-700"
                      onClick={() => void copyText(u.password)}
                      title="点击复制"
                    >
                      {u.password}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
