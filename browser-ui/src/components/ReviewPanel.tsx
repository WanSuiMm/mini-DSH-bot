import type { BrowserCommand, BrowserEvent, BrowserSession, RunRecord } from '../types';
import { actionLabel, commandStatusLabel, eventDisplayDate, eventLabel, formatTime, isCommandActionable, requestOriginAllowed } from '../format';
import { Icon } from './Icon';

interface ReviewPanelProps {
  commands: BrowserCommand[];
  events: BrowserEvent[];
  browserSession: BrowserSession | null;
  run: RunRecord | null;
  allowedOrigins: string[];
  streamState: 'connecting' | 'connected' | 'reconnecting' | 'idle';
  busyCommandId: string | null;
  panelError: string;
  onDecision: (command: BrowserCommand, decision: 'approve' | 'reject') => void;
}

function CommandDetails({ command, allowedOrigins }: { command: BrowserCommand; allowedOrigins: string[] }) {
  const request = command.request;
  const originAllowed = requestOriginAllowed(request, allowedOrigins);

  return (
    <div className="action-details">
      {request.url && (
        <div className="detail-field">
          <span className="detail-label">网页地址</span>
          <code className="detail-value detail-url">{request.url}</code>
          {originAllowed !== null && (
            <span className={`origin-note${originAllowed ? '' : ' origin-note-caution'}`}>
              {originAllowed ? '此网站位于当前允许范围内' : '此地址不在当前允许列表中'}
            </span>
          )}
        </div>
      )}
      {request.ref && <div className="detail-field"><span className="detail-label">页面位置</span><code className="detail-value">{request.ref}</code></div>}
      {request.type === 'fill' && request.text !== undefined && (
        <div className="detail-field">
          <span className="detail-label">将填写的内容</span>
          <pre className="detail-value detail-pre">{request.text}</pre>
        </div>
      )}
      {request.type === 'select' && request.values && (
        <div className="detail-field">
          <span className="detail-label">将选择的内容</span>
          <div className="value-chips">{request.values.map((value, index) => <span className="value-chip" key={`${index}-${value}`}>{value}</span>)}</div>
        </div>
      )}
      {request.type === 'press' && request.key && <div className="detail-field"><span className="detail-label">按键</span><code className="detail-value">{request.key}</code></div>}
      {request.type === 'click' && !request.url && !request.ref && <span className="detail-muted">页面点击目标由当前截图和页面状态确认。</span>}
    </div>
  );
}

function CommandCard({
  command,
  allowedOrigins,
  actionable,
  busy,
  onDecision,
}: {
  command: BrowserCommand;
  allowedOrigins: string[];
  actionable: boolean;
  busy: boolean;
  onDecision: (command: BrowserCommand, decision: 'approve' | 'reject') => void;
}) {
  const endedBeforeDecision = command.status === 'pending_approval' && !actionable;

  return (
    <article className={`action-card${actionable ? ' action-card-pending' : ''}`}>
      <div className="action-card-heading">
        <span className={`action-type-icon${actionable ? ' is-pending' : ''}`}><Icon name={command.request.type === 'navigate' ? 'globe' : 'screen'} size={16} /></span>
        <div className="action-card-title">
          <strong>{actionLabel(command.request)}</strong>
          <span>{commandStatusLabel(command.status)}</span>
        </div>
          <span className="action-card-time">{formatTime(command.createdAt)}</span>
      </div>
      <CommandDetails command={command} allowedOrigins={allowedOrigins} />
      {command.status === 'unknown' && <p className="action-footnote action-footnote-warning"><Icon name="alert" size={15} />结果待核对；请查看当前页面或业务记录。</p>}
      {command.status === 'succeeded' && <p className="action-footnote">页面动作已返回，任务结果仍以页面或业务读回为准。</p>}
      {endedBeforeDecision && <p className="action-footnote action-footnote-warning">任务已结束，请重新发起。</p>}
      {actionable && (
        <div className="action-decision-buttons">
          <button className="button button-approve" type="button" onClick={() => onDecision(command, 'approve')} disabled={busy}>
            {busy ? '正在提交…' : <><Icon name="check" size={16} />确认并继续</>}
          </button>
          <button className="button button-reject" type="button" onClick={() => onDecision(command, 'reject')} disabled={busy}>
            <Icon name="close" size={15} />拒绝
          </button>
        </div>
      )}
    </article>
  );
}

export function ReviewPanel({
  commands,
  events,
  browserSession,
  run,
  allowedOrigins,
  streamState,
  busyCommandId,
  panelError,
  onDecision,
}: ReviewPanelProps) {
  const pending = commands.filter(command => command.status === 'pending_approval');
  const history = commands.filter(command => command.status !== 'pending_approval').slice(0, 4);

  return (
    <aside className="panel review-panel" aria-label="操作确认与任务动态">
      <div className="review-panel-header">
        <div>
          <span className="eyebrow">REVIEW</span>
          <h2>操作确认</h2>
        </div>
        <span className={`approval-count${pending.length ? ' has-pending' : ''}`}>{pending.length}</span>
      </div>

      {panelError && <div className="inline-error" role="status">{panelError}</div>}

      <section className="review-section">
        <div className="section-title-row">
          <h3>等待你确认</h3>
          {pending.length > 0 && <span className="section-count">{pending.length}</span>}
        </div>
        {pending.length > 0 ? (
          <div className="action-list">
            {pending.map(command => (
              <CommandCard
                key={command.id}
                command={command}
                allowedOrigins={allowedOrigins}
                actionable={isCommandActionable(command, run)}
                busy={busyCommandId === command.id}
                onDecision={onDecision}
              />
            ))}
          </div>
        ) : (
          <div className="empty-review-state">
            <span className="empty-icon empty-icon-small"><Icon name="shield" size={18} /></span>
            <span>{browserSession ? '需要确认的页面操作会显示在这里。' : '任务提出页面操作后，会在这里等你确认。'}</span>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="review-section command-history-section">
          <div className="section-title-row"><h3>最近操作</h3></div>
          <div className="command-history-list">
            {history.map(command => (
              <div className="command-history-item" key={command.id}>
                <span className={`history-status-dot status-${command.status}`} />
                <span className="history-command-name">{actionLabel(command.request)}</span>
                <span className="history-command-status">{commandStatusLabel(command.status)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="review-section timeline-section">
        <div className="timeline-heading">
          <div className="section-title-row"><h3>任务动态</h3></div>
          <span className={`stream-indicator stream-${streamState}`}>
            <span className="stream-dot" />
            {streamState === 'connected' ? '实时' : streamState === 'reconnecting' ? '重连中' : streamState === 'connecting' ? '连接中' : '待连接'}
          </span>
        </div>
        {events.length ? (
          <ol className="event-timeline">
            {events.slice(-24).reverse().map(event => (
              <li className="timeline-event" key={event.id}>
                <span className="timeline-marker" />
                <span className="timeline-event-copy">{eventLabel(event)}</span>
                <time>{eventDisplayDate(event)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty-timeline">任务事件会按时间显示在这里。</div>
        )}
      </section>
    </aside>
  );
}
