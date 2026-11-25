import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import { assertValidId, noteWriter, WriteValidationError } from '../services/note-writer.js';
import { organizerService, OrganizerService } from '../services/organizer.js';
import type { DuplicateTier, OrganizeFilter } from '../types/index.js';
import { isTrueFlag } from './query.js';

const VALID_ORGANIZE_FILTERS = new Set<OrganizeFilter>(['all', 'very-high', 'high', 'moves']);
const VALID_DUPLICATE_TIERS = new Set<DuplicateTier>(['identical', 'near']);

function parseDismissPairs(body: unknown): Array<[string, string]> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WriteValidationError('Request body must be a JSON object', 400);
  }
  const { pairs, noteIds } = body as { pairs?: unknown; noteIds?: unknown };
  const result: Array<[string, string]> = [];

  if (Array.isArray(pairs)) {
    for (const entry of pairs) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
        throw new WriteValidationError('pairs must be an array of [noteIdA, noteIdB] tuples', 400);
      }
      const a = assertValidId(entry[0], 'note id');
      const b = assertValidId(entry[1], 'note id');
      if (a === b) throw new WriteValidationError('Duplicate pair must contain two distinct note ids', 400);
      result.push([a, b]);
    }
  } else if (Array.isArray(noteIds)) {
    const cleanIds = Array.from(
      new Set(
        noteIds.map((id) => {
          if (typeof id !== 'string') throw new WriteValidationError('noteIds must contain strings only', 400);
          return assertValidId(id, 'note id');
        })
      )
    );
    if (cleanIds.length < 2) {
      throw new WriteValidationError('noteIds must contain at least 2 distinct note ids', 400);
    }
    if (cleanIds.length > 50) {
      throw new WriteValidationError('Too many noteIds in a single dismiss request', 400);
    }
    for (let i = 0; i < cleanIds.length; i++) {
      for (let j = i + 1; j < cleanIds.length; j++) {
        result.push([cleanIds[i], cleanIds[j]]);
      }
    }
  } else {
    throw new WriteValidationError('Expected pairs or noteIds in request body', 400);
  }

  if (result.length === 0) {
    throw new WriteValidationError('At least one note pair is required', 400);
  }
  return result;
}

export function createOrganizeRouter(service: OrganizerService = organizerService): Router {
  const router = Router();

  // Every organize endpoint requires an authenticated session
  router.use(requireAuth);

  /**
   * GET /api/organize/status
   * Tells the client whether Auto-organize is configured and active (never exposes URLs or secrets).
   */
  router.get('/status', (req, res) => {
    res.status(200).json(service.getStatus(req.sessionId!));
  });

  /**
   * GET /api/organize/hygiene?tier=identical|near&offset=0&limit=50
   * Detects content-based duplicate clusters, empty notes, and untagged notes locally without calling the LLM.
   */
  router.get('/hygiene', async (req, res) => {
    const rawTier = req.query.tier;
    let tier: DuplicateTier | undefined;
    if (rawTier !== undefined && rawTier !== '') {
      if (typeof rawTier !== 'string' || !VALID_DUPLICATE_TIERS.has(rawTier as DuplicateTier)) {
        res.status(400).json({ error: 'tier must be identical or near' });
        return;
      }
      tier = rawTier as DuplicateTier;
    }

    const rawOffset = req.query.offset;
    const rawLimit = req.query.limit;
    let offset: number | undefined;
    let limit: number | undefined;
    if (rawOffset !== undefined && rawOffset !== '') {
      const parsed = Number(rawOffset);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res.status(400).json({ error: 'offset must be a non-negative integer' });
        return;
      }
      offset = Math.floor(parsed);
    }
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed) || parsed < 1) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      limit = Math.floor(parsed);
    }

    let dismissedPairs: Set<string> | undefined;
    if (req.preferencesStore) {
      const ownerKey = noteCache.getOwnerKey(req.sessionId!);
      const prefs = req.preferencesStore.get(ownerKey);
      if (prefs.dismissedDuplicatePairs.length > 0) {
        dismissedPairs = new Set(prefs.dismissedDuplicatePairs);
      }
    }

    const report = await noteCache.getHygieneReport(req.sessionId!, {
      dismissedPairs,
      tier,
      offset,
      limit,
    });
    res.status(200).json(report);
  });

  /** POST /api/organize/retitle { noteId } */
  router.post('/retitle', async (req, res) => {
    const noteId = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.noteId : undefined;
    const result = await service.suggestRetitle(req.sessionId!, noteId);
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/hygiene/dismiss
   * Body: { noteIds: [idA, idB, ...] } or { pairs: [[idA, idB], ...] }
   * Persists dismissed note pairs in the server preferences store so they never reappear as duplicates.
   */
  router.post('/hygiene/dismiss', async (req, res) => {
    if (!req.preferencesStore) {
      throw new Error('PreferencesStore not configured');
    }
    const pairs = parseDismissPairs(req.body);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const dismissedPairs = await req.preferencesStore.dismissDuplicatePairs(ownerKey, pairs);
    res.status(200).json({ dismissedCount: pairs.length, dismissedPairs });
  });

  /**
   * POST /api/organize/hygiene/undismiss
   * Body: { noteIds: [idA, idB, ...] } or { pairs: [[idA, idB], ...] }
   * Restores previously dismissed note pairs (used by Undo).
   */
  router.post('/hygiene/undismiss', async (req, res) => {
    if (!req.preferencesStore) {
      throw new Error('PreferencesStore not configured');
    }
    const pairs = parseDismissPairs(req.body);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const dismissedPairs = await req.preferencesStore.undismissDuplicatePairs(ownerKey, pairs);
    res.status(200).json({ restoredCount: pairs.length, dismissedPairs });
  });

  /**
   * POST /api/organize/hygiene/resolve
   * Body: { keepNoteId: string, trashNoteIds: string[], mergeTags?: boolean }
   * Optionally merges tags from trashed copies onto the keeper, then moves the copies to Trash via the existing batch write path.
   */
  router.post('/hygiene/resolve', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const { keepNoteId, trashNoteIds, mergeTags } = req.body as {
      keepNoteId?: unknown;
      trashNoteIds?: unknown;
      mergeTags?: unknown;
    };
    if (typeof keepNoteId !== 'string') {
      res.status(400).json({ error: 'keepNoteId is required' });
      return;
    }
    const validKeeperId = assertValidId(keepNoteId, 'keepNoteId');
    if (!Array.isArray(trashNoteIds) || trashNoteIds.length === 0) {
      res.status(400).json({ error: 'trashNoteIds must be a non-empty array' });
      return;
    }
    if (trashNoteIds.length > 500) {
      res.status(400).json({ error: 'trashNoteIds exceeds maximum of 500 notes' });
      return;
    }
    const uniqueTrashIds = Array.from(
      new Set(
        trashNoteIds.map((id) => {
          if (typeof id !== 'string') throw new WriteValidationError('trashNoteIds must contain strings only', 400);
          return assertValidId(id, 'trashNoteId');
        })
      )
    );
    if (uniqueTrashIds.includes(validKeeperId)) {
      res.status(400).json({ error: 'keepNoteId cannot also appear in trashNoteIds' });
      return;
    }
    if (mergeTags !== undefined && typeof mergeTags !== 'boolean') {
      res.status(400).json({ error: 'mergeTags must be a boolean' });
      return;
    }

    // Never trash the copies when the note to keep is gone or already in the trash (e.g. changed in another tab)
    const keeper = await noteCache.getNote(req.sessionId!, validKeeperId);
    if (!keeper || keeper.deletedTime > 0) {
      res.status(409).json({ error: 'The note to keep no longer exists or is in the trash; refresh and try again' });
      return;
    }

    const shouldMergeTags = mergeTags !== false;
    let mergedTags: string[] = [];

    if (shouldMergeTags) {
      const entry = await noteCache.getEntry(req.sessionId!);
      const trashSet = new Set(uniqueTrashIds);
      const keeperTagIds = new Set<string>();
      const sourceTagIds = new Set<string>();
      for (const link of entry.noteTags) {
        if (link.noteId === validKeeperId) keeperTagIds.add(link.tagId);
        else if (trashSet.has(link.noteId)) sourceTagIds.add(link.tagId);
      }
      const tagsToMerge: string[] = [];
      const seenLower = new Set<string>();
      for (const tagId of keeperTagIds) {
        const tag = entry.tags.get(tagId);
        if (tag && tag.properties.encryption_applied !== '1' && tag.title.trim()) {
          seenLower.add(tag.title.trim().toLowerCase());
        }
      }
      for (const tagId of sourceTagIds) {
        if (keeperTagIds.has(tagId)) continue;
        const tag = entry.tags.get(tagId);
        if (!tag || tag.deletedTime > 0 || tag.properties.encryption_applied === '1') continue;
        const cleanTitle = tag.title.trim();
        if (!cleanTitle) continue;
        const lower = cleanTitle.toLowerCase();
        if (seenLower.has(lower)) continue;
        seenLower.add(lower);
        tagsToMerge.push(cleanTitle);
      }

      if (tagsToMerge.length > 0) {
        const mergeResults = await noteWriter.batchUpdateNotes(req.sessionId!, {
          items: [{ id: validKeeperId, addTags: tagsToMerge }],
        });
        const keeperResult = mergeResults[0];
        if (!keeperResult || keeperResult.status !== 'ok') {
          res.status(keeperResult?.status === 'conflict' ? 409 : 422).json({
            error: keeperResult?.error || 'Could not merge tags onto kept note',
          });
          return;
        }
        mergedTags = keeperResult.addedTags ?? [];
      }
    }

    const results = await noteWriter.batchUpdateNotes(req.sessionId!, {
      items: uniqueTrashIds.map((id) => ({ id })),
      trash: true,
    });
    const trashedNoteIds = results.filter((r) => r.status === 'ok').map((r) => r.id);

    res.status(200).json({
      keepNoteId: validKeeperId,
      trashedNoteIds,
      mergedTags,
      results,
    });
  });

  /**
   * GET /api/organize/jobs
   * Lists persisted and active Auto-organize jobs for the current user, newest first.
   */
  router.get('/jobs', (req, res) => {
    res.status(200).json(service.listJobs(req.sessionId!));
  });

  /**
   * POST /api/organize/jobs
   * Body: { noteIds: string[], excludeNotebookIds?: string[] }
   * Starts a background organize job and returns { jobId }.
   */
  router.post('/jobs', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const { noteIds, sourceNotebookIds, includeSubNotebooks, excludeNotebookIds, mode, dryRun } = req.body as {
      noteIds?: unknown;
      sourceNotebookIds?: unknown;
      includeSubNotebooks?: unknown;
      excludeNotebookIds?: unknown;
      mode?: unknown;
      dryRun?: unknown;
    };
    const input = { noteIds, sourceNotebookIds, includeSubNotebooks, excludeNotebookIds, mode };
    if (dryRun === true) {
      res.status(200).json(await service.countJob(req.sessionId!, input));
      return;
    }
    const result = await service.startJob(req.sessionId!, input);
    res.status(201).json(result);
  });

  /**
   * GET /api/organize/jobs/:id?offset=0&limit=100&filter=all
   * Returns job progress, filter counts, accumulated token usage, and paged suggestions with current metadata.
   */
  router.get('/jobs/:id', async (req, res) => {
    const rawOffset = req.query.offset;
    const rawLimit = req.query.limit;
    const rawFilter = req.query.filter;
    const offset = typeof rawOffset === 'string' && rawOffset.trim() !== '' ? Number(rawOffset) : 0;
    const limit = typeof rawLimit === 'string' && rawLimit.trim() !== '' ? Number(rawLimit) : 100;
    let filter: OrganizeFilter = 'all';
    if (rawFilter !== undefined) {
      if (typeof rawFilter !== 'string' || !VALID_ORGANIZE_FILTERS.has(rawFilter as OrganizeFilter)) {
        res.status(400).json({ error: 'filter must be one of all, very-high, high, moves' });
        return;
      }
      filter = rawFilter as OrganizeFilter;
    }
    if (!Number.isFinite(offset) || offset < 0) {
      res.status(400).json({ error: 'offset must be a non-negative integer' });
      return;
    }
    if (!Number.isFinite(limit) || limit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }
    const job = await service.getJob(req.sessionId!, req.params.id, { offset, limit, filter });
    res.status(200).json(job);
  });

  /**
   * GET /api/organize/jobs/:id/targets?mode=very-high
   * Returns all unapplied done noteIds matching the requested confidence threshold across the whole job.
   */
  router.get('/jobs/:id/targets', async (req, res) => {
    const mode = typeof req.query.mode === 'string' ? req.query.mode : '';
    if (mode !== 'very-high' && mode !== 'high') {
      res.status(400).json({ error: 'mode must be very-high or high' });
      return;
    }
    const result = await service.getApplyTargets(req.sessionId!, req.params.id, mode);
    res.status(200).json(result);
  });

  /**
   * DELETE /api/organize/jobs/:id
   * Cancels a running organize job, or deletes a finished job when `?remove=1` is passed.
   */
  router.delete('/jobs/:id', async (req, res) => {
    if (isTrueFlag(req.query.remove)) {
      const result = await service.deleteJob(req.sessionId!, req.params.id);
      res.status(200).json(result);
      return;
    }
    const result = await service.cancelJob(req.sessionId!, req.params.id);
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/retry
   * Re-queues retryable failed items (and resumes never-analysed ones of a cancelled job) using the
   * current notebook tree.
   */
  router.post('/jobs/:id/retry', async (req, res) => {
    const result = await service.retryJob(req.sessionId!, req.params.id);
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/apply
   * Body: { items: [{ noteId, title?, notebookId?, addTags?, baseUpdatedTime?, useSuggestion? }], undoMode? }
   * Applies approved suggestions via the batch writer and stores an undo record on the job.
   */
  router.post('/jobs/:id/apply', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const result = await service.applyJob(
      req.sessionId!,
      req.params.id,
      req.body as { items?: unknown; undoMode?: unknown }
    );
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/undo
   * Reverts the most recent apply action on this job (skipping notes changed since).
   * Optional body: { limit?: number } to revert in chunks.
   */
  router.post('/jobs/:id/undo', async (req, res) => {
    if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const result = await service.undoJob(
      req.sessionId!,
      req.params.id,
      req.body as { limit?: unknown } | undefined
    );
    res.status(200).json(result);
  });

  return router;
}

export const organizeRouter = createOrganizeRouter();
