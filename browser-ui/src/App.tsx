import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, BrowserApi } from './api';
import { BrowserViewport } from './components/BrowserViewport';
import { ConnectionGate } from './components/ConnectionGate';
import { Icon } from './components/Icon';
import { ReviewPanel } from './components/ReviewPanel';
import { SessionSidebar } from './components/SessionSidebar';
import {
  browserStatusLabel,
  isRunActive,
  isSafePreviewData,
  runStatusLabel,
} from './format';
import type {
  BrowserCommand,
  BrowserConfig,
  BrowserEvent,
  BrowserPreview,
  BrowserSession,
  HarnessSession,
  RunRecord,
  RunSubmission,
} from './types';

type PreviewState = 'idle' | 'waiting' | 'unavailable' | 'disabled';
type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'idle';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : '请求未完成，请稍后重试。';
}

function newestFirst<T extends { createdAt?: string; created?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt ?? left.created ?? '') || 0;
    const rightTime = Date.parse(right.createdAt ?? right.created ?? '') || 0;
    return rightTime - leftTime;
  });
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function addSession(sessions: HarnessSession[], added: HarnessSession): HarnessSession[] {
  return [added, ...sessions.filter(session => session.id !== added.id)];
}

function removeSubmission(submissions: Record<string, RunSubmission>, sessionId: string): Record<string, RunSubmission> {
  const next = { ...submissions };
  delete next[sessionId];
  return next;
}

export default function App() {
  const [api, setApi] = useState<BrowserApi | null>(null);
  const apiRef = useRef<BrowserApi | null>(null);
  const selectedActionScope = useRef(new AbortController());
  const submissionLocks = useRef(new Set<string>());

  const [authError, setAuthError] = useState('');
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [creatingSession, setCreatingSession] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [config, setConfig] = useState<BrowserConfig | null>(null);
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  const [browserSessions, setBrowserSessions] = useState<BrowserSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [currentBrowserSession, setCurrentBrowserSession] = useState<BrowserSession | null>(null);
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null);
  const [runCache, setRunCache] = useState<Record<string, RunRecord>>({});
  const [commands, setCommands] = useState<BrowserCommand[]>([]);
  const [events, setEvents] = useState<BrowserEvent[]>([]);
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [prompt, setPrompt] = useState('');
  const [submissions, setSubmissions] = useState<Record<string, RunSubmission>>({});
  const [runMessage, setRunMessage] = useState('');
  const [sessionMessage, setSessionMessage] = useState('');
  const [panelError, setPanelError] = useState('');
  const [busyCommandId, setBusyCommandId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [closing, setClosing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const currentSubmission = selectedSessionId ? submissions[selectedSessionId] ?? null : null;
  const previewImageSrc = preview?.contentType === 'image/jpeg' && isSafePreviewData(preview.dataBase64)
    ? `data:image/jpeg;base64,${preview.dataBase64.replace(/[\r\n]/g, '')}`
    : null;

  const resetWorkspace = useCallback((message = '') => {
    apiRef.current?.clear();
    apiRef.current = null;
    submissionLocks.current.clear();
    selectedActionScope.current.abort();
    selectedActionScope.current = new AbortController();
    setApi(null);
    setAuthError(message);
    setWorkspaceLoading(true);
    setCreatingSession(false);
    setWorkspaceError('');
    setConfig(null);
    setSessions([]);
    setBrowserSessions([]);
    setSelectedSessionId(null);
    setCurrentBrowserSession(null);
    setCurrentRun(null);
    setRunCache({});
    setCommands([]);
    setEvents([]);
    setPreview(null);
    setPreviewState('idle');
    setStreamState('idle');
    setPrompt('');
    setSubmissions({});
    setRunMessage('');
    setSessionMessage('');
    setPanelError('');
    setBusyCommandId(null);
    setCanceling(false);
    setClosing(false);
    setRefreshing(false);
  }, []);

  useEffect(() => () => {
    apiRef.current?.clear();
    selectedActionScope.current.abort();
  }, []);

  const connect = useCallback((token: string) => {
    resetWorkspace();
    let client: BrowserApi;
    client = new BrowserApi(token, () => {
      if (apiRef.current === client) resetWorkspace('凭证已失效，请重新连接。');
    });
    apiRef.current = client;
    setApi(client);
    setAuthError('');
  }, [resetWorkspace]);

  useEffect(() => {
    if (!api) return;
    const client = api;
    const controller = new AbortController();
    let alive = true;
    setWorkspaceLoading(true);
    setWorkspaceError('');

    void Promise.all([
      client.getConfig(controller.signal),
      client.getSessions(controller.signal),
      client.getBrowserSessions(controller.signal),
    ]).then(([nextConfig, nextSessions, nextBrowserSessions]) => {
      if (!alive) return;
      const orderedSessions = [...nextSessions].sort((left, right) => (Date.parse(right.created) || 0) - (Date.parse(left.created) || 0));
      setConfig(nextConfig);
      setSessions(orderedSessions);
      setBrowserSessions(newestFirst(nextBrowserSessions));
      setSelectedSessionId(current => current ?? orderedSessions[0]?.id ?? null);
    }).catch(error => {
      if (alive && !isAbort(error)) setWorkspaceError(errorText(error));
    }).finally(() => {
      if (alive) setWorkspaceLoading(false);
    });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [api]);

  const refreshWorkspace = useCallback(async () => {
    const client = apiRef.current;
    if (!client) return;
    const controller = new AbortController();
    setRefreshing(true);
    setWorkspaceError('');
    try {
      const [nextSessions, nextBrowserSessions] = await Promise.all([
        client.getSessions(controller.signal),
        client.getBrowserSessions(controller.signal),
      ]);
      setSessions([...nextSessions].sort((left, right) => (Date.parse(right.created) || 0) - (Date.parse(left.created) || 0)));
      setBrowserSessions(newestFirst(nextBrowserSessions));
      const sessionId = selectedSessionId;
      const sessionSignal = selectedActionScope.current.signal;
      if (sessionId) {
        const matched = newestFirst(nextBrowserSessions.filter(item => item.harnessSessionId === sessionId))[0];
        if (matched) {
          setCurrentBrowserSession(matched);
          const [run, nextCommands] = await Promise.all([
            client.getRun(matched.runId, sessionSignal),
            client.getCommands(matched.id, sessionSignal),
          ]);
          if (!sessionSignal.aborted) {
            setCurrentRun(run);
            setRunCache(existing => ({ ...existing, [sessionId]: run }));
            setCommands(newestFirst(nextCommands));
          }
        } else {
          const detail = await client.getSessionDetail(sessionId, sessionSignal);
          const latestRun = detail.runs?.[0];
          if (latestRun && !sessionSignal.aborted) {
            setCurrentRun(latestRun);
            setRunCache(existing => ({ ...existing, [sessionId]: latestRun }));
          }
        }
      }
    } catch (error) {
      if (!isAbort(error)) setWorkspaceError(errorText(error));
    } finally {
      setRefreshing(false);
    }
  }, [selectedSessionId]);

  const changeSession = useCallback((sessionId: string | null) => {
    selectedActionScope.current.abort();
    selectedActionScope.current = new AbortController();
    setSelectedSessionId(sessionId);
    setCurrentBrowserSession(null);
    setCurrentRun(null);
    setCommands([]);
    setEvents([]);
    setPreview(null);
    setPreviewState('idle');
    setStreamState('idle');
    setPrompt('');
    setRunMessage('');
    setSessionMessage('');
    setPanelError('');
    setBusyCommandId(null);
    setCanceling(false);
    setClosing(false);
  }, []);

  const selectSession = useCallback((session: HarnessSession) => {
    if (session.id === selectedSessionId) return;
    changeSession(session.id);
  }, [changeSession, selectedSessionId]);

  const createSession = useCallback(async (title: string) => {
    const client = apiRef.current;
    if (!client) return;
    const scope = selectedActionScope.current;
    setCreatingSession(true);
    setWorkspaceError('');
    try {
      const created = await client.createSession(title, scope.signal);
      if (scope.signal.aborted || apiRef.current !== client) return;
      setSessions(existing => addSession(existing, created));
      changeSession(created.id);
      setSessionMessage('会话已创建。描述你的目标后即可开始任务。');
    } catch (error) {
      if (!isAbort(error)) setWorkspaceError(errorText(error));
    } finally {
      if (apiRef.current === client) setCreatingSession(false);
    }
  }, [changeSession]);

  useEffect(() => {
    if (!api || !selectedSessionId) {
      setCurrentBrowserSession(null);
      setCurrentRun(null);
      setCommands([]);
      return;
    }
    const client = api;

    const controller = new AbortController();
    let alive = true;
    const candidates = browserSessions
      .filter(browserSession => browserSession.harnessSessionId === selectedSessionId)
      .sort((left, right) => (Date.parse(right.createdAt ?? '') || 0) - (Date.parse(left.createdAt ?? '') || 0));
    const matched = candidates[0];

    setCurrentBrowserSession(matched ?? null);
    setCurrentRun(null);
    setCommands([]);

    if (matched) {
      void Promise.all([client.getRun(matched.runId, controller.signal), client.getCommands(matched.id, controller.signal)])
        .then(([run, nextCommands]) => {
          if (!alive) return;
          setCurrentRun(run);
          setRunCache(existing => ({ ...existing, [selectedSessionId]: run }));
          setCommands(newestFirst(nextCommands));
        })
        .catch(error => {
          if (alive && !isAbort(error)) setPanelError(errorText(error));
        });
    } else {
      const cached = runCache[selectedSessionId];
      if (cached) setCurrentRun(cached);
      void client.getSessionDetail(selectedSessionId, controller.signal).then(detail => {
        if (!alive) return;
        const latestRun = detail.runs?.[0];
        if (!latestRun) return;
        setCurrentRun(latestRun);
        setRunCache(existing => ({ ...existing, [selectedSessionId]: latestRun }));
      }).catch(error => {
        if (alive && !isAbort(error) && error instanceof ApiError && error.status !== 404) setRunMessage(error.message);
      });
    }

    return () => {
      alive = false;
      controller.abort();
    };
  }, [api, selectedSessionId]);

  useEffect(() => {
    if (!api || !selectedSessionId || !currentRun || !isRunActive(currentRun.status)) return;
    const client = api;
    const controller = new AbortController();
    let busy = false;
    const sessionId = selectedSessionId;
    const runId = currentRun.id;

    async function pollRunAndBrowser() {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const updatedRun = await client.getRun(runId, controller.signal);
        if (controller.signal.aborted) return;
        setCurrentRun(current => current?.id === runId ? updatedRun : current);
        setRunCache(existing => ({ ...existing, [sessionId]: updatedRun }));
      } catch {
        // Polling resumes on the next interval; transient network errors do not replace the last known state.
      } finally {
        busy = false;
      }
    }

    void pollRunAndBrowser();
    const timer = setInterval(() => void pollRunAndBrowser(), 2_500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [api, selectedSessionId, currentRun?.id, currentRun?.status]);

  useEffect(() => {
    if (!api || !selectedSessionId || !currentRun || currentBrowserSession?.runId === currentRun.id) return;
    const client = api;
    const controller = new AbortController();
    let alive = true;
    let attempts = 0;
    let busy = false;
    const sessionId = selectedSessionId;
    const runId = currentRun.id;

    async function discoverBrowserSession() {
      if (busy || controller.signal.aborted || attempts >= 20) return;
      busy = true;
      attempts += 1;
      try {
        const nextBrowserSessions = await client.getBrowserSessions(controller.signal);
        if (!alive || controller.signal.aborted) return;
        setBrowserSessions(newestFirst(nextBrowserSessions));
        const matched = newestFirst(nextBrowserSessions.filter(item => item.harnessSessionId === sessionId && item.runId === runId))[0];
        if (matched) setCurrentBrowserSession(matched);
      } catch {
        // A later lookup can recover if the browser session is created after the run response.
      } finally {
        busy = false;
      }
    }

    void discoverBrowserSession();
    const timer = setInterval(() => void discoverBrowserSession(), 2_500);
    return () => {
      alive = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [api, selectedSessionId, currentRun?.id, currentBrowserSession?.runId]);

  useEffect(() => {
    if (!api || !currentBrowserSession) {
      setCommands([]);
      return;
    }
    const client = api;
    const controller = new AbortController();
    let alive = true;
    let busy = false;
    const browserSessionId = currentBrowserSession.id;

    async function refreshCommands() {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const next = await client.getCommands(browserSessionId, controller.signal);
        if (alive) setCommands(newestFirst(next));
      } catch (error) {
        if (alive && !isAbort(error) && error instanceof ApiError && error.status !== 404) setPanelError(error.message);
      } finally {
        busy = false;
      }
    }

    void refreshCommands();
    const timer = currentBrowserSession.status === 'active' ? setInterval(() => void refreshCommands(), 2_500) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      controller.abort();
    };
  }, [api, currentBrowserSession?.id, currentBrowserSession?.status]);

  useEffect(() => {
    const browserSession = currentBrowserSession;
    if (!api || !browserSession || browserSession.status !== 'active') return;
    const client = api;
    if (config?.preview !== true) {
      setPreviewState('disabled');
      return;
    }

    const controller = new AbortController();
    let alive = true;
    let inFlight = false;
    let lastRequestAt = 0;
    const sessionId = browserSession.id;

    async function capturePreview() {
      const now = Date.now();
      if (!alive || controller.signal.aborted || document.visibilityState !== 'visible' || inFlight || now - lastRequestAt < 3_000) return;
      inFlight = true;
      lastRequestAt = now;
      setPreviewState('waiting');
      try {
        const next = await client.getPreview(sessionId, controller.signal);
        if (!alive || controller.signal.aborted) return;
        if (next.ok === true && next.contentType === 'image/jpeg' && isSafePreviewData(next.dataBase64)) {
          setPreview(next);
          setPreviewState('idle');
        } else {
          setPreviewState('unavailable');
        }
      } catch (error) {
        if (!alive || isAbort(error)) return;
        if (error instanceof ApiError && (error.status === 409 || error.status === 429)) setPreviewState('waiting');
        else setPreviewState('unavailable');
      } finally {
        inFlight = false;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') void capturePreview();
    }

    void capturePreview();
    const timer = setInterval(() => void capturePreview(), 3_000);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      controller.abort();
    };
  }, [api, config?.preview, currentBrowserSession?.id, currentBrowserSession?.status]);

  useEffect(() => {
    if (!api || !currentBrowserSession || currentBrowserSession.status !== 'active') {
      setStreamState('idle');
      return;
    }
    const client = api;

    const controller = new AbortController();
    let alive = true;
    let cursor = 0;
    let backoff = 1_000;
    const sessionId = currentBrowserSession.id;
    setEvents([]);
    setStreamState('connecting');

    async function reconnectLoop() {
      while (alive && !controller.signal.aborted) {
        try {
          await client.streamEvents(
            sessionId,
            cursor,
            event => {
              if (!alive || event.id <= cursor) return;
              cursor = event.id;
              setEvents(previous => [...previous, event].slice(-300));
            },
            () => {
              if (alive) setStreamState('connected');
              backoff = 1_000;
            },
            controller.signal,
          );
          if (alive && !controller.signal.aborted) setStreamState('reconnecting');
        } catch (error) {
          if (!alive || controller.signal.aborted || isAbort(error)) break;
          setStreamState('reconnecting');
        }
        if (!alive || controller.signal.aborted) break;
        await pause(backoff, controller.signal);
        backoff = Math.min(10_000, backoff * 2);
      }
    }

    void reconnectLoop();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [api, currentBrowserSession?.id, currentBrowserSession?.status]);

  const lookupSubmission = useCallback(async (
    submission: RunSubmission,
    signal: AbortSignal,
    client: BrowserApi,
  ) => {
    setSubmissions(existing => ({
      ...existing,
      [submission.sessionId]: { ...submission, phase: 'checking', note: '正在使用原提交身份查询服务端记录。' },
    }));
    try {
      const result = await client.lookupRun(submission.sessionId, submission.key, signal);
      if (signal.aborted || apiRef.current !== client) return;
      if (result.found && result.run) {
        submissionLocks.current.delete(submission.sessionId);
        setRunCache(existing => ({ ...existing, [submission.sessionId]: result.run as RunRecord }));
        setSubmissions(existing => removeSubmission(existing, submission.sessionId));
        if (selectedSessionId === submission.sessionId) {
          setCurrentRun(result.run);
          setCurrentBrowserSession(null);
          setCommands([]);
          setPreview(null);
          setRunMessage('提交已找到，任务没有重复发送。');
        }
      } else {
        setSubmissions(existing => ({
          ...existing,
          [submission.sessionId]: { ...submission, phase: 'uncertain', note: '暂未查到服务端记录。可稍后再次核对；系统不会自动重投。' },
        }));
      }
    } catch (error) {
      if (apiRef.current !== client || !client.connected) return;
      if (signal.aborted) {
        setSubmissions(existing => ({
          ...existing,
          [submission.sessionId]: { ...submission, phase: 'uncertain', note: '核对请求已中断，原提交身份仍保留。' },
        }));
      } else {
        setSubmissions(existing => ({
          ...existing,
          [submission.sessionId]: { ...submission, phase: 'uncertain', note: errorText(error) },
        }));
      }
    }
  }, [selectedSessionId]);

  const submitRun = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const client = apiRef.current;
    const sessionId = selectedSessionId;
    const cleanPrompt = prompt.trim();
    if (!client || !sessionId || !cleanPrompt || submissions[sessionId] || submissionLocks.current.has(sessionId) || isRunActive(currentRun?.status)) return;

    const key = crypto.randomUUID();
    const submission: RunSubmission = { sessionId, key, prompt: cleanPrompt, phase: 'sending' };
    const scope = selectedActionScope.current;
    submissionLocks.current.add(sessionId);
    setSubmissions(existing => ({ ...existing, [sessionId]: submission }));
    setCurrentRun(null);
    setCurrentBrowserSession(null);
    setCommands([]);
    setEvents([]);
    setPreview(null);
    setPreviewState('idle');
    setRunMessage('');
    setSessionMessage('');

    try {
      const result = await client.createRun(sessionId, cleanPrompt, key, scope.signal);
      if (apiRef.current !== client) return;
      if (scope.signal.aborted) {
        setSubmissions(existing => ({
          ...existing,
          [sessionId]: { ...submission, phase: 'uncertain', note: '会话已切换，提交状态尚未确认。返回此会话后核对，不会自动重投。' },
        }));
        return;
      }
      submissionLocks.current.delete(sessionId);
      setSubmissions(existing => removeSubmission(existing, sessionId));
      setCurrentRun(result.run);
      setRunCache(existing => ({ ...existing, [sessionId]: result.run }));
      setSessionMessage(result.replayed ? '已找到这次任务的原提交记录。' : '任务已提交，浏览器页面准备就绪后会自动显示。');
    } catch (error) {
      if (apiRef.current !== client || !client.connected) return;
      if (isAbort(error)) {
        setSubmissions(existing => ({
          ...existing,
          [sessionId]: { ...submission, phase: 'uncertain', note: '连接已切换，提交状态尚未确认。返回此会话后核对，不会自动重投。' },
        }));
        return;
      }
      if (error instanceof ApiError && error.uncertain) {
        const pending = { ...submission, phase: 'checking' as const, note: '连接中断，正在按原提交身份核对。' };
        setSubmissions(existing => ({ ...existing, [sessionId]: pending }));
        await lookupSubmission(pending, scope.signal, client);
      } else {
        submissionLocks.current.delete(sessionId);
        setSubmissions(existing => removeSubmission(existing, sessionId));
        if (selectedSessionId === sessionId) setRunMessage(errorText(error));
      }
    }
  }, [currentRun?.status, lookupSubmission, prompt, selectedSessionId, submissions]);

  const reconcileCurrentSubmission = useCallback(() => {
    if (!currentSubmission || !apiRef.current) return;
    void lookupSubmission(currentSubmission, selectedActionScope.current.signal, apiRef.current);
  }, [currentSubmission, lookupSubmission]);

  const decideCommand = useCallback(async (command: BrowserCommand, decision: 'approve' | 'reject') => {
    const client = apiRef.current;
    const sessionId = currentBrowserSession?.id;
    const runId = currentRun?.id;
    if (!client || !sessionId || !runId || !isRunActive(currentRun?.status)) return;
    const scope = selectedActionScope.current;
    setBusyCommandId(command.id);
    setPanelError('');
    try {
      await client.decide(command.id, decision, command.requestHash, scope.signal);
      if (scope.signal.aborted || apiRef.current !== client) return;
      const updated = await client.getCommands(sessionId, scope.signal);
      setCommands(newestFirst(updated));
    } catch (error) {
      if (!isAbort(error)) setPanelError(errorText(error));
    } finally {
      if (!scope.signal.aborted) setBusyCommandId(null);
    }
  }, [currentBrowserSession?.id, currentRun?.id, currentRun?.status]);

  const cancelRun = useCallback(async () => {
    const client = apiRef.current;
    const runId = currentRun?.id;
    const sessionId = selectedSessionId;
    if (!client || !runId || !sessionId || !isRunActive(currentRun?.status)) return;
    const scope = selectedActionScope.current;
    setCanceling(true);
    setRunMessage('');
    try {
      await client.cancelRun(runId, scope.signal);
      if (scope.signal.aborted || apiRef.current !== client) return;
      setRunMessage('已请求停止任务，状态更新后会显示在这里。');
      const updated = await client.getRun(runId, scope.signal);
      setCurrentRun(updated);
      setRunCache(existing => ({ ...existing, [sessionId]: updated }));
    } catch (error) {
      if (!isAbort(error)) setRunMessage(errorText(error));
    } finally {
      if (!scope.signal.aborted) setCanceling(false);
    }
  }, [currentRun?.id, currentRun?.status, selectedSessionId]);

  const closeBrowser = useCallback(async () => {
    const client = apiRef.current;
    const session = currentBrowserSession;
    if (!client || !session || session.status !== 'active') return;
    const scope = selectedActionScope.current;
    setClosing(true);
    setPanelError('');
    try {
      await client.closeBrowserSession(session.id, scope.signal);
      if (scope.signal.aborted || apiRef.current !== client) return;
      setCurrentBrowserSession(current => current?.id === session.id ? { ...current, status: 'closed' } : current);
      setBrowserSessions(existing => existing.map(item => item.id === session.id ? { ...item, status: 'closed' } : item));
      setSessionMessage('浏览器会话已关闭。');
      const updatedCommands = await client.getCommands(session.id, scope.signal);
      setCommands(newestFirst(updatedCommands));
    } catch (error) {
      if (!isAbort(error)) setPanelError(errorText(error));
    } finally {
      if (!scope.signal.aborted) setClosing(false);
    }
  }, [currentBrowserSession]);

  if (!api) {
    return <ConnectionGate busy={false} error={authError} onConnect={connect} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark"><Icon name="spark" size={20} /></span>
          <span className="brand-copy"><strong>mini-DSH-bot</strong><span>浏览器工作台</span></span>
        </div>
        <div className="topbar-center"><span className="topbar-center-dot" />受控浏览 · 人工确认</div>
        <div className="topbar-actions">
          {config && <span className="allowed-sites"><Icon name="globe" size={15} />允许 {config.allowedOrigins.length} 个网站</span>}
          <span className="connection-state"><span className="status-dot" />已连接</span>
          <button className="topbar-text-button" type="button" onClick={() => resetWorkspace('请使用新的工作台凭证连接。')}>更换凭证</button>
          <button className="topbar-exit" type="button" onClick={() => resetWorkspace()}><Icon name="logout" size={16} />退出</button>
        </div>
      </header>

      {workspaceError && <div className="workspace-alert" role="alert"><Icon name="alert" size={16} /><span>{workspaceError}</span><button type="button" onClick={() => setWorkspaceError('')} aria-label="关闭提示"><Icon name="close" size={15} /></button></div>}

      <div className="workspace-grid">
        <SessionSidebar
          sessions={sessions}
          selectedId={selectedSessionId}
          loading={workspaceLoading || refreshing}
          creating={creatingSession}
          onRefresh={() => void refreshWorkspace()}
          onSelect={selectSession}
          onCreate={title => void createSession(title)}
        />

        <BrowserViewport
          session={selectedSession}
          browserSession={currentBrowserSession}
          run={currentRun}
          prompt={prompt}
          submission={currentSubmission}
          preview={preview}
          previewImageSrc={previewImageSrc}
          previewState={previewState}
          canSubmit={Boolean(selectedSession && prompt.trim() && !currentSubmission && !isRunActive(currentRun?.status) && !submissionLocks.current.has(selectedSession.id))}
          submitting={currentSubmission?.phase === 'sending'}
          canceling={canceling}
          closing={closing}
          sessionMessage={sessionMessage}
          runMessage={runMessage}
          onPromptChange={setPrompt}
          onSubmit={event => void submitRun(event)}
          onReconcile={reconcileCurrentSubmission}
          onCancelRun={() => void cancelRun()}
          onCloseBrowser={() => void closeBrowser()}
        />

        <ReviewPanel
          commands={commands}
          events={events}
          browserSession={currentBrowserSession}
          run={currentRun}
          allowedOrigins={config?.allowedOrigins ?? []}
          streamState={streamState}
          busyCommandId={busyCommandId}
          panelError={panelError}
          onDecision={(command, decision) => void decideCommand(command, decision)}
        />
      </div>

      <footer className="workspace-footer">
        <span><Icon name="shield" size={14} />页面截图只读展示；不会嵌入或执行网页代码。</span>
        <span>{currentRun ? `${runStatusLabel(currentRun.status)} · ` : ''}{currentBrowserSession ? browserStatusLabel(currentBrowserSession.status) : '等待任务'}</span>
      </footer>
    </div>
  );
}
