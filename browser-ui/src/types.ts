export interface HarnessSession {
  id: string;
  title: string;
  created: string;
}

export interface BrowserConfig {
  allowedOrigins: string[];
  preview: boolean;
}

export type BrowserSessionStatus = 'creating' | 'active' | 'paused' | 'lost' | 'closed' | string;

export interface BrowserSession {
  id: string;
  owner?: string;
  harnessSessionId: string;
  runId: string;
  taskId: string;
  status: BrowserSessionStatus;
  expiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type BrowserActionType = 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'observe';

export interface BrowserActionRequest {
  type: BrowserActionType;
  url?: string;
  ref?: string;
  text?: string;
  values?: string[];
  key?: string;
}

export interface BrowserCommand {
  id: string;
  status: string;
  requestHash: string;
  request: BrowserActionRequest;
  result?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface BrowserEvent {
  id: number;
  type: string;
  payload?: unknown;
  createdAt?: string;
}

export interface BrowserPreview {
  ok: true;
  contentType: 'image/jpeg' | string;
  dataBase64: string;
  capturedAt: string;
  url: string;
  title: string;
  width: number;
  height: number;
}

export interface RunRecord {
  id: string;
  status: string;
  request?: { prompt?: string; [key: string]: unknown };
  result?: unknown;
  error?: unknown;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface RunSubmission {
  sessionId: string;
  key: string;
  prompt: string;
  phase: 'sending' | 'checking' | 'uncertain';
  note?: string;
}

export interface RunLookupResponse {
  found: boolean;
  run?: RunRecord | null;
}

export interface RunCreateResponse {
  run: RunRecord;
  replayed: boolean;
}

export interface SessionDetailResponse {
  session: HarnessSession;
  runs: RunRecord[];
}
