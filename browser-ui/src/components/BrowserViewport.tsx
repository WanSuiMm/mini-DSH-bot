import { useState, type FormEvent } from 'react';
import type { BrowserPreview, BrowserSession, HarnessSession, RunRecord, RunSubmission } from '../types';
import { browserStatusLabel, formatTime, isRunActive, resultText, runStatusLabel } from '../format';
import { Icon } from './Icon';

interface BrowserViewportProps {
  session: HarnessSession | null;
  browserSession: BrowserSession | null;
  run: RunRecord | null;
  prompt: string;
  submission: RunSubmission | null;
  preview: BrowserPreview | null;
  previewImageSrc: string | null;
  previewState: 'idle' | 'waiting' | 'unavailable' | 'disabled';
  canSubmit: boolean;
  submitting: boolean;
  canceling: boolean;
  closing: boolean;
  sessionMessage: string;
  runMessage: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReconcile: () => void;
  onCancelRun: () => void;
  onCloseBrowser: () => void;
}

export function BrowserViewport({
  session,
  browserSession,
  run,
  prompt,
  submission,
  preview,
  previewImageSrc,
  previewState,
  canSubmit,
  submitting,
  canceling,
  closing,
  sessionMessage,
  runMessage,
  onPromptChange,
  onSubmit,
  onReconcile,
  onCancelRun,
  onCloseBrowser,
}: BrowserViewportProps) {
  const [confirmClose, setConfirmClose] = useState(false);
  const output = run ? resultText(run).slice(0, 12_000) : '';
  const showCancel = run && isRunActive(run.status);
  const shownUrl = preview?.url ?? '';

  function closeBrowser() {
    setConfirmClose(false);
    onCloseBrowser();
  }

  return (
    <main className="main-column">
      <section className="panel browser-panel">
        <div className="browser-panel-heading">
          <div className="browser-panel-title-group">
            <span className="eyebrow">BROWSER SESSION</span>
            <div className="browser-title-row">
              <h2>{session?.title || '浏览器页面'}</h2>
              {browserSession && (
                <span className={`browser-status status-${browserSession.status}`}>
                  <span className="status-dot" />{browserStatusLabel(browserSession.status)}
                </span>
              )}
            </div>
          </div>
          <div className="browser-heading-actions">
            {showCancel && (
              <button className="button button-quiet-danger" type="button" onClick={onCancelRun} disabled={canceling}>
                <Icon name="stop" size={15} />{canceling ? '正在停止…' : '停止任务'}
              </button>
            )}
            {browserSession?.status === 'active' && !confirmClose && (
              <button className="button button-quiet" type="button" onClick={() => setConfirmClose(true)} disabled={closing}>
                <Icon name="close" size={15} />关闭页面
              </button>
            )}
          </div>
        </div>

        {confirmClose && (
          <div className="close-confirm" role="group" aria-label="确认关闭浏览器页面">
            <span>关闭页面会结束此浏览器会话。</span>
            <button className="button button-small button-danger" type="button" onClick={closeBrowser} disabled={closing}>{closing ? '正在关闭…' : '确认关闭'}</button>
            <button className="button button-small button-quiet" type="button" onClick={() => setConfirmClose(false)}>保留页面</button>
          </div>
        )}

        <div className="address-bar" aria-label="当前页面地址">
          <span className="address-lock"><Icon name="lock" size={15} /></span>
          <span className={`address-text${shownUrl ? '' : ' address-placeholder'}`} title={shownUrl || undefined}>
            {shownUrl || (browserSession ? '页面地址将在截图到达后显示' : '提交网页任务后，页面预览会显示在这里')}
          </span>
          {preview?.capturedAt && <span className="preview-time">截图 {formatTime(preview.capturedAt)}</span>}
        </div>

        <div className={`preview-stage${previewImageSrc ? ' has-preview' : ''}`}>
          {previewImageSrc ? (
            <img className="preview-image" src={previewImageSrc} alt={preview?.title ? `网页预览：${preview.title}` : '当前网页截图'} />
          ) : (
            <div className="preview-empty">
              <span className="preview-empty-art"><Icon name="screen" size={30} /></span>
              <strong>{previewState === 'disabled' ? '页面预览暂不可用' : browserSession ? '正在等待页面画面' : '准备好开始网页任务'}</strong>
              <span>
                {previewState === 'disabled'
                  ? '当前服务没有开放截图预览。'
                  : browserSession
                    ? previewState === 'unavailable' ? '页面暂时没有更新，请稍后查看。' : '浏览器启动后，真实页面截图会显示在这里。'
                    : '提交任务后，工作台会显示浏览器返回的真实截图。'}
              </span>
            </div>
          )}
          {preview && <span className="preview-dimensions">{preview.width} × {preview.height}</span>}
        </div>

        {sessionMessage && <div className="main-message" role="status">{sessionMessage}</div>}

        {run && (run.status === 'timed_out' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'unknown') && (
          <div className={`run-notice${run.status === 'timed_out' || run.status === 'unknown' ? ' run-notice-warning' : ''}`}>
            <Icon name={run.status === 'timed_out' || run.status === 'unknown' ? 'alert' : 'clock'} size={16} />
            <span>
              {run.status === 'timed_out'
                ? '任务已超时，旧任务不会继续。'
                : run.status === 'unknown'
                  ? '结果待核对。请检查页面或业务记录后再决定下一步。'
                  : run.status === 'cancelled'
                    ? '任务已停止。'
                    : '任务未完成。可查看已返回的执行记录。'}
            </span>
          </div>
        )}

        {run && output && (
          <section className="run-result-card">
            <div className="result-heading">
              <div><span className="eyebrow">TASK RESULT</span><h3>任务返回</h3></div>
              <span className={`run-status run-status-${run.status}`}>{runStatusLabel(run.status)}</span>
            </div>
            <pre className="result-copy">{output}{resultText(run).length > 12_000 ? '\n\n内容过长，已折叠显示。' : ''}</pre>
          </section>
        )}
      </section>

      <section className="panel composer-panel">
        <div className="composer-heading">
          <div>
            <span className="eyebrow">NEW TASK</span>
            <h2>告诉 Agent 你要完成什么</h2>
          </div>
          {run && <span className={`run-status run-status-${run.status}`}>{runStatusLabel(run.status)}</span>}
        </div>

        {submission && (
          <div className={`submission-state submission-${submission.phase}`} role="status">
            <span className="submission-state-icon"><Icon name={submission.phase === 'uncertain' ? 'alert' : 'clock'} size={16} /></span>
            <span className="submission-copy">
              <strong>{submission.phase === 'sending' ? '正在提交任务' : submission.phase === 'checking' ? '正在核对提交结果' : '提交结果需要核对'}</strong>
              <span>{submission.note || (submission.phase === 'uncertain' ? '不会自动重投。使用原提交身份查询服务端记录。' : '请稍候，工作台正在确认服务端状态。')}</span>
            </span>
            {submission.phase === 'uncertain' && <button className="button button-small button-outline" type="button" onClick={onReconcile}>核对提交结果</button>}
          </div>
        )}

        {runMessage && <div className="inline-error run-error" role="alert">{runMessage}</div>}

        <form className="task-composer" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor="task-prompt">任务描述</label>
          <textarea
            id="task-prompt"
            value={prompt}
            onChange={event => onPromptChange(event.target.value)}
            placeholder={session ? '描述目标、需要查看的网站，以及你希望 Agent 交付的结果…' : '请先在左侧新建或选择一个会话。'}
            maxLength={12_000}
            disabled={!session || Boolean(submission) || submitting}
            rows={3}
          />
          <div className="composer-footer">
            <div className="composer-hint">
              <Icon name="shield" size={15} />
              <span>页面写入操作会先展示具体内容，等待你确认。</span>
            </div>
            <div className="composer-submit-group">
              <span className="character-count">{prompt.length.toLocaleString('zh-CN')} / 12,000</span>
              <button className="button button-primary submit-task" type="submit" disabled={!canSubmit || submitting || Boolean(submission)}>
                {submitting ? '正在开始…' : '开始任务'}
                {!submitting && <Icon name="send" size={16} />}
              </button>
            </div>
          </div>
          {!session && <p className="composer-empty-hint">新建任务会话后，即可在这里提交任务。</p>}
        </form>
      </section>
    </main>
  );
}
