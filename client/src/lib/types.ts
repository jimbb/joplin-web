/**
 * Notebook entity representing Joplin folders in a tree hierarchy.
 */
export interface Notebook {
  id: string;
  title: string;
  parentId: string;
  children: Notebook[];
  noteCount: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
}

/**
 * A trashed notebook as listed in the trash (only the top of a trashed subtree).
 */
export interface TrashedNotebook {
  id: string;
  title: string;
  parentId: string;
  deletedTime: number;
  /** Notes trashed together with the notebook (restored with it), at any depth */
  noteCount: number;
  /** Sub-notebooks trashed together with the notebook, at any depth */
  notebookCount: number;
  /** Notes inside that were trashed on their own earlier: not restored, but deleted with it */
  earlierNoteCount: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
}

/**
 * Note summary for lists and search results.
 */
export interface NoteListItem {
  id: string;
  title: string;
  updatedTime: number;
  createdTime: number;
  deletedTime?: number;
  preview: string;
  notebookId?: string;
  parentId?: string;
  isTodo?: boolean;
  todoCompleted?: boolean;
  /** A conflict copy Joplin kept after a sync conflict (listed only under Conflicts) */
  isConflict?: boolean;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
  /** To-do due date in Unix ms; 0 or missing when none is set */
  todoDue?: number;
  /** First image or PDF attachment the body links to, shown as the card's thumbnail */
  thumbnail?: { resourceId: string; kind: "image" | "pdf" };
  /** Linked tag ids (omitted when the note has no tags) */
  tagIds?: string[];
}

export interface NotebookBreadcrumb {
  id: string;
  title: string;
}

export interface NoteBacklink {
  id: string;
  title: string;
  parentId: string;
  updatedTime: number;
  snippet: string;
}

/**
 * Full Joplin note model including Markdown body and metadata.
 */
export interface Note {
  id: string;
  title: string;
  body: string;
  /** Plain-text preview of the body, as in note lists (built by the server) */
  preview?: string;
  updatedTime: number;
  createdTime: number;
  deletedTime?: number;
  parentId: string;
  notebookId: string;
  notebookTitle: string;
  notebookPath?: NotebookBreadcrumb[];
  backlinks?: NoteBacklink[];
  tags: Tag[];
  isTodo: boolean;
  todoCompleted: boolean;
  /** A conflict copy Joplin kept after a sync conflict (`is_conflict: 1`) */
  isConflict?: boolean;
  /** Id of the note the conflict copy was made from, empty when unknown */
  conflictOriginalId?: string;
  /** Joplin's `markup_language`: 1 = Markdown, 2 = HTML (see `MARKUP_HTML`) */
  markupLanguage?: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
  /** To-do due date in Unix ms; 0 or missing when none is set */
  todoDue?: number;
  /** Raw Joplin note properties (source_url, author, location, etc.) */
  properties?: Record<string, string>;
}

/** `markupLanguage` of HTML notes, e.g. pages saved with the Joplin Web Clipper */
export const MARKUP_HTML = 2;

/**
 * Tag model associated with notes.
 */
export interface Tag {
  id: string;
  title: string;
  noteCount: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
}

/**
 * Whether Joplin Web may write to the account. Accounts with end-to-end encryption are read-only:
 * Joplin Web can't encrypt, so the server refuses every write to them.
 */
export interface WriteState {
  writable: boolean;
  /** The server's explanation when not writable */
  reason: string | null;
}

/**
 * Search result with matched highlighted snippet fields.
 */
export interface SearchResult extends NoteListItem {
  matches?: {
    inTitle: boolean;
    inBody: boolean;
    /** Set to "attachment" when the terms matched only in linked attachments' OCR text */
    matchedIn?: "attachment";
    snippet?: string;
    /** Lower-cased words and phrases the note matched (empty for filter-only queries) */
    terms?: string[];
  };
}

/**
 * Item payload inside POST /api/notes/batch.
 */
export interface BatchNoteItem {
  id: string;
  baseUpdatedTime?: number;
  parentId?: string;
  title?: string;
  addTags?: string[];
  removeTags?: string[];
}

/**
 * Request body for POST /api/notes/batch.
 */
export interface BatchNoteRequest {
  items: BatchNoteItem[];
  parentId?: string;
  addTags?: string[];
  removeTags?: string[];
  trash?: boolean;
  restore?: boolean;
}

/**
 * Per-note result returned by POST /api/notes/batch.
 */
export interface BatchNoteResult {
  id: string;
  status: "ok" | "conflict" | "error";
  updatedTime?: number;
  error?: string;
  addedTags?: string[];
}

/**
 * Available two-factor authentication methods.
 */
export type TwoFactorMethod = "passkey" | "totp" | "recovery";

export interface TwoFactorChallenge {
  required: true;
  methods: TwoFactorMethod[];
  mustEnroll: boolean;
  passkeysAvailable?: boolean;
}

/**
 * Login response payload from API. The session itself is set as an httpOnly cookie when complete,
 * or enters a server-side pending state when two-factor verification or enrollment is needed.
 */
export type LoginResponse =
  | {
      userId: string;
      twoFactor?: undefined;
    }
  | {
      twoFactor: TwoFactorChallenge;
    };

export interface TwoFactorStatus {
  persistenceEnabled: boolean;
  require2fa: boolean;
  passkeysAvailable: boolean;
  enrolled: {
    totp: boolean;
    passkeysCount: number;
    recoveryCodesRemaining: number;
  };
  methods: TwoFactorMethod[];
  stepUpValid: boolean;
  stepUpExpiresAt: number | null;
}

export interface PasskeyItem {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface TrustedDeviceItem {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
}

export interface TotpSetupResponse {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export interface TwoFactorCompleteResponse {
  verified?: boolean;
  enrolled?: boolean;
  userId?: string;
  stepUpExpiresAt?: number;
  recoveryCodes?: string[];
  recoveryCodesRemaining?: number;
  passkey?: PasskeyItem;
}

export interface OrganizeStatus {
  enabled: boolean;
  model?: string;
}

export type OrganizeJobStatus = "running" | "done" | "cancelled" | "failed";
export type OrganizeItemStatus = "pending" | "running" | "done" | "failed";
export type OrganizeJobMode = "organize" | "retitle";
export type TitleDetail = "short" | "standard" | "detailed";

export interface OrganizeSuggestion {
  title: string;
  notebookId: string;
  tags: string[];
  confidence: number;
  documentDate: string | null;
  reason: string;
}

export interface OrganizeJobItem {
  noteId: string;
  currentTitle: string;
  currentNotebookId: string;
  currentNotebookPath: string;
  updatedTime: number;
  status: OrganizeItemStatus;
  error?: string;
  skipped?: boolean;
  suggestion?: OrganizeSuggestion;
  unchanged?: boolean;
  /** True when the uniqueness pass changed this item's title to avoid a collision. */
  titleMadeUnique?: boolean;
  /** Number of other notes sharing this suggested title when a collision could not be resolved. */
  titleCollision?: number;
  applied?: boolean;
  applyStatus?: "ok" | "conflict" | "error";
  applyError?: string;
  /** Set in job responses when the note was deleted or trashed after analysis (can't be applied). */
  gone?: boolean;
}

export interface OrganizeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OrganizeJobProgress {
  total: number;
  done: number;
  failed: number;
}

export interface OrganizeJobSummary {
  id: string;
  mode?: OrganizeJobMode;
  titleDetail?: TitleDetail;
  status: OrganizeJobStatus;
  error?: string;
  progress: OrganizeJobProgress;
  appliedCount: number;
  usage: OrganizeUsage;
  canUndo: boolean;
  createdAt: number;
  updatedAt: number;
}

export type OrganizeFilter = "all" | "very-high" | "high" | "moves";

export type OrganizeSelectionMode = "very-high" | "high";

export interface OrganizeFilterCounts {
  all: number;
  veryHigh: number;
  veryHighUnapplied: number;
  high: number;
  highUnapplied: number;
  moves: number;
  movesUnapplied: number;
}

export interface OrganizeTargetsResponse {
  noteIds: string[];
}

export interface OrganizeJobResponse {
  id: string;
  mode?: OrganizeJobMode;
  titleDetail?: TitleDetail;
  status: OrganizeJobStatus;
  error?: string;
  excludeNotebookIds: string[];
  progress: OrganizeJobProgress;
  appliedCount?: number;
  /** Unapplied suggestions whose note was deleted or trashed after analysis. */
  goneCount?: number;
  retryableFailedCount?: number;
  /** Items never analysed (a cancelled job); retry resumes them. */
  pendingCount?: number;
  filter?: OrganizeFilter;
  filterCounts?: OrganizeFilterCounts;
  usage: OrganizeUsage;
  offset: number;
  limit: number;
  totalItems: number;
  canUndo: boolean;
  createdAt: number;
  updatedAt: number;
  items: OrganizeJobItem[];
}

export interface OrganizeRetryResponse {
  id: string;
  status: OrganizeJobStatus;
  requeuedCount: number;
}

export interface OrganizeDeleteResponse {
  id: string;
  deleted: boolean;
}

export interface OrganizeApplyItemInput {
  noteId: string;
  title?: string;
  notebookId?: string;
  addTags?: string[];
  baseUpdatedTime?: number;
  useSuggestion?: boolean;
}

export interface OrganizeApplyResponse {
  results: BatchNoteResult[];
  appliedCount: number;
  conflictCount: number;
  errorCount: number;
  canUndo: boolean;
}

export interface OrganizeUndoResponse {
  results: BatchNoteResult[];
  revertedCount: number;
  conflictCount: number;
  errorCount: number;
  canUndo: boolean;
  remainingCount?: number;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

export interface RecentReadEntry {
  noteId: string;
  readAt: number;
}

export interface FavoriteNotebookSummary {
  id: string;
  title: string;
  parentId: string;
  noteCount: number;
  encrypted: boolean;
}

export type TaskCategoryColor =
  | "slate"
  | "terracotta"
  | "amber"
  | "emerald"
  | "sky"
  | "violet"
  | "rose";

export interface TaskCategoryRules {
  notebookIds?: string[];
  notebookPathPrefixes?: string[];
  sourceUrlPatterns?: string[];
  tagIds?: string[];
  keywords?: string[];
  taskKind?: "todo" | "inline";
}

export interface TaskCategory {
  id: string;
  name: string;
  color: TaskCategoryColor;
  rules: TaskCategoryRules;
  createdAt: number;
  updatedAt: number;
}

export interface TaskCategoryInput {
  name: string;
  color?: TaskCategoryColor;
  rules?: TaskCategoryRules;
}

export interface UserPreferences {
  favoriteNoteIds: string[];
  favoriteNotebookIds: string[];
  savedSearches: SavedSearch[];
  recentReads: RecentReadEntry[];
  scratchpad: string;
  taskCategories: TaskCategory[];
  taskCategoryAssignments: Record<string, string>;
  favoriteNotes: NoteListItem[];
  favoriteNotebooks: FavoriteNotebookSummary[];
}

export interface RecentReadNote extends NoteListItem {
  readAt: number;
}

export interface RecentNotesResponse {
  recentRead: RecentReadNote[];
  recentCreated: NoteListItem[];
}

export type NoteAttachmentKind = "image" | "pdf" | "audio" | "video" | "file";
export type AttachmentOcrStatus = "pending" | "done" | "failed" | "skipped";

export interface NoteAttachment {
  id: string;
  title: string;
  mime: string;
  filename: string;
  fileExtension: string;
  size: number;
  updatedTime: number;
  ocrText: string;
  ocrStatus?: AttachmentOcrStatus;
  kind: NoteAttachmentKind;
}

export interface NoteRevisionMeta {
  id: string;
  itemId: string;
  titleUpdatedTime: number;
  updatedTime: number;
  createdTime: number;
}

export interface NoteRevisionDetail {
  id: string;
  itemId: string;
  title: string;
  body: string;
  updatedTime: number;
  createdTime: number;
}

export interface TodoTaskItem extends NoteListItem {
  notebookTitle: string;
  /** Full notebook hierarchy path (e.g. "Saved items / Facebook") */
  notebookPath?: string;
  /** Note source_url property, when present */
  sourceUrl?: string;
}

export interface InlineTaskItem {
  noteId: string;
  noteTitle: string;
  parentId: string;
  notebookTitle: string;
  /** Full notebook hierarchy path (e.g. "Saved items / Facebook") */
  notebookPath?: string;
  /** Note source_url property, when present */
  sourceUrl?: string;
  line: number;
  column: number;
  text: string;
  checked: boolean;
  updatedTime: number;
  /** Linked tag ids of the parent note (omitted when untagged) */
  tagIds?: string[];
}

export interface TasksResponse {
  todoNotes: TodoTaskItem[];
  inlineTasks: InlineTaskItem[];
}

export type DuplicateTier = "identical" | "near";

export interface HygieneNoteAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: NoteAttachmentKind;
  hasOcr: boolean;
}

export interface HygieneNoteItem extends NoteListItem {
  notebookTitle: string;
  notebookPath?: string;
  previewLength?: number;
  tagCount?: number;
  tags?: Array<{ id: string; title: string }>;
  attachments?: HygieneNoteAttachment[];
  ocrTextLength?: number;
}

export interface DuplicateCluster {
  id: string;
  tier: DuplicateTier;
  score: number;
  evidence: string;
  suggestedKeeperId: string;
  notes: HygieneNoteItem[];
}

export interface HygieneReport {
  duplicateClusters: DuplicateCluster[];
  totalDuplicateClusters: number;
  identicalClusterCount: number;
  nearClusterCount: number;
  emptyNotes: HygieneNoteItem[];
  untaggedNotes: HygieneNoteItem[];
}

export interface ResolveDuplicateResponse {
  keepNoteId: string;
  trashedNoteIds: string[];
  mergedTags: string[];
  results: BatchNoteResult[];
}

export interface AiFeatureStatus {
  enabled: boolean;
  model?: string;
  transcribeEnabled?: boolean;
  transcribeModel?: string;
}

export type ScanStage = "received" | "importing" | "queued" | "ocr" | "syncing" | "done" | "skipped" | "failed";
export type ScanCyclePhase = "idle" | "sync" | "import" | "ocr" | "upload";

export interface ScanJob {
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

export interface ScanCycle {
  phase: ScanCyclePhase;
  running: boolean;
  startedAt: string | null;
  phaseAt: string | null;
  finishedAt: string | null;
  result: "ok" | "failed" | null;
  ocrTotal: number;
  ocrDone: number;
  nextRunAt: string | null;
}

export interface ScanStatus {
  enabled: boolean;
  available?: boolean;
  error?: string;
  active?: number;
  cycle?: ScanCycle;
  jobs?: ScanJob[];
  recent?: ScanJob[];
}

export interface AudioTranscribeResponse {
  text: string;
  model: string;
  usage?: OrganizeUsage;
}

export interface AskNotesCitation {
  id: string;
  title: string;
  notebookTitle: string;
  updatedTime: number;
  excerpt: string;
}

export interface AskNotesResponse {
  answer: string;
  citations: AskNotesCitation[];
  usage?: OrganizeUsage;
}

export type NoteAssistAction = "summarize" | "action-items" | "suggest-tags" | "cleanup";

export interface NoteAssistResponse {
  result: string;
  tags?: string[];
  usage?: OrganizeUsage;
}

export interface ClipResponse {
  note: Note;
  extractedTitle: string;
  siteName?: string;
}

export interface EmailIngestResponse {
  note: Note;
}
