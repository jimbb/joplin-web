import { useMemo, useState } from "react";
import { Check, Folder, Search, Sparkles, Tag as TagIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildNotebookPathMap, flattenNotebooks } from "@/lib/notebooks";
import {
  TASK_CATEGORY_COLORS,
  buildNotebookLineageMap,
  hasCategoryRules,
  parseRuleTokens,
  taskMatchesRules,
  type MatchableTask,
} from "@/lib/task-categories";
import type {
  Notebook,
  Tag,
  TaskCategory,
  TaskCategoryColor,
  TaskCategoryInput,
  TaskCategoryRules,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface TaskCategoryPrefill {
  name?: string;
  color?: TaskCategoryColor;
  rules?: TaskCategoryRules;
}

interface TaskCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing category when editing; null when creating a new category */
  category: TaskCategory | null;
  /** Optional initial values when creating a category from a task or notebook */
  prefill?: TaskCategoryPrefill | null;
  notebooks: Notebook[];
  tags: Tag[];
  /** All tasks in Tasks Hub, used for live rule match preview */
  allTasks: readonly MatchableTask[];
  isSaving?: boolean;
  isDeleting?: boolean;
  onSave: (input: TaskCategoryInput, existingId: string | null) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
}

interface FormState {
  name: string;
  color: TaskCategoryColor;
  notebookIds: string[];
  pathPrefixesText: string;
  sourceUrlsText: string;
  tagIds: string[];
  keywordsText: string;
  taskKind: "" | "todo" | "inline";
}

function buildInitialForm(
  category: TaskCategory | null,
  prefill: TaskCategoryPrefill | null | undefined
): FormState {
  const source = category ?? prefill ?? null;
  const rules = source?.rules ?? {};
  return {
    name: source?.name ?? "",
    color: source?.color ?? "terracotta",
    notebookIds: [...(rules.notebookIds ?? [])],
    pathPrefixesText: (rules.notebookPathPrefixes ?? []).join(", "),
    sourceUrlsText: (rules.sourceUrlPatterns ?? []).join(", "),
    tagIds: [...(rules.tagIds ?? [])],
    keywordsText: (rules.keywords ?? []).join(", "),
    taskKind: rules.taskKind ?? "",
  };
}

/**
 * Dialog for creating, editing, and deleting custom Tasks Hub categories with optional
 * automatic matching rules (notebook, import path prefix, source URL, tag, keyword, task type).
 */
export function TaskCategoryDialog({
  open,
  onOpenChange,
  category,
  prefill,
  notebooks,
  tags,
  allTasks,
  isSaving = false,
  isDeleting = false,
  onSave,
  onDelete,
}: TaskCategoryDialogProps) {
  const formSessionKey = `${open ? "open" : "closed"}:${category?.id ?? "new"}:${prefill?.name ?? ""}:${(prefill?.rules?.notebookPathPrefixes ?? []).join("|")}`;
  const [prevSessionKey, setPrevSessionKey] = useState(formSessionKey);
  const [form, setForm] = useState<FormState>(() => buildInitialForm(category, prefill));
  const [notebookQuery, setNotebookQuery] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (formSessionKey !== prevSessionKey) {
    setPrevSessionKey(formSessionKey);
    if (open) {
      setForm(buildInitialForm(category, prefill));
      setNotebookQuery("");
      setConfirmingDelete(false);
    }
  }

  const notebookPathById = useMemo(() => buildNotebookPathMap(notebooks), [notebooks]);
  const notebookLineageById = useMemo(() => buildNotebookLineageMap(notebooks), [notebooks]);

  const flatNotebooks = useMemo(() => {
    const flat = flattenNotebooks(notebooks).filter((nb) => !nb.encrypted);
    return flat.map((nb) => ({
      id: nb.id,
      path: notebookPathById.get(nb.id) || nb.title || "Untitled Folder",
    }));
  }, [notebooks, notebookPathById]);

  const filteredNotebooks = useMemo(() => {
    const q = notebookQuery.trim().toLowerCase();
    if (!q) return flatNotebooks;
    return flatNotebooks.filter((nb) => nb.path.toLowerCase().includes(q));
  }, [flatNotebooks, notebookQuery]);

  const draftRules = useMemo<TaskCategoryRules>(() => {
    const rules: TaskCategoryRules = {};
    if (form.notebookIds.length > 0) rules.notebookIds = form.notebookIds;
    const prefixes = parseRuleTokens(form.pathPrefixesText);
    if (prefixes.length > 0) rules.notebookPathPrefixes = prefixes;
    const urls = parseRuleTokens(form.sourceUrlsText);
    if (urls.length > 0) rules.sourceUrlPatterns = urls;
    if (form.tagIds.length > 0) rules.tagIds = form.tagIds;
    const keywords = parseRuleTokens(form.keywordsText);
    if (keywords.length > 0) rules.keywords = keywords;
    if (form.taskKind === "todo" || form.taskKind === "inline") {
      rules.taskKind = form.taskKind;
    }
    return rules;
  }, [form]);

  const rulesConfigured = hasCategoryRules(draftRules);

  const liveMatchCount = useMemo(() => {
    if (!rulesConfigured) return 0;
    let count = 0;
    for (const task of allTasks) {
      if (taskMatchesRules(task, draftRules, notebookLineageById)) count++;
    }
    return count;
  }, [allTasks, draftRules, rulesConfigured, notebookLineageById]);

  const toggleNotebookId = (nbId: string) => {
    setForm((prev) => ({
      ...prev,
      notebookIds: prev.notebookIds.includes(nbId)
        ? prev.notebookIds.filter((id) => id !== nbId)
        : [...prev.notebookIds, nbId],
    }));
  };

  const toggleTagId = (tagId: string) => {
    setForm((prev) => ({
      ...prev,
      tagIds: prev.tagIds.includes(tagId)
        ? prev.tagIds.filter((id) => id !== tagId)
        : [...prev.tagIds, tagId],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = form.name.trim();
    if (!trimmed) return;
    await onSave(
      {
        name: trimmed,
        color: form.color,
        rules: draftRules,
      },
      category?.id ?? null
    );
  };

  const busy = isSaving || isDeleting;
  const visibleTags = tags.filter((t) => !t.encrypted);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{category ? "Edit Task Category" : "New Task Category"}</DialogTitle>
          <DialogDescription>
            Group tasks automatically by import path, notebook, source URL, tag, or keyword — or leave
            rules empty for manual assignment.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 min-w-0">
          <div className="space-y-1.5">
            <Label htmlFor="task-category-name" className="text-xs">
              Category name
            </Label>
            <Input
              id="task-category-name"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Facebook Bookmarked"
              maxLength={60}
              required
              autoFocus
              className="h-9 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Color</Label>
            <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Category color">
              {TASK_CATEGORY_COLORS.map((swatch) => {
                const selected = form.color === swatch.id;
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={swatch.label}
                    onClick={() => setForm((prev) => ({ ...prev, color: swatch.id }))}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full border-2 transition-transform",
                      swatch.dotClass,
                      selected
                        ? "border-foreground scale-110"
                        : "border-transparent opacity-80 hover:opacity-100"
                    )}
                  >
                    {selected && <Check className="h-3.5 w-3.5 text-white drop-shadow-xs" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              <span>Auto-categorize rules (optional)</span>
            </div>

            {flatNotebooks.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">Notebooks (includes sub-notebooks)</Label>
                  {form.notebookIds.length > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {form.notebookIds.length} selected
                    </span>
                  )}
                </div>
                {flatNotebooks.length > 6 && (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={notebookQuery}
                      onChange={(e) => setNotebookQuery(e.target.value)}
                      placeholder="Filter notebooks…"
                      aria-label="Filter rule notebooks"
                      className="h-7 pl-8 text-xs"
                    />
                  </div>
                )}
                <div className="max-h-36 overflow-y-auto overflow-x-hidden rounded-md border border-border bg-background p-1 space-y-0.5">
                  {filteredNotebooks.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching notebooks</p>
                  ) : (
                    filteredNotebooks.map((nb) => {
                      const checked = form.notebookIds.includes(nb.id);
                      return (
                        <button
                          key={nb.id}
                          type="button"
                          onClick={() => toggleNotebookId(nb.id)}
                          aria-pressed={checked}
                          className={cn(
                            "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
                            checked && "bg-primary/10 font-medium text-foreground"
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/40"
                            )}
                          >
                            {checked && <Check className="h-2.5 w-2.5" />}
                          </span>
                          <Folder className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                          <span className="truncate">{nb.path}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="task-category-paths" className="text-xs">
                Import / notebook path prefixes
              </Label>
              <Input
                id="task-category-paths"
                value={form.pathPrefixesText}
                onChange={(e) => setForm((prev) => ({ ...prev, pathPrefixesText: e.target.value }))}
                placeholder="e.g. Saved items / Facebook, Saved items / X"
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="task-category-urls" className="text-xs">
                Source URL contains
              </Label>
              <Input
                id="task-category-urls"
                value={form.sourceUrlsText}
                onChange={(e) => setForm((prev) => ({ ...prev, sourceUrlsText: e.target.value }))}
                placeholder="e.g. facebook.com, fb.watch"
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="task-category-keywords" className="text-xs">
                Title keywords
              </Label>
              <Input
                id="task-category-keywords"
                value={form.keywordsText}
                onChange={(e) => setForm((prev) => ({ ...prev, keywordsText: e.target.value }))}
                placeholder="e.g. invoice, renewal"
                className="h-8 text-xs"
              />
            </div>

            {visibleTags.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Tags</Label>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {visibleTags.map((tag) => {
                    const selected = form.tagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleTagId(tag.id)}
                        className={cn(
                          "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                          selected
                            ? "border-primary/50 bg-primary/15 text-foreground font-medium"
                            : "border-border bg-background text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <TagIcon className="h-2.5 w-2.5 shrink-0 opacity-70" aria-hidden="true" />
                        <span className="truncate">{tag.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">Task type</Label>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { value: "", label: "Both" },
                    { value: "todo", label: "To-do notes" },
                    { value: "inline", label: "Checklists" },
                  ] as const
                ).map((opt) => (
                  <Button
                    key={opt.value || "both"}
                    type="button"
                    size="sm"
                    variant={form.taskKind === opt.value ? "secondary" : "outline"}
                    onClick={() => setForm((prev) => ({ ...prev, taskKind: opt.value }))}
                    className={cn(
                      "h-7 px-2.5 text-xs",
                      form.taskKind === opt.value && "border-primary/40 bg-primary/10"
                    )}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground pt-0.5">
              {rulesConfigured
                ? `Matches ${liveMatchCount} ${liveMatchCount === 1 ? "task" : "tasks"} currently.`
                : "No auto-match rules — assign tasks manually from any task card."}
            </p>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {category && onDelete ? (
              confirmingDelete ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void onDelete(category.id)}
                    className="h-8 text-xs"
                  >
                    Confirm delete
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmingDelete(false)}
                    className="h-8 text-xs"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                  className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-3.5!" aria-hidden="true" />
                  Delete
                </Button>
              )
            ) : (
              <div />
            )}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !form.name.trim()}
                className="h-8 text-xs"
              >
                {category ? "Save changes" : "Create category"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
