import { useState, type FormEvent } from 'react';
import type { HarnessSession } from '../types';
import { formatDate } from '../format';
import { Icon } from './Icon';

interface SessionSidebarProps {
  sessions: HarnessSession[];
  selectedId: string | null;
  loading: boolean;
  creating: boolean;
  onRefresh: () => void;
  onSelect: (session: HarnessSession) => void;
  onCreate: (title: string) => void;
}

export function SessionSidebar({
  sessions,
  selectedId,
  loading,
  creating,
  onRefresh,
  onSelect,
  onCreate,
}: SessionSidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || creating) return;
    onCreate(cleanTitle);
    setTitle('');
    setCreateOpen(false);
  }

  return (
    <aside className="panel session-panel" aria-label="任务会话列表">
      <div className="panel-heading session-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h2>任务会话</h2>
        </div>
        <div className="heading-actions">
          <button className="icon-button" type="button" title="刷新会话" aria-label="刷新会话" onClick={onRefresh} disabled={loading}>
            <Icon name="refresh" size={17} />
          </button>
          <button className="icon-button icon-button-primary" type="button" title="新建会话" aria-label="新建会话" onClick={() => setCreateOpen(open => !open)}>
            <Icon name={createOpen ? 'close' : 'plus'} size={18} />
          </button>
        </div>
      </div>

      {createOpen && (
        <form className="new-session-form" onSubmit={submit}>
          <label htmlFor="new-session-title">新任务名称</label>
          <input
            id="new-session-title"
            value={title}
            onChange={event => setTitle(event.target.value)}
            maxLength={100}
            placeholder="例如：整理一份网页资料"
            autoFocus
          />
          <button className="button button-primary button-small" type="submit" disabled={creating || !title.trim()}>
            {creating ? '正在创建…' : '创建会话'}
          </button>
        </form>
      )}

      <div className="session-list" aria-live="polite">
        {sessions.map(session => (
          <button
            className={`session-item${session.id === selectedId ? ' is-selected' : ''}`}
            key={session.id}
            type="button"
            onClick={() => onSelect(session)}
            aria-current={session.id === selectedId ? 'page' : undefined}
          >
            <span className="session-item-icon"><Icon name="screen" size={16} /></span>
            <span className="session-item-copy">
              <span className="session-title">{session.title || '未命名会话'}</span>
              <span className="session-date">{formatDate(session.created)}</span>
            </span>
            <Icon name="arrow" size={15} className="session-arrow" />
          </button>
        ))}

        {!sessions.length && !loading && !createOpen && (
          <div className="empty-list-state">
            <span className="empty-icon"><Icon name="screen" size={20} /></span>
            <strong>这里还没有任务</strong>
            <span>新建一个会话，开始你的网页工作。</span>
          </div>
        )}
        {loading && !sessions.length && <div className="list-loading">正在读取会话…</div>}
      </div>

      <div className="sidebar-footnote">
        <span className="status-dot" />
        <span>{sessions.length} 个会话</span>
      </div>
    </aside>
  );
}
