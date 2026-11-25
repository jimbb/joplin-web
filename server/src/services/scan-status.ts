import { config } from '../config.js';
import { createHash } from 'node:crypto';

const ACTIVE_STAGES = new Set(['received', 'importing', 'queued', 'ocr', 'syncing']);
const TERMINAL_STAGES = new Set(['done', 'skipped', 'failed']);
const KNOWN_STAGES = new Set([...ACTIVE_STAGES, ...TERMINAL_STAGES]);
const CYCLE_PHASES = new Set(['idle', 'sync', 'import', 'ocr', 'upload']);
const ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;
const JOPLIN_ID_PATTERN = /^[0-9a-f]{32}$/;
const CACHE_TTL_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type ScanStage = 'received' | 'importing' | 'queued' | 'ocr' | 'syncing' | 'done' | 'skipped' | 'failed';
export type ScanCyclePhase = 'idle' | 'sync' | 'import' | 'ocr' | 'upload';

export interface ScanJobStatus {
  id: string;
  name: string;
  size: number;
  stage: ScanStage;
  receivedAt: string;
  updatedAt: string;
  doneAt: string | null;
  noteId: string | null;
  resourceId: string | null;
  pages: number | null;
  page: number | null;
  error: string | null;
  queuePosition: number | null;
  stalled: boolean;
}

export interface ScanCycleStatus {
  phase: ScanCyclePhase;
  running: boolean;
  startedAt: string | null;
  phaseAt: string | null;
  finishedAt: string | null;
  result: 'ok' | 'failed' | null;
  ocrTotal: number;
  ocrDone: number;
  nextRunAt: string | null;
}

export interface ScanStatusResponse {
  enabled: boolean;
  available?: boolean;
  error?: string;
  active?: number;
  cycle?: ScanCycleStatus;
  jobs?: ScanJobStatus[];
  recent?: ScanJobStatus[];
}

export interface ScanStatusDeps {
  ocrServiceUrl?: string | null;
  ocrServiceSecret?: string | null;
  scanStatusEmails?: string[];
  scanStatusFake?: boolean;
  fetchFn?: typeof fetch;
  /** Supplies a decoded bridge answer in tests without opening a socket. */
  source?: () => Promise<unknown>;
  now?: () => number;
}

interface BridgeJob extends Record<string, unknown> {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  stage?: unknown;
  receivedAt?: unknown;
  updatedAt?: unknown;
  doneAt?: unknown;
  noteId?: unknown;
  resourceId?: unknown;
  pages?: unknown;
  page?: unknown;
  error?: unknown;
}

function asTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function asNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : asTimestamp(value);
}

function asNonNegativeInt(value: unknown, fallback: number | null = null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function asJoplinId(value: unknown): string | null {
  return typeof value === 'string' && JOPLIN_ID_PATTERN.test(value) ? value : null;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function demoId(key: string): string {
  return createHash('md5').update(`joplin-web-demo:${key}`).digest('hex');
}

function errorMessage(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeJob(raw: unknown): ScanJobStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as BridgeJob;
  const id = typeof item.id === 'string' && ID_PATTERN.test(item.id) ? item.id : null;
  const stage = typeof item.stage === 'string' && KNOWN_STAGES.has(item.stage) ? (item.stage as ScanStage) : null;
  const receivedAt = asTimestamp(item.receivedAt);
  if (!id || !stage || !receivedAt) return null;
  const updatedAt = asTimestamp(item.updatedAt) ?? receivedAt;
  const doneAt = asNullableTimestamp(item.doneAt);
  const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0 ? item.size : 0;
  const pages = asNonNegativeInt(item.pages);
  const page = asNonNegativeInt(item.page);
  return {
    id,
    name: typeof item.name === 'string' ? item.name : '',
    size,
    stage,
    receivedAt,
    updatedAt,
    doneAt,
    noteId: asJoplinId(item.noteId),
    resourceId: asJoplinId(item.resourceId),
    pages,
    page,
    error: errorMessage(item.error),
    queuePosition: null,
    stalled: false,
  };
}

function normalizeCycle(raw: unknown): ScanCycleStatus {
  const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const phase = typeof item.phase === 'string' && CYCLE_PHASES.has(item.phase) ? (item.phase as ScanCyclePhase) : 'idle';
  const running = item.running === true;
  const result = item.result === 'ok' || item.result === 'failed' ? item.result : null;
  return {
    phase,
    running,
    startedAt: asNullableTimestamp(item.startedAt),
    phaseAt: asNullableTimestamp(item.phaseAt),
    finishedAt: asNullableTimestamp(item.finishedAt),
    result,
    ocrTotal: asNonNegativeInt(item.ocrTotal, 0) ?? 0,
    ocrDone: asNonNegativeInt(item.ocrDone, 0) ?? 0,
    nextRunAt: asNullableTimestamp(item.nextRunAt),
  };
}

function normalizeBridgeAnswer(raw: unknown, now: number): ScanStatusResponse {
  if (!raw || typeof raw !== 'object') throw new Error('OCR bridge returned invalid JSON');
  const input = raw as Record<string, unknown>;
  if (input.ok === false) throw new Error('OCR bridge reported an error');
  const cycle = normalizeCycle(input.cycle);
  const jobs = Array.isArray(input.jobs)
    ? input.jobs.map((job) => normalizeJob(job)).filter((job): job is ScanJobStatus => job !== null)
    : [];
  const activeJobs = jobs.filter((job) => ACTIVE_STAGES.has(job.stage));
  activeJobs.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  let queuePosition = 0;
  for (const job of activeJobs) {
    if (job.stage === 'queued') {
      queuePosition += 1;
      job.queuePosition = queuePosition;
    }
    job.stalled = !cycle.running && ['importing', 'ocr', 'syncing'].includes(job.stage);
  }

  const recent = jobs
    .filter((job) => TERMINAL_STAGES.has(job.stage))
    .filter((job) => {
      const finished = job.doneAt ? Date.parse(job.doneAt) : Date.parse(job.updatedAt);
      return Number.isFinite(finished) && now - finished >= 0 && now - finished <= RECENT_WINDOW_MS;
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.doneAt ?? a.updatedAt);
      const bTime = Date.parse(b.doneAt ?? b.updatedAt);
      return bTime - aTime;
    })
    .slice(0, 10);

  return { enabled: true, available: true, active: activeJobs.length, cycle, jobs: activeJobs, recent };
}

function fakeStatus(now: number): ScanStatusResponse {
  const cycle: ScanCycleStatus = {
    phase: 'ocr',
    running: true,
    startedAt: isoAt(now - 90_000),
    phaseAt: isoAt(now - 45_000),
    finishedAt: isoAt(now - 6 * 60_000),
    result: 'ok',
    ocrTotal: 3,
    ocrDone: 1,
    nextRunAt: isoAt(now + 6 * 60_000),
  };
  const base = {
    size: 482_113,
    updatedAt: isoAt(now - 90_000),
    doneAt: null,
    noteId: null,
    resourceId: null,
    pages: null,
    page: null,
    error: null,
    queuePosition: null,
    stalled: false,
  };
  const jobs: ScanJobStatus[] = [
    {
      ...base,
      id: demoId('scan-received'),
      name: '11262026004434.pdf',
      stage: 'received',
      receivedAt: isoAt(now - 18 * 60_000),
      updatedAt: isoAt(now - 18 * 60_000),
    },
    {
      ...base,
      id: demoId('scan-queued'),
      name: 'receipt-1126.jpg',
      stage: 'queued',
      receivedAt: isoAt(now - 12 * 60_000),
      updatedAt: isoAt(now - 10 * 60_000),
      noteId: demoId('note-scanned-invoice'),
      resourceId: demoId('res-scanned-invoice'),
      queuePosition: 1,
    },
    {
      ...base,
      id: demoId('scan-ocr'),
      name: 'annual-statement.pdf',
      stage: 'ocr',
      receivedAt: isoAt(now - 6 * 60_000),
      updatedAt: isoAt(now - 30_000),
      noteId: demoId('note-scanned-invoice'),
      resourceId: demoId('res-scanned-invoice'),
      pages: 3,
      page: 2,
    },
  ];
  const recent = [
    {
      ...base,
      id: demoId('scan-recent-done'),
      name: 'invoice.pdf',
      stage: 'done' as const,
      receivedAt: isoAt(now - 12 * 60 * 60_000),
      updatedAt: isoAt(now - 5 * 60_000),
      doneAt: isoAt(now - 5 * 60_000),
      noteId: demoId('note-scanned-invoice'),
      resourceId: demoId('res-scanned-invoice'),
    },
    {
      ...base,
      id: demoId('scan-recent-ocr-error'),
      name: 'blurred-receipt.pdf',
      stage: 'done' as const,
      receivedAt: isoAt(now - 8 * 60 * 60_000),
      updatedAt: isoAt(now - 35 * 60_000),
      doneAt: isoAt(now - 35 * 60_000),
      error: 'OCR failed after the final page',
    },
    {
      ...base,
      id: demoId('scan-recent-skipped'),
      name: 'holiday-photo.txt',
      stage: 'skipped' as const,
      receivedAt: isoAt(now - 20 * 60 * 60_000),
      updatedAt: isoAt(now - 50 * 60_000),
      doneAt: isoAt(now - 50 * 60_000),
      error: 'Not a document',
    },
  ];
  return { enabled: true, available: true, active: jobs.length, cycle, jobs, recent };
}

/** Reads and normalizes the host scan pipeline status for the signed-in user. */
export class ScanStatusService {
  private readonly deps: ScanStatusDeps;
  private cached?: { expiresAt: number; value: ScanStatusResponse };
  private pending?: Promise<ScanStatusResponse>;

  constructor(deps: ScanStatusDeps = {}) {
    this.deps = deps;
  }

  private resolvedConfig() {
    return {
      url: this.deps.ocrServiceUrl !== undefined ? this.deps.ocrServiceUrl : config.ocrServiceUrl,
      secret: this.deps.ocrServiceSecret !== undefined ? this.deps.ocrServiceSecret : config.ocrServiceSecret,
      emails: this.deps.scanStatusEmails ?? config.scanStatusEmails,
      fake: this.deps.scanStatusFake ?? config.scanStatusFake,
    };
  }

  public isEnabledFor(email: string | undefined): boolean {
    const cfg = this.resolvedConfig();
    return cfg.fake || (Boolean(cfg.url) && Boolean(email) && cfg.emails.includes(email!.trim().toLowerCase()));
  }

  public async getStatus(email: string | undefined): Promise<ScanStatusResponse> {
    const cfg = this.resolvedConfig();
    if (!this.isEnabledFor(email)) return { enabled: false };
    const now = this.deps.now?.() ?? Date.now();
    if (cfg.fake) return fakeStatus(now);
    const current = Date.now();
    if (this.cached && this.cached.expiresAt > current) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.fetchAndNormalize(cfg.url!, cfg.secret, now)
      .catch((error: unknown) => ({
        enabled: true,
        available: false,
        error: error instanceof Error ? error.message : 'OCR bridge unavailable',
        active: 0,
        cycle: normalizeCycle(null),
        jobs: [],
        recent: [],
      }))
      .then((value) => {
        this.cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async fetchAndNormalize(url: string, secret: string | null, now: number): Promise<ScanStatusResponse> {
    if (this.deps.source) return normalizeBridgeAnswer(await this.deps.source(), now);
    const headers: Record<string, string> = {};
    if (secret) headers['X-Ocr-Secret'] = secret;
    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn(`${url.replace(/\/$/, '')}/scans`, {
      headers,
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OCR bridge returned HTTP ${response.status}`);
    return normalizeBridgeAnswer(await response.json(), now);
  }
}

export const scanStatusService = new ScanStatusService();
