'use client';

import { FormEvent, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type LoginScreenProps = {
  onAuthenticated: (username: string) => void;
};

async function errorMessage(response: Response) {
  try {
    const payload = await response.json() as { message?: string | string[] };
    return Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? '登录失败';
  } catch {
    return '登录失败，请稍后重试';
  }
}

export default function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = await response.json() as { username: string };
      setPassword('');
      onAuthenticated(result.username);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="auth-page">
    <section className="auth-panel" aria-label="管理员登录">
      <div className="auth-heading">
        <span className="eyebrow">RECONCILIATION SYSTEM</span>
        <h1>对账系统</h1>
        <p>管理员登录</p>
      </div>
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label><span>管理员账号</span><input autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? '登录中…' : '登录'}</button>
      </form>
    </section>
  </main>;
}
