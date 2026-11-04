import { Database, Lock, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { friendlyMessage } from '../lib/api';
import { Button, Card, ErrorBanner, Field, Input } from '../components/ui';

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'Admin@12345', label: '管理员（全部权限 + 用户管理 + 审计）' },
  { username: 'user', password: 'User@12345', label: '普通用户（除用户管理与审计外的全部权限）' },
  { username: 'readonly', password: 'Readonly@12345', label: '只读用户（仅查看）' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('Admin@12345');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-white to-brand-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Database size={20} />
          </div>
          <h1 className="text-lg font-semibold text-slate-900">数据仓库资源管理平台</h1>
          <p className="text-xs text-slate-500">批量调度 · 采集交换 · NAS · GDS 统一台账</p>
        </div>

        <Card className="p-6">
          <form className="space-y-4" onSubmit={submit}>
            {error && <ErrorBanner message={error} />}
            <Field label="用户名" required>
              <div className="relative">
                <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  value={username}
                  autoComplete="username"
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="请输入用户名"
                />
              </div>
            </Field>
            <Field label="密码" required>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                />
              </div>
            </Field>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>

          <div className="mt-5 border-t border-slate-100 pt-4">
            <p className="mb-2 text-xs font-medium text-slate-500">演示账号（点击填充）</p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.username}
                  type="button"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50"
                  onClick={() => {
                    setUsername(acc.username);
                    setPassword(acc.password);
                  }}
                >
                  <span className="font-medium text-slate-800">{acc.username}</span>
                  <span className="ml-2 text-slate-500">{acc.label}</span>
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
