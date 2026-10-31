import type { BrowserActionRequest, BrowserCommand, BrowserEvent, RunRecord } from './types';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value?: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormatter.format(date);
}

export function formatTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

export function runStatusLabel(status?: string): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '正在执行';
    case 'waiting': return '等待确认';
    case 'succeeded': return '已返回结果';
    case 'partial': return '部分完成';
    case 'failed': return '未完成';
    case 'cancelled': return '已取消';
    case 'timed_out': return '已超时';
    case 'unknown': return '结果待核对';
    default: return status || '尚未开始';
  }
}

export function browserStatusLabel(status?: string): string {
  switch (status) {
    case 'creating': return '正在打开';
    case 'active': return '页面已连接';
    case 'paused': return '已暂停';
    case 'lost': return '连接中断';
    case 'closed': return '已关闭';
    default: return status || '状态未知';
  }
}

export function commandStatusLabel(status?: string): string {
  switch (status) {
    case 'pending_approval': return '等待你确认';
    case 'ready': return '等待执行';
    case 'running': return '正在执行';
    case 'succeeded': return '动作已返回';
    case 'failed': return '执行未完成';
    case 'unknown': return '结果待核对';
    case 'rejected': return '已拒绝';
    default: return status || '状态未知';
  }
}

export function actionLabel(request?: BrowserActionRequest): string {
  switch (request?.type) {
    case 'navigate': return '打开网页';
    case 'click': return '点击页面元素';
    case 'fill': return '填写内容';
    case 'select': return '选择选项';
    case 'press': return '按下按键';
    case 'observe': return '查看页面';
    default: return '页面操作';
  }
}

export function eventLabel(event: BrowserEvent): string {
  const known: Record<string, string> = {
    'browser.session.opened': '浏览器页面已打开',
    'browser.session.closed': '浏览器页面已关闭',
    'browser.approval.required': '有操作等待确认',
    'browser.approval.granted': '操作已获确认',
    'browser.approval.rejected': '操作已拒绝',
    'browser.command.started': '页面动作开始执行',
    'browser.command.succeeded': '页面动作已返回',
    'session.transition': '浏览器会话状态已更新',
    'session.recovered_lost': '浏览器会话已恢复',
    'session.created': '浏览器会话已创建',
    'session.active': '浏览器页面已就绪',
    'session.paused': '浏览器会话已暂停',
    'session.closed': '浏览器会话已关闭',
    'session.lost': '浏览器连接中断',
    'command.pending_approval': '有操作等待确认',
    'command.approved': '操作已获确认',
    'command.rejected': '操作已拒绝',
    'command.succeeded': '页面动作已返回',
    'command.failed': '页面动作未完成',
    'command.unknown': '页面动作结果待核对',
    'run.started': '任务开始执行',
    'run.waiting': '任务等待确认',
    'run.succeeded': '任务已返回结果',
    'run.failed': '任务未完成',
    'run.cancelled': '任务已取消',
    'run.timed_out': '任务已超时',
  };
  return known[event.type] ?? '执行状态有更新';
}

export function isRunActive(status?: string): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}

export function isRunTerminal(status?: string): boolean {
  return ['succeeded', 'partial', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(status ?? '');
}

export function isCommandActionable(command: BrowserCommand, run?: RunRecord | null): boolean {
  return command.status === 'pending_approval' && isRunActive(run?.status);
}

export function isSafePreviewData(value: string): boolean {
  const compact = value.replace(/[\r\n]/g, '');
  return compact.length > 0
    && compact.length <= 1_050_000
    && compact.startsWith('/9j/')
    && /^[A-Za-z0-9+/=]+$/.test(compact);
}

export function resultText(run: RunRecord): string {
  const value = run.result;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['answer', 'text', 'summary', 'message', 'output']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '结果内容无法显示。';
  }
}

export function requestOriginAllowed(request: BrowserActionRequest, allowedOrigins: string[]): boolean | null {
  if (!request.url) return null;
  try {
    const origin = new URL(request.url).origin;
    const normalized = new Set(allowedOrigins.flatMap(item => {
      try { return [new URL(item).origin]; } catch { return []; }
    }));
    return normalized.has(origin);
  } catch {
    return false;
  }
}

export function eventDisplayDate(event: BrowserEvent): string {
  return formatTime(event.createdAt);
}
