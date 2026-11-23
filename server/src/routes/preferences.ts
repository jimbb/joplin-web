import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import type { PreferencesStore } from '../services/preferences-store.js';
import type { HydratedPreferences } from '../types/index.js';

export function createPreferencesRouter(defaultStore?: PreferencesStore): Router {
  const router = Router();
  router.use(requireAuth);

  const getStore = (req: Parameters<Parameters<typeof router.get>[1]>[0]): PreferencesStore => {
    const store = req.preferencesStore ?? defaultStore;
    if (!store) throw new Error('PreferencesStore not configured');
    return store;
  };

  async function buildHydratedPreferences(sessionId: string, store: PreferencesStore): Promise<HydratedPreferences> {
    const ownerKey = noteCache.getOwnerKey(sessionId);
    const prefs = store.get(ownerKey);
    return noteCache.hydratePreferences(sessionId, prefs);
  }

  /** GET /api/preferences */
  router.get('/', async (req, res) => {
    const hydrated = await buildHydratedPreferences(req.sessionId!, getStore(req));
    res.status(200).json(hydrated);
  });

  /** POST /api/preferences/favorites/notes/:id */
  router.post('/favorites/notes/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    await store.addFavoriteNote(ownerKey, req.params.id);
    const hydrated = await buildHydratedPreferences(req.sessionId!, store);
    res.status(200).json(hydrated);
  });

  /** DELETE /api/preferences/favorites/notes/:id */
  router.delete('/favorites/notes/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    await store.removeFavoriteNote(ownerKey, req.params.id);
    const hydrated = await buildHydratedPreferences(req.sessionId!, store);
    res.status(200).json(hydrated);
  });

  /** POST /api/preferences/favorites/notebooks/:id */
  router.post('/favorites/notebooks/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    await store.addFavoriteNotebook(ownerKey, req.params.id);
    const hydrated = await buildHydratedPreferences(req.sessionId!, store);
    res.status(200).json(hydrated);
  });

  /** DELETE /api/preferences/favorites/notebooks/:id */
  router.delete('/favorites/notebooks/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    await store.removeFavoriteNotebook(ownerKey, req.params.id);
    const hydrated = await buildHydratedPreferences(req.sessionId!, store);
    res.status(200).json(hydrated);
  });

  /** POST /api/preferences/saved-searches */
  router.post('/saved-searches', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const { name, query } = (req.body ?? {}) as { name?: string; query?: string };
    const created = await store.addSavedSearch(ownerKey, name ?? '', query ?? '');
    res.status(201).json(created);
  });

  /** DELETE /api/preferences/saved-searches/:id */
  router.delete('/saved-searches/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const removed = await store.removeSavedSearch(ownerKey, req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Saved search not found' });
      return;
    }
    res.status(204).end();
  });

  /** POST /api/preferences/recent-reads/:id */
  router.post('/recent-reads/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    await store.recordRecentRead(ownerKey, req.params.id);
    res.status(204).end();
  });

  /** PUT /api/preferences/scratchpad */
  router.put('/scratchpad', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const { scratchpad } = (req.body ?? {}) as { scratchpad?: unknown };
    if (typeof scratchpad !== 'string') {
      res.status(400).json({ error: 'scratchpad must be a string' });
      return;
    }
    const updated = await store.setScratchpad(ownerKey, scratchpad);
    res.status(200).json({ scratchpad: updated.scratchpad });
  });

  /** POST /api/preferences/task-categories */
  router.post('/task-categories', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const { name, color, rules } = (req.body ?? {}) as {
      name?: string;
      color?: unknown;
      rules?: unknown;
    };
    const created = await store.addTaskCategory(ownerKey, {
      name: name ?? '',
      color: color as never,
      rules: rules as never,
    });
    res.status(201).json(created);
  });

  /** PUT /api/preferences/task-categories/assignments */
  router.put('/task-categories/assignments', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const { taskKey, categoryId } = (req.body ?? {}) as {
      taskKey?: unknown;
      categoryId?: unknown;
    };
    if (typeof taskKey !== 'string') {
      res.status(400).json({ error: 'taskKey is required' });
      return;
    }
    if (categoryId !== null && categoryId !== undefined && typeof categoryId !== 'string') {
      res.status(400).json({ error: 'categoryId must be a string or null' });
      return;
    }
    const taskCategoryAssignments = await store.setTaskCategoryAssignment(
      ownerKey,
      taskKey,
      categoryId === undefined ? null : categoryId
    );
    res.status(200).json({ taskCategoryAssignments });
  });

  /** PUT /api/preferences/task-categories/:id */
  router.put('/task-categories/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const { name, color, rules } = (req.body ?? {}) as {
      name?: string;
      color?: unknown;
      rules?: unknown;
    };
    const updated = await store.updateTaskCategory(ownerKey, req.params.id, {
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color: color as never } : {}),
      ...(rules !== undefined ? { rules: rules as never } : {}),
    });
    if (!updated) {
      res.status(404).json({ error: 'Task category not found' });
      return;
    }
    res.status(200).json(updated);
  });

  /** DELETE /api/preferences/task-categories/:id */
  router.delete('/task-categories/:id', async (req, res) => {
    const store = getStore(req);
    const ownerKey = noteCache.getOwnerKey(req.sessionId!);
    const removed = await store.removeTaskCategory(ownerKey, req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Task category not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
