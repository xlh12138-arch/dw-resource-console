import { Database, Lock, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { friendlyMessage } from '../lib/api';
import { Button, ErrorBanner, Field, Input } from '../components/ui';

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
    <div className="login-shell">
      <aside className="login-brand-panel">
        <div className="sidebar-brand" style={{ minHeight: 'auto', padding: 0, border: 0 }}>
          <div className="sidebar-brand-mark">
            <Database size={17} />
          </div>
          <div>
            <p className="sidebar-brand-title">DW Resource Console</p>
            <p className="sidebar-brand-meta">Data Infrastructure</p>
          </div>
        </div>

        <div className="login-brand-heading">
          <div className="login-form-eyebrow" style={{ color: '#769097' }}>RESOURCE GOVERNANCE</div>
          <h1>数据仓库<br />资源管理平台</h1>
          <p>面向数据平台团队的基础设施资产控制台，统一维护批量调度、采集交换、NAS 与 GDS 资源。</p>
          <div className="login-capability-list">
            <div><strong>01 / ASSET</strong>资源台账</div>
            <div><strong>02 / ENV</strong>环境编排</div>
            <div><strong>03 / AUDIT</strong>变更审计</div>
          </div>
        </div>

        <p className="login-brand-footnote">INTERNAL SYSTEM · RESOURCE CONTROL</p>
      </aside>

      <main className="login-form-panel">
        <div className="login-form-wrap">
          <p className="login-form-eyebrow">ACCESS CONSOLE</p>
          <h2>登录管理控制台</h2>
          <p className="login-form-intro">使用内部账号进入工作区。</p>

          <div className="login-form-card">
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

          <div className="mt-5 border-t border-[#e4e8ea] pt-4">
            <p className="login-demo-heading">演示账号（点击填充）</p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.username}
                  type="button"
                  className="w-full rounded-lg border border-[#dfe4e6] px-3 py-2 text-left text-xs text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50"
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
          </div>
        </div>
      </main>
    </div>
  );
}
