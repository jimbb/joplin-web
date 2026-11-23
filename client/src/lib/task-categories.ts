import type { Notebook, TaskCategory, TaskCategoryColor, TaskCategoryRules } from "./types";

export const CUSTOM_CATEGORY_PREFIX = "custom:";

export interface TaskCategoryColorStyle {
  id: TaskCategoryColor;
  label: string;
  dotClass: string;
  badgeClass: string;
  activeChipClass: string;
}

export const TASK_CATEGORY_COLORS: readonly TaskCategoryColorStyle[] = [
  {
    id: "terracotta",
    label: "Terracotta",
    dotClass: "bg-[#c86442] dark:bg-[#df8364]",
    badgeClass:
      "border-[#c86442]/30 bg-[#c86442]/10 text-[#9c4527] dark:border-[#df8364]/35 dark:bg-[#df8364]/15 dark:text-[#f0a58b]",
    activeChipClass:
      "border-[#c86442]/50 bg-[#c86442]/15 text-foreground dark:border-[#df8364]/50 dark:bg-[#df8364]/20",
  },
  {
    id: "sky",
    label: "Blue",
    dotClass: "bg-sky-600 dark:bg-sky-400",
    badgeClass:
      "border-sky-600/30 bg-sky-500/10 text-sky-800 dark:border-sky-400/35 dark:bg-sky-400/15 dark:text-sky-300",
    activeChipClass:
      "border-sky-600/50 bg-sky-500/15 text-foreground dark:border-sky-400/50 dark:bg-sky-400/20",
  },
  {
    id: "emerald",
    label: "Green",
    dotClass: "bg-emerald-600 dark:bg-emerald-400",
    badgeClass:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-400/15 dark:text-emerald-300",
    activeChipClass:
      "border-emerald-600/50 bg-emerald-500/15 text-foreground dark:border-emerald-400/50 dark:bg-emerald-400/20",
  },
  {
    id: "amber",
    label: "Amber",
    dotClass: "bg-amber-600 dark:bg-amber-400",
    badgeClass:
      "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-amber-400/35 dark:bg-amber-400/15 dark:text-amber-300",
    activeChipClass:
      "border-amber-600/50 bg-amber-500/15 text-foreground dark:border-amber-400/50 dark:bg-amber-400/20",
  },
  {
    id: "violet",
    label: "Violet",
    dotClass: "bg-violet-600 dark:bg-violet-400",
    badgeClass:
      "border-violet-600/30 bg-violet-500/10 text-violet-800 dark:border-violet-400/35 dark:bg-violet-400/15 dark:text-violet-300",
    activeChipClass:
      "border-violet-600/50 bg-violet-500/15 text-foreground dark:border-violet-400/50 dark:bg-violet-400/20",
  },
  {
    id: "rose",
    label: "Rose",
    dotClass: "bg-rose-600 dark:bg-rose-400",
    badgeClass:
      "border-rose-600/30 bg-rose-500/10 text-rose-800 dark:border-rose-400/35 dark:bg-rose-400/15 dark:text-rose-300",
    activeChipClass:
      "border-rose-600/50 bg-rose-500/15 text-foreground dark:border-rose-400/50 dark:bg-rose-400/20",
  },
  {
    id: "slate",
    label: "Neutral",
    dotClass: "bg-stone-500 dark:bg-stone-400",
    badgeClass:
      "border-border bg-muted/70 text-foreground/80 dark:border-border dark:bg-muted/80 dark:text-foreground/85",
    activeChipClass: "border-primary/40 bg-primary/10 text-foreground",
  },
] as const;

const COLOR_STYLE_MAP = new Map<TaskCategoryColor, TaskCategoryColorStyle>(
  TASK_CATEGORY_COLORS.map((c) => [c.id, c])
);

export function getTaskCategoryColorStyle(color: TaskCategoryColor | undefined): TaskCategoryColorStyle {
  return (color ? COLOR_STYLE_MAP.get(color) : undefined) ?? TASK_CATEGORY_COLORS[0];
}

export function customCategoryKey(id: string): string {
  return `${CUSTOM_CATEGORY_PREFIX}${id}`;
}

export function isCustomCategoryKey(key: string): boolean {
  return key.startsWith(CUSTOM_CATEGORY_PREFIX);
}

export function customCategoryIdFromKey(key: string): string {
  return key.slice(CUSTOM_CATEGORY_PREFIX.length);
}

export interface MatchableTask {
  key: string;
  kind: "todo" | "inline";
  title: string;
  noteTitle: string;
  notebookId: string;
  notebookCategoryLabel: string;
  sourceUrl: string;
  tagIds: string[];
}

/**
 * Builds a map from each notebook ID to its full chain of notebook IDs (self + ancestors),
 * so matching a parent notebook ID in a category rule also matches all nested sub-notebooks.
 */
export function buildNotebookLineageMap(notebooks: Notebook[] | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const walk = (nodes: Notebook[] | undefined, ancestors: string[]) => {
    if (!nodes) return;
    for (const nb of nodes) {
      const lineage = [...ancestors, nb.id];
      map.set(nb.id, new Set(lineage));
      walk(nb.children, lineage);
    }
  };
  walk(notebooks, []);
  return map;
}

/** Returns true when at least one auto-categorization rule is configured on a category. */
export function hasCategoryRules(rules: TaskCategoryRules | undefined): boolean {
  if (!rules) return false;
  return Boolean(
    rules.taskKind ||
      (rules.notebookIds && rules.notebookIds.length > 0) ||
      (rules.notebookPathPrefixes && rules.notebookPathPrefixes.length > 0) ||
      (rules.sourceUrlPatterns && rules.sourceUrlPatterns.length > 0) ||
      (rules.tagIds && rules.tagIds.length > 0) ||
      (rules.keywords && rules.keywords.length > 0)
  );
}

/**
 * Splits comma- or newline-separated user rule entries into trimmed, case-insensitively deduplicated tokens.
 */
export function parseRuleTokens(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out;
}

/** Extracts a readable hostname from a URL (for pre-filling source URL rules). */
export function extractSourceHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/**
 * Evaluates whether a task matches a custom category's auto-categorization rules.
 * - If `taskKind` is set, the task must match that kind.
 * - If any matcher arrays (`notebookIds`, `notebookPathPrefixes`, `sourceUrlPatterns`, `tagIds`,
 *   `keywords`) are non-empty, matching ANY of them qualifies the task.
 * - If no rules are set at all, returns false (manual-assignment-only category).
 */
export function taskMatchesRules(
  task: MatchableTask,
  rules: TaskCategoryRules | undefined,
  notebookLineageById?: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (!rules || !hasCategoryRules(rules)) return false;
  if (rules.taskKind && task.kind !== rules.taskKind) return false;

  const hasContentMatchers = Boolean(
    (rules.notebookIds && rules.notebookIds.length > 0) ||
      (rules.notebookPathPrefixes && rules.notebookPathPrefixes.length > 0) ||
      (rules.sourceUrlPatterns && rules.sourceUrlPatterns.length > 0) ||
      (rules.tagIds && rules.tagIds.length > 0) ||
      (rules.keywords && rules.keywords.length > 0)
  );

  // Kind-only rule (e.g. "All to-dos") matches every task of that kind
  if (!hasContentMatchers) return true;

  if (rules.notebookIds && rules.notebookIds.length > 0 && task.notebookId) {
    const lineage = notebookLineageById?.get(task.notebookId);
    for (const id of rules.notebookIds) {
      if (id === task.notebookId || lineage?.has(id)) return true;
    }
  }

  if (rules.notebookPathPrefixes && rules.notebookPathPrefixes.length > 0 && task.notebookCategoryLabel) {
    const pathLower = task.notebookCategoryLabel.toLowerCase();
    for (const rawPrefix of rules.notebookPathPrefixes) {
      const prefix = rawPrefix.trim().toLowerCase().replace(/\/+$/, "").trim();
      if (!prefix) continue;
      if (pathLower === prefix || pathLower.startsWith(`${prefix} / `)) return true;
    }
  }

  if (rules.sourceUrlPatterns && rules.sourceUrlPatterns.length > 0 && task.sourceUrl) {
    const urlLower = task.sourceUrl.toLowerCase();
    for (const pattern of rules.sourceUrlPatterns) {
      const needle = pattern.trim().toLowerCase();
      if (needle && urlLower.includes(needle)) return true;
    }
  }

  if (rules.tagIds && rules.tagIds.length > 0 && task.tagIds.length > 0) {
    for (const tid of rules.tagIds) {
      if (task.tagIds.includes(tid)) return true;
    }
  }

  if (rules.keywords && rules.keywords.length > 0) {
    const titleLower = task.title.toLowerCase();
    const noteTitleLower = task.noteTitle.toLowerCase();
    for (const kw of rules.keywords) {
      const needle = kw.trim().toLowerCase();
      if (needle && (titleLower.includes(needle) || noteTitleLower.includes(needle))) return true;
    }
  }

  return false;
}

export interface ResolvedTaskCategories {
  /** Manually assigned custom category ID (null if automatic) */
  manualCategoryId: string | null;
  /** Custom category IDs that matched automatically via rules */
  autoMatchedCategoryIds: string[];
  /** Effective custom category IDs this task belongs to (manual override, or all auto-matches) */
  effectiveCategoryIds: string[];
  /** Primary custom category (manual override wins, otherwise first auto-match, else null) */
  primaryCustomCategory: TaskCategory | null;
}

/**
 * Resolves custom category membership for a single task.
 * A manual assignment overrides automatic rule matching for primary/effective membership.
 */
export function resolveTaskCustomCategories(
  task: MatchableTask,
  customCategories: readonly TaskCategory[],
  assignments: Readonly<Record<string, string>>,
  notebookLineageById?: ReadonlyMap<string, ReadonlySet<string>>
): ResolvedTaskCategories {
  if (customCategories.length === 0) {
    return {
      manualCategoryId: null,
      autoMatchedCategoryIds: [],
      effectiveCategoryIds: [],
      primaryCustomCategory: null,
    };
  }

  const byId = new Map(customCategories.map((c) => [c.id, c]));
  const rawManual = assignments[task.key];
  const manualCategory = rawManual ? byId.get(rawManual) ?? null : null;

  const autoMatchedCategoryIds: string[] = [];
  for (const cat of customCategories) {
    if (taskMatchesRules(task, cat.rules, notebookLineageById)) {
      autoMatchedCategoryIds.push(cat.id);
    }
  }

  if (manualCategory) {
    return {
      manualCategoryId: manualCategory.id,
      autoMatchedCategoryIds,
      effectiveCategoryIds: [manualCategory.id],
      primaryCustomCategory: manualCategory,
    };
  }

  const firstAuto = autoMatchedCategoryIds.length > 0 ? byId.get(autoMatchedCategoryIds[0]) ?? null : null;
  return {
    manualCategoryId: null,
    autoMatchedCategoryIds,
    effectiveCategoryIds: autoMatchedCategoryIds,
    primaryCustomCategory: firstAuto,
  };
}
