import { Database, Lock, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { friendlyMessage } from '../lib/api';
import { Button, ErrorBanner, Field, Input } from '../components/ui';

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'Admin@12345', label: '管理员' },
  { username: 'user', password: 'User@12345', label: '普通用户' },
  { username: 'readonly', password: 'Readonly@12345', label: '只读用户' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const showDemoAccounts = import.meta.env.DEV;
  const [username, setUsername] = useState(showDemoAccounts ? 'admin' : '');
  const [password, setPassword] = useState(showDemoAccounts ? 'Admin@12345' : '');
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
    <div className="min-h-screen bg-[#f7f7f7] lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)]">
      <section className="relative hidden min-h-screen overflow-hidden bg-brand-600 px-12 py-10 text-white lg:flex lg:flex-col xl:px-16 xl:py-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'linear-gradient(rgba(247,247,247,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(247,247,247,.055) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
          aria-hidden
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-signal-400 text-brand-700">
            <Database size={19} strokeWidth={2.2} />
          </div>
          <div>
            <p className="text-sm font-medium leading-tight">数据仓库资源控制台</p>
          </div>
        </div>

        <div className="relative my-auto max-w-[680px] pb-16">
          <div className="mb-8 h-1 w-16 bg-signal-400" />
          <h1 className="max-w-[620px] text-balance text-[clamp(48px,5.4vw,82px)] font-medium leading-[0.98] tracking-[-0.055em] text-white">
            数据仓库
            <br />
            资源控制台
          </h1>
        </div>

        <div className="relative flex items-end justify-between border-t border-white/15 pt-5 text-[11px] text-white/40">
          <span className="font-mono">DW / Console</span>
          <span>内部管理系统</span>
        </div>
      </section>

      <section className="flex min-h-screen flex-col px-6 py-6 sm:px-10 lg:px-12 xl:px-20">
        <div className="flex items-center gap-2.5 lg:hidden">
          <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-brand-600 text-signal-400">
            <Database size={17} />
          </div>
          <div>
            <p className="text-sm font-medium leading-tight text-slate-900">数据仓库资源控制台</p>
          </div>
        </div>

        <div className="my-auto w-full max-w-[390px] self-center py-12 sm:py-16">
          <p className="font-mono text-[11px] text-slate-500">账号登录</p>
          <h2 className="mt-3 text-[30px] font-medium leading-none tracking-[-0.045em] text-slate-900">登录</h2>
          <div className="mt-8 border-t border-slate-300 pt-7">
            <form className="space-y-5" onSubmit={submit}>
              {error && <ErrorBanner message={error} />}
              <Field label="用户名" required>
                <div className="relative">
                  <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input
                    className="h-11 pl-9"
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
                    className="h-11 pl-9"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                  />
                </div>
              </Field>
              <Button type="submit" className="mt-2 h-11 w-full" disabled={submitting}>
                {submitting ? '登录中…' : '登录'}
              </Button>
            </form>

            {showDemoAccounts ? (
              <div className="mt-8 border-t border-slate-200 pt-5">
                <p className="mb-3 font-mono text-[11px] text-slate-500">演示账号</p>
                <div className="divide-y divide-slate-200 border-y border-slate-200">
                  {DEMO_ACCOUNTS.map((acc) => (
                    <button
                      key={acc.username}
                      type="button"
                      data-demo={acc.username}
                      className="flex h-11 w-full items-center justify-between text-left text-[13px] text-slate-600 transition-colors hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                      onClick={() => {
                        setUsername(acc.username);
                        setPassword(acc.password);
                      }}
                    >
                      <span className="font-mono text-slate-800">{acc.username}</span>
                      <span>{acc.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <p className="text-center font-mono text-[10px] text-slate-400 lg:text-right">DW / Console</p>
      </section>
    </div>
  );
}
