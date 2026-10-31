import { useState, type FormEvent } from 'react';
import { Icon } from './Icon';

interface ConnectionGateProps {
  busy: boolean;
  error: string;
  onConnect: (token: string) => void;
}

export function ConnectionGate({ busy, error, onConnect }: ConnectionGateProps) {
  const [credential, setCredential] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (credential.trim()) onConnect(credential.trim());
  }

  return (
    <main className="connection-screen">
      <section className="connection-card">
        <div className="connection-brand">
          <span className="brand-mark"><Icon name="spark" size={21} /></span>
          <span>mini-DSH-bot</span>
        </div>
        <div className="connection-heading">
          <span className="eyebrow">BROWSER WORKSPACE</span>
          <h1>连接浏览器工作台</h1>
          <p>使用服务端提供的访问凭证，查看任务进度并确认页面操作。</p>
        </div>
        <form className="connection-form" onSubmit={submit}>
          <label htmlFor="workspace-credential">工作台访问凭证</label>
          <div className="credential-field">
            <Icon name="key" size={17} />
            <input
              id="workspace-credential"
              type="password"
              value={credential}
              onChange={event => setCredential(event.target.value)}
              placeholder="粘贴 Bearer Token"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary connection-submit" type="submit" disabled={busy || !credential.trim()}>
            {busy ? '正在连接…' : '安全连接'}
            {!busy && <Icon name="arrow" size={17} />}
          </button>
        </form>
        <div className="connection-note">
          <Icon name="lock" size={16} />
          <span>凭证只保存在此页面内存中，退出或刷新后会清除。</span>
        </div>
      </section>
      <p className="connection-footnote">浏览器页面以安全预览显示 · 所有写入操作均需你确认</p>
    </main>
  );
}
