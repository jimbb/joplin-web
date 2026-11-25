import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RecentReadEntry,
  SavedSearch,
  TaskCategory,
  TaskCategoryColor,
  TaskCategoryInput,
  TaskCategoryRules,
  UserPreferences,
} from '../types/index.js';
import { assertValidId, WriteValidationError } from './note-writer.js';

const OWNER_KEY_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[0-9a-f]{32}$/;
const PAIR_KEY_RE = /^([0-9a-f]{32}):([0-9a-f]{32})$/;
const TASK_KEY_RE = /^(?:todo-[0-9a-f]{32}|inline-[0-9a-f]{32}-[1-9]\d{0,6}-\d{1,7})$/;
const VALID_COLORS = new Set<TaskCategoryColor>([
  'slate',
  'terracotta',
  'amber',
  'emerald',
  'sky',
  'violet',
  'rose',
]);

export const MAX_FAVORITE_NOTES = 200;
export const MAX_FAVORITE_NOTEBOOKS = 100;
export const MAX_SAVED_SEARCHES = 100;
export const MAX_RECENT_READS = 100;
export const MAX_SCRATCHPAD_CHARS = 100_000;
export const MAX_TASK_CATEGORIES = 50;
export const MAX_TASK_CATEGORY_RULES = 30;
export const MAX_TASK_CATEGORY_ASSIGNMENTS = 2000;
export const MAX_DISMISSED_DUPLICATE_PAIRS = 5000;

function canonicalPair(idA: string, idB: string): string {
  const a = assertValidId(idA, 'note id');
  const b = assertValidId(idB, 'note id');
  if (a === b) {
    throw new WriteValidationError('Duplicate pair must contain two distinct note ids', 400);
  }
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function sanitizeColor(value: unknown): TaskCategoryColor {
  return typeof value === 'string' && VALID_COLORS.has(value as TaskCategoryColor)
    ? (value as TaskCategoryColor)
    : 'terracotta';
}

function sanitizeStringList(value: unknown, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, maxLen);
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
    if (out.length >= MAX_TASK_CATEGORY_RULES) break;
  }
  return out;
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !ID_RE.test(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_TASK_CATEGORY_RULES) break;
  }
  return out;
}

function sanitizeTaskCategoryRules(raw: unknown): TaskCategoryRules {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const rules: TaskCategoryRules = {};
  const notebookIds = sanitizeIdList(obj.notebookIds);
  if (notebookIds.length > 0) rules.notebookIds = notebookIds;
  const notebookPathPrefixes = sanitizeStringList(obj.notebookPathPrefixes, 160);
  if (notebookPathPrefixes.length > 0) rules.notebookPathPrefixes = notebookPathPrefixes;
  const sourceUrlPatterns = sanitizeStringList(obj.sourceUrlPatterns, 160);
  if (sourceUrlPatterns.length > 0) rules.sourceUrlPatterns = sourceUrlPatterns;
  const tagIds = sanitizeIdList(obj.tagIds);
  if (tagIds.length > 0) rules.tagIds = tagIds;
  const keywords = sanitizeStringList(obj.keywords, 80);
  if (keywords.length > 0) rules.keywords = keywords;
  if (obj.taskKind === 'todo' || obj.taskKind === 'inline') {
    rules.taskKind = obj.taskKind;
  }
  return rules;
}

function cloneTaskCategory(cat: TaskCategory): TaskCategory {
  const rules: TaskCategoryRules = {};
  if (cat.rules.notebookIds) rules.notebookIds = [...cat.rules.notebookIds];
  if (cat.rules.notebookPathPrefixes) rules.notebookPathPrefixes = [...cat.rules.notebookPathPrefixes];
  if (cat.rules.sourceUrlPatterns) rules.sourceUrlPatterns = [...cat.rules.sourceUrlPatterns];
  if (cat.rules.tagIds) rules.tagIds = [...cat.rules.tagIds];
  if (cat.rules.keywords) rules.keywords = [...cat.rules.keywords];
  if (cat.rules.taskKind) rules.taskKind = cat.rules.taskKind;
  return { ...cat, rules };
}

function emptyPreferences(): UserPreferences {
  return {
    version: 1,
    favoriteNoteIds: [],
    favoriteNotebookIds: [],
    savedSearches: [],
    recentReads: [],
    scratchpad: '',
    taskCategories: [],
    taskCategoryAssignments: {},
    dismissedDuplicatePairs: [],
  };
}

function sanitizePreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPreferences();
  const obj = raw as Record<string, unknown>;
  const favoriteNoteIds = Array.isArray(obj.favoriteNoteIds)
    ? Array.from(new Set(obj.favoriteNoteIds.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))).slice(
        0,
        MAX_FAVORITE_NOTES
      )
    : [];
  const favoriteNotebookIds = Array.isArray(obj.favoriteNotebookIds)
    ? Array.from(
        new Set(obj.favoriteNotebookIds.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))
      ).slice(0, MAX_FAVORITE_NOTEBOOKS)
    : [];
  const savedSearches: SavedSearch[] = [];
  if (Array.isArray(obj.savedSearches)) {
    const seenIds = new Set<string>();
    for (const item of obj.savedSearches) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.id === 'string' &&
        rec.id &&
        !seenIds.has(rec.id) &&
        typeof rec.name === 'string' &&
        rec.name.trim() &&
        typeof rec.query === 'string' &&
        rec.query.trim()
      ) {
        seenIds.add(rec.id);
        savedSearches.push({
          id: rec.id,
          name: rec.name.trim().slice(0, 80),
          query: rec.query.trim().slice(0, 500),
          createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
        });
        if (savedSearches.length >= MAX_SAVED_SEARCHES) break;
      }
    }
  }
  const recentReads: RecentReadEntry[] = [];
  if (Array.isArray(obj.recentReads)) {
    const seenNotes = new Set<string>();
    for (const entry of obj.recentReads) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (
        typeof rec.noteId === 'string' &&
        ID_RE.test(rec.noteId) &&
        !seenNotes.has(rec.noteId) &&
        typeof rec.readAt === 'number' &&
        Number.isFinite(rec.readAt)
      ) {
        seenNotes.add(rec.noteId);
        recentReads.push({ noteId: rec.noteId, readAt: rec.readAt });
        if (recentReads.length >= MAX_RECENT_READS) break;
      }
    }
  }
  const scratchpad =
    typeof obj.scratchpad === 'string' ? obj.scratchpad.slice(0, MAX_SCRATCHPAD_CHARS) : '';

  const taskCategories: TaskCategory[] = [];
  const validCategoryIds = new Set<string>();
  if (Array.isArray(obj.taskCategories)) {
    for (const item of obj.taskCategories) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.id === 'string' &&
        rec.id &&
        !validCategoryIds.has(rec.id) &&
        typeof rec.name === 'string' &&
        rec.name.trim()
      ) {
        const createdAt =
          typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now();
        const updatedAt =
          typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : createdAt;
        validCategoryIds.add(rec.id);
        taskCategories.push({
          id: rec.id,
          name: rec.name.trim().slice(0, 60),
          color: sanitizeColor(rec.color),
          rules: sanitizeTaskCategoryRules(rec.rules),
          createdAt,
          updatedAt,
        });
        if (taskCategories.length >= MAX_TASK_CATEGORIES) break;
      }
    }
  }

  const taskCategoryAssignments: Record<string, string> = {};
  if (obj.taskCategoryAssignments && typeof obj.taskCategoryAssignments === 'object' && !Array.isArray(obj.taskCategoryAssignments)) {
    let count = 0;
    for (const [taskKey, categoryId] of Object.entries(obj.taskCategoryAssignments as Record<string, unknown>)) {
      if (typeof categoryId === 'string' && TASK_KEY_RE.test(taskKey) && validCategoryIds.has(categoryId)) {
        taskCategoryAssignments[taskKey] = categoryId;
        count++;
        if (count >= MAX_TASK_CATEGORY_ASSIGNMENTS) break;
      }
    }
  }

  const dismissedDuplicatePairs: string[] = [];
  if (Array.isArray(obj.dismissedDuplicatePairs)) {
    const seenPairs = new Set<string>();
    for (const item of obj.dismissedDuplicatePairs) {
      if (typeof item !== 'string') continue;
      const m = PAIR_KEY_RE.exec(item);
      if (!m || m[1] === m[2]) continue;
      const key = m[1] < m[2] ? `${m[1]}:${m[2]}` : `${m[2]}:${m[1]}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      dismissedDuplicatePairs.push(key);
      if (dismissedDuplicatePairs.length >= MAX_DISMISSED_DUPLICATE_PAIRS) break;
    }
  }

  return {
    version: 1,
    favoriteNoteIds,
    favoriteNotebookIds,
    savedSearches,
    recentReads,
    scratchpad,
    taskCategories,
    taskCategoryAssignments,
    dismissedDuplicatePairs,
  };
}

/**
 * Per-owner workspace preferences stored in `<CACHE_DIR>/prefs/<ownerKey>.json` (or memory when
 * CACHE_DIR is null). Serializes mutations per owner with atomic temp-file writes.
 */
export class PreferencesStore {
  private readonly prefsDir: string | null;
  private readonly cache = new Map<string, UserPreferences>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(cacheDir: string | null = null) {
    this.prefsDir = cacheDir ? join(cacheDir, 'prefs') : null;
  }

  private assertOwnerKey(ownerKey: string): string {
    if (!OWNER_KEY_RE.test(ownerKey)) {
      throw new WriteValidationError('Invalid owner key', 400);
    }
    return ownerKey;
  }

  private filePath(ownerKey: string): string | null {
    return this.prefsDir ? join(this.prefsDir, `${this.assertOwnerKey(ownerKey)}.json`) : null;
  }

  private load(ownerKey: string): UserPreferences {
    this.assertOwnerKey(ownerKey);
    const cached = this.cache.get(ownerKey);
    if (cached) return cached;

    const file = this.filePath(ownerKey);
    let prefs = emptyPreferences();
    if (file) {
      try {
        prefs = sanitizePreferences(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        // Missing or unreadable file starts clean
      }
    }
    this.cache.set(ownerKey, prefs);
    return prefs;
  }

  private save(ownerKey: string, prefs: UserPreferences): void {
    this.cache.set(ownerKey, prefs);
    const file = this.filePath(ownerKey);
    if (!file || !this.prefsDir) return;
    mkdirSync(this.prefsDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(prefs), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private withOwnerLock<T>(ownerKey: string, fn: () => T | Promise<T>): Promise<T> {
    this.assertOwnerKey(ownerKey);
    const prev = this.locks.get(ownerKey) ?? Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn()
    );
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(ownerKey, tail);
    void tail.finally(() => {
      if (this.locks.get(ownerKey) === tail) this.locks.delete(ownerKey);
    });
    return run;
  }

  public get(ownerKey: string): UserPreferences {
    const prefs = this.load(ownerKey);
    return {
      version: 1,
      favoriteNoteIds: [...prefs.favoriteNoteIds],
      favoriteNotebookIds: [...prefs.favoriteNotebookIds],
      savedSearches: prefs.savedSearches.map((s) => ({ ...s })),
      recentReads: prefs.recentReads.map((r) => ({ ...r })),
      scratchpad: prefs.scratchpad,
      taskCategories: prefs.taskCategories.map(cloneTaskCategory),
      taskCategoryAssignments: { ...prefs.taskCategoryAssignments },
      dismissedDuplicatePairs: [...prefs.dismissedDuplicatePairs],
    };
  }

  public addFavoriteNote(ownerKey: string, noteId: string): Promise<UserPreferences> {
    const id = assertValidId(noteId, 'note id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (!prefs.favoriteNoteIds.includes(id)) {
        if (prefs.favoriteNoteIds.length >= MAX_FAVORITE_NOTES) {
          throw new WriteValidationError(`Maximum ${MAX_FAVORITE_NOTES} favorite notes allowed`, 400);
        }
        prefs.favoriteNoteIds = [...prefs.favoriteNoteIds, id];
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public removeFavoriteNote(ownerKey: string, noteId: string): Promise<UserPreferences> {
    const id = assertValidId(noteId, 'note id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.favoriteNoteIds.filter((x) => x !== id);
      if (next.length !== prefs.favoriteNoteIds.length) {
        prefs.favoriteNoteIds = next;
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public addFavoriteNotebook(ownerKey: string, notebookId: string): Promise<UserPreferences> {
    const id = assertValidId(notebookId, 'notebook id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (!prefs.favoriteNotebookIds.includes(id)) {
        if (prefs.favoriteNotebookIds.length >= MAX_FAVORITE_NOTEBOOKS) {
          throw new WriteValidationError(`Maximum ${MAX_FAVORITE_NOTEBOOKS} favorite notebooks allowed`, 400);
        }
        prefs.favoriteNotebookIds = [...prefs.favoriteNotebookIds, id];
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public removeFavoriteNotebook(ownerKey: string, notebookId: string): Promise<UserPreferences> {
    const id = assertValidId(notebookId, 'notebook id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.favoriteNotebookIds.filter((x) => x !== id);
      if (next.length !== prefs.favoriteNotebookIds.length) {
        prefs.favoriteNotebookIds = next;
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public addSavedSearch(ownerKey: string, name: string, query: string): Promise<SavedSearch> {
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    const cleanQuery = typeof query === 'string' ? query.trim().slice(0, 500) : '';
    if (!cleanName) throw new WriteValidationError('Saved search name is required', 400);
    if (!cleanQuery) throw new WriteValidationError('Saved search query is required', 400);

    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (prefs.savedSearches.length >= MAX_SAVED_SEARCHES) {
        throw new WriteValidationError(`Maximum ${MAX_SAVED_SEARCHES} saved searches allowed`, 400);
      }
      const saved: SavedSearch = {
        id: randomUUID().replace(/-/g, ''),
        name: cleanName,
        query: cleanQuery,
        createdAt: Date.now(),
      };
      prefs.savedSearches = [...prefs.savedSearches, saved];
      this.save(ownerKey, prefs);
      return { ...saved };
    });
  }

  public removeSavedSearch(ownerKey: string, id: string): Promise<boolean> {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!cleanId) throw new WriteValidationError('Saved search id is required', 400);
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.savedSearches.filter((s) => s.id !== cleanId);
      if (next.length === prefs.savedSearches.length) return false;
      prefs.savedSearches = next;
      this.save(ownerKey, prefs);
      return true;
    });
  }

  public recordRecentRead(ownerKey: string, noteId: string, readAt = Date.now()): Promise<UserPreferences> {
    const id = assertValidId(noteId, 'note id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = [{ noteId: id, readAt }, ...prefs.recentReads.filter((r) => r.noteId !== id)].slice(
        0,
        MAX_RECENT_READS
      );
      prefs.recentReads = next;
      this.save(ownerKey, prefs);
      return this.get(ownerKey);
    });
  }

  public setScratchpad(ownerKey: string, scratchpad: string): Promise<UserPreferences> {
    if (typeof scratchpad !== 'string') {
      throw new WriteValidationError('scratchpad must be a string', 400);
    }
    if (scratchpad.length > MAX_SCRATCHPAD_CHARS) {
      throw new WriteValidationError(`scratchpad exceeds ${MAX_SCRATCHPAD_CHARS} characters`, 400);
    }
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (prefs.scratchpad !== scratchpad) {
        prefs.scratchpad = scratchpad;
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public addTaskCategory(ownerKey: string, input: TaskCategoryInput): Promise<TaskCategory> {
    const cleanName = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    if (!cleanName) throw new WriteValidationError('Category name is required', 400);
    const color = sanitizeColor(input.color);
    const rules = sanitizeTaskCategoryRules(input.rules);

    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (prefs.taskCategories.length >= MAX_TASK_CATEGORIES) {
        throw new WriteValidationError(`Maximum ${MAX_TASK_CATEGORIES} task categories allowed`, 400);
      }
      if (prefs.taskCategories.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
        throw new WriteValidationError(`Category "${cleanName}" already exists`, 409);
      }
      const now = Date.now();
      const created: TaskCategory = {
        id: randomUUID().replace(/-/g, ''),
        name: cleanName,
        color,
        rules,
        createdAt: now,
        updatedAt: now,
      };
      prefs.taskCategories = [...prefs.taskCategories, created];
      this.save(ownerKey, prefs);
      return cloneTaskCategory(created);
    });
  }

  public updateTaskCategory(
    ownerKey: string,
    id: string,
    patch: Partial<TaskCategoryInput>
  ): Promise<TaskCategory | null> {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!cleanId) throw new WriteValidationError('Category id is required', 400);

    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const index = prefs.taskCategories.findIndex((c) => c.id === cleanId);
      if (index === -1) return null;
      const existing = prefs.taskCategories[index];

      let nextName = existing.name;
      if (patch.name !== undefined) {
        const trimmed = typeof patch.name === 'string' ? patch.name.trim().slice(0, 60) : '';
        if (!trimmed) throw new WriteValidationError('Category name is required', 400);
        if (
          prefs.taskCategories.some(
            (c) => c.id !== cleanId && c.name.toLowerCase() === trimmed.toLowerCase()
          )
        ) {
          throw new WriteValidationError(`Category "${trimmed}" already exists`, 409);
        }
        nextName = trimmed;
      }

      const nextColor = patch.color !== undefined ? sanitizeColor(patch.color) : existing.color;
      const nextRules = patch.rules !== undefined ? sanitizeTaskCategoryRules(patch.rules) : existing.rules;
      const updated: TaskCategory = {
        ...existing,
        name: nextName,
        color: nextColor,
        rules: nextRules,
        updatedAt: Date.now(),
      };
      prefs.taskCategories = prefs.taskCategories.map((c, i) => (i === index ? updated : c));
      this.save(ownerKey, prefs);
      return cloneTaskCategory(updated);
    });
  }

  public removeTaskCategory(ownerKey: string, id: string): Promise<boolean> {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!cleanId) throw new WriteValidationError('Category id is required', 400);

    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const nextCategories = prefs.taskCategories.filter((c) => c.id !== cleanId);
      if (nextCategories.length === prefs.taskCategories.length) return false;
      prefs.taskCategories = nextCategories;
      const nextAssignments: Record<string, string> = {};
      for (const [taskKey, catId] of Object.entries(prefs.taskCategoryAssignments)) {
        if (catId !== cleanId) nextAssignments[taskKey] = catId;
      }
      prefs.taskCategoryAssignments = nextAssignments;
      this.save(ownerKey, prefs);
      return true;
    });
  }

  public setTaskCategoryAssignment(
    ownerKey: string,
    taskKey: string,
    categoryId: string | null
  ): Promise<Record<string, string>> {
    const cleanKey = typeof taskKey === 'string' ? taskKey.trim() : '';
    if (!TASK_KEY_RE.test(cleanKey)) {
      throw new WriteValidationError('Invalid task key', 400);
    }

    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = { ...prefs.taskCategoryAssignments };
      if (categoryId === null || categoryId === '') {
        delete next[cleanKey];
      } else {
        if (!prefs.taskCategories.some((c) => c.id === categoryId)) {
          throw new WriteValidationError('Task category not found', 404);
        }
        if (!(cleanKey in next) && Object.keys(next).length >= MAX_TASK_CATEGORY_ASSIGNMENTS) {
          throw new WriteValidationError(
            `Maximum ${MAX_TASK_CATEGORY_ASSIGNMENTS} manual task category assignments allowed`,
            400
          );
        }
        next[cleanKey] = categoryId;
      }
      prefs.taskCategoryAssignments = next;
      this.save(ownerKey, prefs);
      return { ...next };
    });
  }

  /** Persists one or more note-id pairs as "Not duplicates" so they do not reappear in hygiene reports. */
  public dismissDuplicatePairs(
    ownerKey: string,
    pairs: Array<[string, string]>
  ): Promise<string[]> {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new WriteValidationError('At least one note pair is required', 400);
    }
    const normalized = Array.from(new Set(pairs.map(([a, b]) => canonicalPair(a, b))));
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const existing = new Set(prefs.dismissedDuplicatePairs);
      let changed = false;
      for (const key of normalized) {
        if (existing.has(key)) continue;
        if (existing.size >= MAX_DISMISSED_DUPLICATE_PAIRS) {
          throw new WriteValidationError(
            `Maximum ${MAX_DISMISSED_DUPLICATE_PAIRS} dismissed duplicate pairs allowed`,
            400
          );
        }
        existing.add(key);
        changed = true;
      }
      if (changed) {
        prefs.dismissedDuplicatePairs = Array.from(existing);
        this.save(ownerKey, prefs);
      }
      return [...prefs.dismissedDuplicatePairs];
    });
  }

  /** Removes previously dismissed duplicate note-id pairs (used by Undo). */
  public undismissDuplicatePairs(
    ownerKey: string,
    pairs: Array<[string, string]>
  ): Promise<string[]> {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new WriteValidationError('At least one note pair is required', 400);
    }
    const toRemove = new Set(pairs.map(([a, b]) => canonicalPair(a, b)));
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.dismissedDuplicatePairs.filter((k) => !toRemove.has(k));
      if (next.length !== prefs.dismissedDuplicatePairs.length) {
        prefs.dismissedDuplicatePairs = next;
        this.save(ownerKey, prefs);
      }
      return [...prefs.dismissedDuplicatePairs];
    });
  }
}
