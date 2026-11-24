import {
  checkPasswordStrength,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLE_LABELS,
  type PasswordIssue,
  type Role,
} from '@dw/shared';
import { Check, Lock, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { friendlyMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from './toast';
import { Button, ErrorBanner, Field, Input, Modal } from './ui';

const isApiErrorWithReason = (error: unknown, reason: string) => {
  const details = (error as { details?: { reason?: unknown } } | null)?.details;
  return typeof details === 'object' && details !== null && details.reason === reason;
};

/**
 * 密码复杂度提示：与服务端共用 checkPasswordStrength，
 * 输入时逐项实时给出通过/未通过，避免「提交后才被告知不合规」。
 */
function PasswordRules({
  password,
  username,
  displayName,
  oldPassword,
}: {
  password: string;
  username: string;
  displayName: string;
  oldPassword?: string;
}) {
  const issues = useMemo(
    () =>
      checkPasswordStrength(
        password,
        { username, displayName },
        { oldPassword: oldPassword || undefined },
      ),
    [password, username, displayName, oldPassword],
  );
  const failed = new Set(issues.map((issue) => issue.code));

  const rules: { code: PasswordIssue['code']; text: string }[] = [
    { code: 'TOO_SHORT', text: `长度至少 ${PASSWORD_MIN_LENGTH} 位（推荐 12 位以上）` },
    { code: 'NO_LETTER', text: '包含英文字母' },
    { code: 'NO_DIGIT', text: '包含数字' },
    { code: 'CHARSET', text: '只用字母、数字与键盘符号，不含空格' },
    { code: 'WEAK', text: '不是常见弱口令（如 password、admin123）' },
    { code: 'REPEAT', text: '没有 3 个以上连续相同字符' },
    { code: 'SEQUENCE', text: '没有 abc、123 这类连续字符' },
    { code: 'PERSONAL', text: '不含用户名与姓名' },
  ];
  if (oldPassword) rules.push({ code: 'SAME_AS_OLD', text: '与当前密码不同' });

  const filled = password.length > 0;
  const allPassed = filled && issues.length === 0;

  return (
    <div className="rounded-[8px] border border-slate-200 bg-white px-3 py-2.5">
      <p
        className="mb-1.5 text-[12px] font-medium text-slate-600"
        data-password-hint={allPassed ? 'ok' : 'pending'}
      >
        {filled ? (allPassed ? '密码符合要求' : '还需满足：') : '密码要求'}
      </p>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {rules.map((rule) => {
          // 未输入时不提前显示「未通过」，只展示规则本身
          const ok = filled && !failed.has(rule.code);
          return (
            <li
              key={rule.code}
              data-rule={rule.code}
              className={
                filled && ok
                  ? 'flex items-start gap-1.5 text-[12px] leading-relaxed text-emerald-700'
                  : 'flex items-start gap-1.5 text-[12px] leading-relaxed text-slate-500'
              }
            >
              {filled && ok ? (
                <Check size={13} className="mt-0.5 shrink-0" aria-hidden />
              ) : (
                <X size={13} className="mt-0.5 shrink-0 text-slate-300" aria-hidden />
              )}
              <span>{rule.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 修改密码表单：首登强制改密与主动改密共用 */
function ChangePasswordForm({
  forced,
  onDone,
  onCancel,
}: {
  forced?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { user, changePassword, logout } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const passwordIssues = useMemo(
    () =>
      checkPasswordStrength(
        newPassword,
        { username: user?.username, displayName: user?.displayName },
        { oldPassword: currentPassword || undefined },
      ),
    [newPassword, currentPassword, user?.username, user?.displayName],
  );
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    passwordIssues.length === 0 &&
    confirmPassword === newPassword &&
    !submitting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (passwordIssues.length > 0) {
      setError(`新密码不符合要求：${passwordIssues.map((issue) => issue.message).join('；')}`);
      return;
    }
    if (confirmPassword !== newPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.push('success', '密码已修改');
      onDone();
    } catch (err) {
      setError(
        isApiErrorWithReason(err, 'WRONG_CURRENT_PASSWORD')
          ? '当前密码不正确，请重新输入'
          : friendlyMessage(err),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={submit} data-testid="change-password-form">
      {error ? <ErrorBanner message={error} /> : null}
      <Field label="当前密码" required hint={forced ? '请输入你这次登录用的密码' : undefined}>
        <div className="relative">
          <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-10 pl-9"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="请输入当前密码"
            autoFocus
          />
        </div>
      </Field>
      <Field label="新密码" required>
        <div className="relative">
          <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-10 pl-9"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            maxLength={PASSWORD_MAX_LENGTH}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={`请输入新密码（至少 ${PASSWORD_MIN_LENGTH} 位）`}
          />
        </div>
      </Field>
      <PasswordRules
        password={newPassword}
        username={user?.username ?? ''}
        displayName={user?.displayName ?? ''}
        oldPassword={currentPassword}
      />
      <Field label="确认新密码" required error={mismatch ? '两次输入的新密码不一致' : undefined}>
        <Input
          className="h-10"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          maxLength={PASSWORD_MAX_LENGTH}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="请再次输入新密码"
        />
      </Field>

      <div className="flex items-center justify-between gap-2 pt-1">
        {forced ? (
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            退出登录
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {onCancel ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
          ) : null}
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? '提交中…' : '保存新密码'}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** 个人设置：所有登录用户都能改自己的姓名与密码 */
export function AccountSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, updateProfile } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'profile' | 'password'>('profile');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 每次打开都用最新的姓名初始化，避免沿用上次未保存的输入
  useEffect(() => {
    if (!open) return;
    setTab('profile');
    setDisplayName(user?.displayName ?? '');
    setError('');
  }, [open, user?.displayName]);

  const nameChanged = displayName.trim() !== (user?.displayName ?? '');

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const next = displayName.trim();
    if (!next) {
      setError('姓名不能为空');
      return;
    }
    if (!nameChanged) return;
    setSaving(true);
    try {
      await updateProfile(next);
      toast.push('success', '姓名已更新');
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="个人设置"
      desc="修改自己的姓名与登录密码"
      onClose={onClose}
      width="max-w-xl"
      footer={null}
    >
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {[
          { key: 'profile' as const, label: '基本资料', icon: UserRound },
          { key: 'password' as const, label: '修改密码', icon: Lock },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={
              tab === item.key
                ? '-mb-px flex items-center gap-1.5 border-b-2 border-brand-600 px-3 py-2 text-[13px] font-medium text-brand-700'
                : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[13px] text-slate-500 hover:text-slate-800'
            }
          >
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'profile' ? (
        <form className="space-y-4" onSubmit={saveProfile}>
          {error ? <ErrorBanner message={error} /> : null}
          <div className="rounded-[8px] border border-slate-200 bg-white px-3 py-2.5 text-[12px] text-slate-600">
            <p>
              用户名：<span className="font-mono text-slate-800">{user?.username}</span>
            </p>
            <p className="mt-1">
              角色：{ROLE_LABELS[(user?.role ?? 'USER') as Role]}
              <span className="ml-2 text-slate-400">用户名与角色由管理员维护</span>
            </p>
          </div>
          <Field label="姓名" required hint="显示在顶栏与审计日志的操作人里">
            <Input
              className="h-10"
              value={displayName}
              maxLength={32}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="请输入姓名"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!nameChanged || saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      ) : (
        <ChangePasswordForm onDone={onClose} onCancel={() => setTab('profile')} />
      )}
    </Modal>
  );
}

/**
 * 首次登录（或口令被管理员重置后）强制改密。
 * 弹窗不可关闭、不可 ESC、点遮罩无效；只提供「保存新密码」与「退出登录」。
 */
export function ForcePasswordChangeModal({ open }: { open: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Modal
      open={open && !done}
      title="请先修改初始密码"
      desc="出于账号安全，首次登录必须设置自己的密码后才能使用系统"
      onClose={() => setDone(true)}
      width="max-w-xl"
      dismissible={false}
      closeOnEsc={false}
      footer={null}
    >
      <ChangePasswordForm forced onDone={() => setDone(true)} />
    </Modal>
  );
}
