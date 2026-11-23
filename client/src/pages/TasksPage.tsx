import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  Layers,
  ListChecks,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { QueryError } from "@/components/common/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes } from "@/hooks/use-notes";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useUpdateNote } from "@/hooks/use-mutations";
import { useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import { TASKS_QUERY_KEY, useTasks, useToggleInlineTask } from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { ApiError } from "@/lib/api";
import { formatDueDate, isOverdue } from "@/lib/due";
import { noteDisplayTitle } from "@/lib/format";
import { buildNotebookPathMap } from "@/lib/notebooks";
import type { InlineTaskItem, TodoTaskItem } from "@/lib/types";
import {
  TASKS_GROUP_BY_CATEGORY_STORAGE_KEY,
  TASKS_HIDDEN_CATEGORIES_STORAGE_KEY,
} from "@/lib/ui-constants";
import { cn } from "@/lib/utils";

type TaskFilter = "open" | "overdue" | "completed" | "inline" | "todos";

const GROUP_PREFIX = "group:";
const TASKS_PAGE_SIZE = 100;
const TASKS_GROUP_PAGE_SIZE = 25;
const QUICK_CATEGORY_LIMIT = 3;

interface TaskBase {
  key: string;
  noteId: string;
  title: string;
  noteTitle: string;
  notebookId: string;
  notebookTitle: string;
  categoryKey: string;
  categoryLabel: string;
  topCategory: string;
  completed: boolean;
  dueMs: number;
  overdue: boolean;
  updatedTime: number;
}

type UnifiedTask =
  | (TaskBase & {
      kind: "todo";
      raw: TodoTaskItem;
    })
  | (TaskBase & {
      kind: "inline";
      raw: InlineTaskItem;
    });

interface TaskCategoryInfo {
  key: string;
  label: string;
  topCategory: string;
  tabCount: number;
  totalCount: number;
  hidden: boolean;
}

interface TaskCategoryGroupInfo {
  key: string;
  label: string;
  topCategory: string;
  memberKeys: string[];
  tabCount: number;
  totalCount: number;
  allHidden: boolean;
}

function isGroupCategoryKey(key: string): boolean {
  return key.startsWith(GROUP_PREFIX);
}

function groupNameFromKey(key: string): string {
  return key.slice(GROUP_PREFIX.length);
}

function loadGroupByCategory(): boolean {
  try {
    return localStorage.getItem(TASKS_GROUP_BY_CATEGORY_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveGroupByCategory(grouped: boolean) {
  try {
    localStorage.setItem(TASKS_GROUP_BY_CATEGORY_STORAGE_KEY, grouped ? "true" : "false");
  } catch {
    // storage unavailable
  }
}

function loadHiddenCategories(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TASKS_HIDDEN_CATEGORIES_STORAGE_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      return new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0));
    }
  } catch {
    // storage unavailable or invalid JSON
  }
  return new Set();
}

function saveHiddenCategories(hidden: ReadonlySet<string>) {
  try {
    localStorage.setItem(TASKS_HIDDEN_CATEGORIES_STORAGE_KEY, JSON.stringify([...hidden]));
  } catch {
    // storage unavailable
  }
}

function matchesTab(item: UnifiedTask, tab: TaskFilter): boolean {
  if (tab === "open") return !item.completed;
  if (tab === "overdue") return item.overdue;
  if (tab === "completed") return item.completed;
  if (tab === "inline") return item.kind === "inline";
  if (tab === "todos") return item.kind === "todo";
  return true;
}

function matchesCategorySelection(
  item: UnifiedTask,
  selectedCategory: string,
  hiddenCategories: ReadonlySet<string>
): boolean {
  if (selectedCategory === "all") {
    return !hiddenCategories.has(item.categoryKey);
  }
  if (isGroupCategoryKey(selectedCategory)) {
    return item.topCategory === groupNameFromKey(selectedCategory);
  }
  return item.categoryKey === selectedCategory;
}

export function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [headerSearch, setHeaderSearch] = useState("");
  const [filterText, setFilterText] = useState("");
  const [tab, setTab] = useState<TaskFilter>("open");
  const [mountTime] = useState(() => Date.now());
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [groupByCategory, setGroupByCategory] = useState<boolean>(loadGroupByCategory);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(loadHiddenCategories);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(TASKS_PAGE_SIZE);
  const [groupLimits, setGroupLimits] = useState<Record<string, number>>({});

  const selectedCategory = searchParams.get("category") || "all";

  const selectCategory = (next: string) => {
    setSearchParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (!next || next === "all") updated.delete("category");
        else updated.set("category", next);
        return updated;
      },
      { replace: true }
    );
  };

  // Reset progressive render slices synchronously when the active view changes
  const sliceResetKey = `${tab}\0${selectedCategory}\0${filterText}`;
  const [prevSliceResetKey, setPrevSliceResetKey] = useState(sliceResetKey);
  if (sliceResetKey !== prevSliceResetKey) {
    setPrevSliceResetKey(sliceResetKey);
    if (visibleCount !== TASKS_PAGE_SIZE) setVisibleCount(TASKS_PAGE_SIZE);
    if (Object.keys(groupLimits).length > 0) setGroupLimits({});
  }

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: notebooks } = useNotebooks();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const tasksQuery = useTasks(true);
  const updateNote = useUpdateNote();
  const toggleInline = useToggleInlineTask();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const notebookPathById = useMemo(() => buildNotebookPathMap(notebooks), [notebooks]);

  const allTasks = useMemo<UnifiedTask[]>(() => {
    const resolveCategory = (notebookId: string, notebookPath: string | undefined, notebookTitle: string) => {
      const label =
        notebookPath?.trim() ||
        (notebookId ? notebookPathById.get(notebookId) : undefined) ||
        notebookTitle.trim() ||
        "Uncategorized";
      const key = notebookId || `title:${label.toLowerCase()}`;
      const topCategory = label.split(" / ")[0] || label;
      return { categoryKey: key, categoryLabel: label, topCategory };
    };

    const todoList: UnifiedTask[] = (tasksQuery.data?.todoNotes ?? []).map((t) => {
      const notebookId = t.parentId || t.notebookId || "";
      const notebookTitle = t.notebookTitle || "Notebook";
      const cat = resolveCategory(notebookId, t.notebookPath, t.notebookTitle || "");
      return {
        kind: "todo",
        key: `todo-${t.id}`,
        noteId: t.id,
        title: noteDisplayTitle(t),
        noteTitle: noteDisplayTitle(t),
        notebookId,
        notebookTitle,
        ...cat,
        completed: Boolean(t.todoCompleted),
        dueMs: t.todoDue ?? 0,
        overdue: isOverdue({ isTodo: true, todoDue: t.todoDue, todoCompleted: t.todoCompleted }, mountTime),
        updatedTime: t.updatedTime,
        raw: t,
      };
    });

    const inlineList: UnifiedTask[] = (tasksQuery.data?.inlineTasks ?? []).map((t) => {
      const notebookId = t.parentId || "";
      const notebookTitle = t.notebookTitle || "Notebook";
      const cat = resolveCategory(notebookId, t.notebookPath, t.notebookTitle || "");
      return {
        kind: "inline",
        key: `inline-${t.noteId}-${t.line}-${t.column}`,
        noteId: t.noteId,
        title: t.text,
        noteTitle: t.noteTitle || "Untitled Note",
        notebookId,
        notebookTitle,
        ...cat,
        completed: t.checked,
        dueMs: 0,
        overdue: false,
        updatedTime: t.updatedTime,
        raw: t,
      };
    });

    return [...todoList, ...inlineList].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.dueMs && b.dueMs && a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
      return b.updatedTime - a.updatedTime;
    });
  }, [tasksQuery.data, mountTime, notebookPathById]);

  const { allCategories, parentGroups, categoryByKey, parentGroupByKey } = useMemo(() => {
    const map = new Map<string, TaskCategoryInfo>();
    for (const item of allTasks) {
      let info = map.get(item.categoryKey);
      if (!info) {
        info = {
          key: item.categoryKey,
          label: item.categoryLabel,
          topCategory: item.topCategory,
          tabCount: 0,
          totalCount: 0,
          hidden: hiddenCategories.has(item.categoryKey),
        };
        map.set(item.categoryKey, info);
      }
      info.totalCount++;
      if (matchesTab(item, tab)) info.tabCount++;
    }

    const sortedCategories = [...map.values()].sort(
      (a, b) => b.tabCount - a.tabCount || b.totalCount - a.totalCount || a.label.localeCompare(b.label)
    );

    const byTop = new Map<string, TaskCategoryInfo[]>();
    for (const cat of sortedCategories) {
      const list = byTop.get(cat.topCategory) ?? [];
      list.push(cat);
      byTop.set(cat.topCategory, list);
    }

    const groups: TaskCategoryGroupInfo[] = [];
    for (const [topCategory, members] of byTop) {
      if (members.length < 2) continue;
      groups.push({
        key: `${GROUP_PREFIX}${topCategory}`,
        label: `${topCategory} (all)`,
        topCategory,
        memberKeys: members.map((m) => m.key),
        tabCount: members.reduce((sum, m) => sum + m.tabCount, 0),
        totalCount: members.reduce((sum, m) => sum + m.totalCount, 0),
        allHidden: members.every((m) => m.hidden),
      });
    }
    groups.sort(
      (a, b) => b.tabCount - a.tabCount || b.totalCount - a.totalCount || a.label.localeCompare(b.label)
    );

    return {
      allCategories: sortedCategories,
      parentGroups: groups,
      categoryByKey: map,
      parentGroupByKey: new Map(groups.map((g) => [g.key, g])),
    };
  }, [allTasks, tab, hiddenCategories]);

  // Tasks within the active category scope (drives status tab counts and task list)
  const categoryScopedTasks = useMemo(
    () => allTasks.filter((item) => matchesCategorySelection(item, selectedCategory, hiddenCategories)),
    [allTasks, selectedCategory, hiddenCategories]
  );

  const counts = useMemo(() => {
    let open = 0;
    let overdue = 0;
    let completed = 0;
    let inline = 0;
    let todos = 0;
    for (const item of categoryScopedTasks) {
      if (item.completed) completed++;
      else open++;
      if (item.overdue) overdue++;
      if (item.kind === "inline") inline++;
      else todos++;
    }
    return { open, overdue, completed, inline, todos };
  }, [categoryScopedTasks]);

  const visibleAllTabCount = useMemo(
    () =>
      allTasks.reduce(
        (sum, item) => sum + (!hiddenCategories.has(item.categoryKey) && matchesTab(item, tab) ? 1 : 0),
        0
      ),
    [allTasks, hiddenCategories, tab]
  );

  const activeHiddenCategoryCount = useMemo(
    () => allCategories.reduce((sum, cat) => sum + (cat.hidden ? 1 : 0), 0),
    [allCategories]
  );

  const filteredTasks = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return categoryScopedTasks.filter((item) => {
      if (!matchesTab(item, tab)) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.noteTitle.toLowerCase().includes(q) ||
        item.notebookTitle.toLowerCase().includes(q) ||
        item.categoryLabel.toLowerCase().includes(q)
      );
    });
  }, [categoryScopedTasks, tab, filterText]);

  const groupedTasks = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; label: string; tasks: UnifiedTask[]; hasOverdue: boolean }
    >();
    for (const task of filteredTasks) {
      let group = groups.get(task.categoryKey);
      if (!group) {
        group = { key: task.categoryKey, label: task.categoryLabel, tasks: [], hasOverdue: false };
        groups.set(task.categoryKey, group);
      }
      group.tasks.push(task);
      if (task.overdue) group.hasOverdue = true;
    }
    return [...groups.values()].sort(
      (a, b) =>
        Number(b.hasOverdue) - Number(a.hasOverdue) ||
        b.tasks.length - a.tasks.length ||
        a.label.localeCompare(b.label)
    );
  }, [filteredTasks]);

  const quickCategories = useMemo(() => {
    const visibleTop = allCategories.filter((c) => !c.hidden && c.tabCount > 0).slice(0, QUICK_CATEGORY_LIMIT);
    const chips: Array<{ key: string; label: string; count: number; isGroup?: boolean }> = visibleTop.map(
      (c) => ({
        key: c.key,
        label: c.label,
        count: c.tabCount,
      })
    );
    if (selectedCategory !== "all" && !chips.some((c) => c.key === selectedCategory)) {
      if (isGroupCategoryKey(selectedCategory)) {
        const g = parentGroupByKey.get(selectedCategory);
        chips.push({
          key: selectedCategory,
          label: g?.label ?? `${groupNameFromKey(selectedCategory)} (all)`,
          count: g?.tabCount ?? 0,
          isGroup: true,
        });
      } else {
        const c = categoryByKey.get(selectedCategory);
        chips.push({
          key: selectedCategory,
          label: c?.label ?? notebookPathById.get(selectedCategory) ?? "Selected category",
          count: c?.tabCount ?? 0,
        });
      }
    }
    return chips;
  }, [allCategories, selectedCategory, parentGroupByKey, categoryByKey, notebookPathById]);

  const selectedCategoryHiddenKeys = useMemo(() => {
    if (selectedCategory === "all") return [];
    if (isGroupCategoryKey(selectedCategory)) {
      const g = parentGroupByKey.get(selectedCategory);
      return (g?.memberKeys ?? []).filter((k) => hiddenCategories.has(k));
    }
    return hiddenCategories.has(selectedCategory) ? [selectedCategory] : [];
  }, [selectedCategory, parentGroupByKey, hiddenCategories]);

  const filteredPopoverGroups = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return parentGroups;
    return parentGroups.filter((g) => g.label.toLowerCase().includes(q));
  }, [parentGroups, categorySearch]);

  const filteredPopoverCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return allCategories;
    return allCategories.filter((c) => c.label.toLowerCase().includes(q));
  }, [allCategories, categorySearch]);

  const updateHiddenCategories = (updater: (prev: Set<string>) => Set<string>) => {
    setHiddenCategories((prev) => {
      const next = updater(new Set(prev));
      saveHiddenCategories(next);
      return next;
    });
  };

  const toggleHideCategory = (categoryKey: string, label: string, showToast = false) => {
    const wasHidden = hiddenCategories.has(categoryKey);
    updateHiddenCategories((next) => {
      if (wasHidden) next.delete(categoryKey);
      else next.add(categoryKey);
      return next;
    });
    if (showToast && !wasHidden) {
      toast.info(`Hid "${label}" from All`, {
        action: {
          label: "Undo",
          onClick: () => {
            updateHiddenCategories((next) => {
              next.delete(categoryKey);
              return next;
            });
          },
        },
      });
    }
  };

  const toggleHideGroup = (group: TaskCategoryGroupInfo) => {
    updateHiddenCategories((next) => {
      if (group.allHidden) {
        for (const k of group.memberKeys) next.delete(k);
      } else {
        for (const k of group.memberKeys) next.add(k);
      }
      return next;
    });
  };

  const showHiddenKeys = (keys: string[]) => {
    updateHiddenCategories((next) => {
      for (const k of keys) next.delete(k);
      return next;
    });
  };

  const clearAllHiddenCategories = () => {
    updateHiddenCategories(() => new Set());
  };

  const toggleGroupByCategory = () => {
    setGroupByCategory((prev) => {
      const next = !prev;
      saveGroupByCategory(next);
      return next;
    });
  };

  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const allGroupsCollapsed =
    groupedTasks.length > 0 && groupedTasks.every((g) => collapsedGroups.has(g.key));

  const toggleAllGroupsCollapsed = () => {
    if (allGroupsCollapsed) {
      setCollapsedGroups(new Set());
    } else {
      setCollapsedGroups(new Set(groupedTasks.map((g) => g.key)));
    }
  };

  const handleToggle = async (task: UnifiedTask) => {
    if (readOnly) return;
    if (task.kind === "todo") {
      try {
        await updateNote.mutateAsync({
          id: task.noteId,
          changes: { todoCompleted: !task.completed },
        });
        await queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
      } catch (err) {
        toast.error("Could not update to-do", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
      return;
    }

    try {
      await toggleInline.mutateAsync({
        noteId: task.noteId,
        line: task.raw.line,
        column: task.raw.column,
        checked: !task.completed,
        baseUpdatedTime: task.updatedTime,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.warning("Checklist moved since this list loaded; refreshed.");
      } else {
        toast.error("Could not toggle checklist item", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    }
  };

  const renderTaskCard = (task: UnifiedTask, showCategoryBadge: boolean) => {
    const busy = updateNote.isPending || toggleInline.isPending;
    return (
      <div
        key={task.key}
        className={cn(
          "flex min-w-0 items-start gap-3 overflow-hidden rounded-xl border border-border bg-card/50 px-3.5 py-2.5 transition-colors hover:bg-card",
          task.completed && "opacity-70"
        )}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={task.completed}
          aria-label={`Toggle "${task.title}"`}
          disabled={readOnly || busy}
          onClick={() => void handleToggle(task)}
          className="mt-0.5 shrink-0 text-primary disabled:opacity-50"
        >
          {task.completed ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground hover:text-primary" />
          )}
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
            {task.kind === "todo" ? (
              <Link
                to={`/notes/${task.noteId}`}
                className={cn(
                  "inline-flex min-w-0 max-w-full items-start gap-1 text-sm font-medium text-foreground hover:text-primary hover:underline",
                  task.completed && "line-through text-muted-foreground"
                )}
              >
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{task.title}</span>
                <ExternalLink className="mt-1 h-3 w-3 shrink-0 opacity-70" />
              </Link>
            ) : (
              <span
                className={cn(
                  "min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-sm font-medium text-foreground",
                  task.completed && "line-through text-muted-foreground"
                )}
              >
                {task.title}
              </span>
            )}
            <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
              {task.kind === "todo" ? "To-do" : "Checklist"}
            </Badge>
            {task.dueMs > 0 && (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-[11px] font-mono",
                  task.overdue ? "text-destructive font-semibold" : "text-muted-foreground"
                )}
              >
                {task.overdue ? <AlertCircle className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                {formatDueDate(task.dueMs)}
              </span>
            )}
          </div>

          {(task.kind === "inline" || showCategoryBadge) && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {task.kind === "inline" && (
                <Link
                  to={`/notes/${task.noteId}`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 hover:text-primary hover:underline"
                >
                  <span className="truncate">{task.noteTitle}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </Link>
              )}
              {showCategoryBadge && (
                <button
                  type="button"
                  onClick={() => selectCategory(task.categoryKey)}
                  title={`Filter by ${task.categoryLabel}`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Folder className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                  <span className="truncate">{task.categoryLabel}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const visibleFlatTasks = filteredTasks.slice(0, visibleCount);
  const remainingFlatCount = Math.max(0, filteredTasks.length - visibleFlatTasks.length);

  return (
    <AppLayout
      notebookTitle="Tasks"
      searchQuery={headerSearch}
      onSearchChange={(q) => {
        setHeaderSearch(q);
        if (q.trim().length >= 2) {
          navigate(`/notes?q=${encodeURIComponent(q.trim())}`);
        }
      }}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      sidebar={({ onCloseMobile, aiEnabled, onOpenAskAi }) => (
        <Sidebar
          selectedNotebookId={null}
          selectedTagId={null}
          activeView="tasks"
          conflictCount={conflictNotes?.length ?? 0}
          organizeJobCount={organizeJobs.length}
          runningOrganizeJob={hasRunningJob}
          aiEnabled={aiEnabled}
          onOpenAskAi={onOpenAskAi}
          onSelectConflicts={() => {
            navigate("/conflicts");
            onCloseMobile?.();
          }}
          onSelectOrganize={() => {
            navigate("/organize");
            onCloseMobile?.();
          }}
          onSelectAllNotes={() => {
            navigate("/notes");
            onCloseMobile?.();
          }}
          onSelectTrash={() => {
            navigate("/trash");
            onCloseMobile?.();
          }}
          onSelectNotebook={(id) => {
            navigate(`/notebooks/${id}`);
            onCloseMobile?.();
          }}
          onSelectTag={(id) => {
            navigate(`/notes?tag=${encodeURIComponent(id)}`);
            onCloseMobile?.();
          }}
          searchQuery={headerSearch}
          onSearchChange={(q) => {
            setHeaderSearch(q);
            if (q.trim().length >= 2) {
              navigate(`/notes?q=${encodeURIComponent(q.trim())}`);
              onCloseMobile?.();
            }
          }}
          onCloseMobile={onCloseMobile}
          readOnly={readOnly}
        />
      )}
    >
      <div className="flex flex-col h-full min-w-0 w-full bg-background overflow-hidden">
        <div className="shrink-0 min-w-0 overflow-x-hidden border-b border-border bg-card/40 px-4 py-4 sm:px-8 space-y-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
                <CheckSquare className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                Tasks Hub
              </h1>
              <p className="text-xs text-muted-foreground">
                To-do notes and interactive `- [ ]` checkboxes aggregated across your notes.
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter tasks…"
                aria-label="Filter tasks"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {(
              [
                { id: "open", label: `Open (${counts.open})` },
                { id: "overdue", label: `Overdue (${counts.overdue})` },
                { id: "completed", label: `Completed (${counts.completed})` },
                { id: "todos", label: `To-do Notes (${counts.todos})` },
                { id: "inline", label: `Checklists (${counts.inline})` },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.id}
                type="button"
                size="sm"
                variant={tab === opt.id ? "default" : "outline"}
                onClick={() => setTab(opt.id)}
                className="h-7 px-2.5 text-xs"
              >
                {opt.label}
              </Button>
            ))}
          </div>

          {allCategories.length > 0 && (
            <div
              className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5"
              role="group"
              aria-label="Task categories"
            >
              <Button
                type="button"
                size="sm"
                variant={selectedCategory === "all" ? "secondary" : "ghost"}
                onClick={() => selectCategory("all")}
                className={cn(
                  "h-7 px-2.5 text-xs border",
                  selectedCategory === "all"
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border/60 text-muted-foreground"
                )}
              >
                All ({visibleAllTabCount})
              </Button>

              {quickCategories.map((chip) => {
                const active = selectedCategory === chip.key;
                return (
                  <Button
                    key={chip.key}
                    type="button"
                    size="sm"
                    variant={active ? "secondary" : "ghost"}
                    onClick={() => selectCategory(active ? "all" : chip.key)}
                    title={chip.label}
                    className={cn(
                      "h-7 max-w-full min-w-0 gap-1.5 px-2.5 text-xs border",
                      active
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border/60 text-muted-foreground"
                    )}
                  >
                    <Folder className="size-3! shrink-0 opacity-75" aria-hidden="true" />
                    <span className="truncate">{chip.label}</span>{" "}
                    <span className="shrink-0 opacity-75">({chip.count})</span>
                  </Button>
                );
              })}

              <Popover
                open={categoryMenuOpen}
                onOpenChange={(open) => {
                  setCategoryMenuOpen(open);
                  if (!open) setCategorySearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="Choose task category"
                    className="h-7 gap-1 px-2.5 text-xs"
                  >
                    <span>Categories ({allCategories.length})</span>
                    <ChevronDown className="size-3! opacity-70" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-80 max-w-[calc(100vw-2rem)] p-2 space-y-2"
                >
                  {allCategories.length > 6 && (
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={categorySearch}
                        onChange={(e) => setCategorySearch(e.target.value)}
                        placeholder="Filter categories…"
                        aria-label="Filter categories"
                        className="h-7 pl-8 text-xs"
                      />
                    </div>
                  )}

                  <div className="max-h-72 overflow-y-auto overflow-x-hidden space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          selectCategory("all");
                          setCategoryMenuOpen(false);
                        }}
                        className={cn(
                          "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                          selectedCategory === "all" && "bg-accent font-medium text-foreground"
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Check
                            className={cn(
                              "h-3.5 w-3.5 shrink-0",
                              selectedCategory === "all" ? "opacity-100 text-primary" : "opacity-0"
                            )}
                            aria-hidden="true"
                          />
                          <span className="truncate">All categories</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {visibleAllTabCount}
                        </span>
                      </button>
                      {activeHiddenCategoryCount > 0 && (
                        <button
                          type="button"
                          onClick={clearAllHiddenCategories}
                          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-primary hover:bg-accent"
                        >
                          Show all
                        </button>
                      )}
                    </div>

                    {filteredPopoverGroups.length > 0 && (
                      <div className="pt-1 space-y-0.5">
                        <p className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Groups
                        </p>
                        {filteredPopoverGroups.map((group) => {
                          const active = selectedCategory === group.key;
                          return (
                            <div key={group.key} className="flex min-w-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  selectCategory(group.key);
                                  setCategoryMenuOpen(false);
                                }}
                                className={cn(
                                  "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                                  active && "bg-accent font-medium text-foreground",
                                  group.allHidden && "text-muted-foreground"
                                )}
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <Check
                                    className={cn(
                                      "h-3.5 w-3.5 shrink-0",
                                      active ? "opacity-100 text-primary" : "opacity-0"
                                    )}
                                    aria-hidden="true"
                                  />
                                  <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                                  <span className="truncate">{group.label}</span>
                                </span>{" "}
                                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                  {group.tabCount}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleHideGroup(group)}
                                aria-label={
                                  group.allHidden
                                    ? `Show ${group.label} in All`
                                    : `Hide ${group.label} from All`
                                }
                                title={
                                  group.allHidden
                                    ? `Show ${group.label} in All`
                                    : `Hide ${group.label} from All`
                                }
                                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              >
                                {group.allHidden ? (
                                  <Eye className="h-3.5 w-3.5 text-primary" />
                                ) : (
                                  <EyeOff className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="pt-1 space-y-0.5">
                      <p className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Notebooks
                      </p>
                      {filteredPopoverCategories.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-muted-foreground">No matching categories</p>
                      ) : (
                        filteredPopoverCategories.map((cat) => {
                          const active = selectedCategory === cat.key;
                          return (
                            <div key={cat.key} className="flex min-w-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  selectCategory(cat.key);
                                  setCategoryMenuOpen(false);
                                }}
                                className={cn(
                                  "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                                  active && "bg-accent font-medium text-foreground",
                                  cat.hidden && "text-muted-foreground"
                                )}
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <Check
                                    className={cn(
                                      "h-3.5 w-3.5 shrink-0",
                                      active ? "opacity-100 text-primary" : "opacity-0"
                                    )}
                                    aria-hidden="true"
                                  />
                                  <span className="truncate">{cat.label}</span>
                                </span>{" "}
                                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                  {cat.tabCount}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleHideCategory(cat.key, cat.label)}
                                aria-label={
                                  cat.hidden ? `Show ${cat.label} in All` : `Hide ${cat.label} from All`
                                }
                                title={
                                  cat.hidden ? `Show ${cat.label} in All` : `Hide ${cat.label} from All`
                                }
                                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              >
                                {cat.hidden ? (
                                  <Eye className="h-3.5 w-3.5 text-primary" />
                                ) : (
                                  <EyeOff className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              {selectedCategory !== "all" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => selectCategory("all")}
                  aria-label="Clear category filter"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3!" aria-hidden="true" />
                  Clear
                </Button>
              )}

              {activeHiddenCategoryCount > 0 && selectedCategory === "all" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setCategoryMenuOpen(true)}
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <EyeOff className="size-3!" aria-hidden="true" />
                  <span>{activeHiddenCategoryCount} hidden</span>
                </Button>
              )}

              <Button
                type="button"
                size="sm"
                variant={groupByCategory ? "secondary" : "outline"}
                aria-pressed={groupByCategory}
                onClick={toggleGroupByCategory}
                title="Group tasks by category"
                className={cn(
                  "h-7 gap-1.5 px-2.5 text-xs",
                  groupByCategory && "border-primary/40 bg-primary/10 text-foreground"
                )}
              >
                <Layers className="size-3! shrink-0" aria-hidden="true" />
                <span>Group</span>
              </Button>
            </div>
          )}
        </div>

        <div
          data-testid="tasks-scroll-container"
          className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-8"
        >
          <div className="mx-auto w-full max-w-4xl min-w-0 space-y-3">
            {selectedCategoryHiddenKeys.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Hidden from All categories view.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => showHiddenKeys(selectedCategoryHiddenKeys)}
                  className="h-7 px-2.5 text-xs"
                >
                  Show in All
                </Button>
              </div>
            )}

            {tasksQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : tasksQuery.error ? (
              <QueryError
                message="Couldn't load tasks"
                error={tasksQuery.error}
                onRetry={() => void tasksQuery.refetch()}
                isRetrying={tasksQuery.isFetching}
              />
            ) : filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
                <ListChecks className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No tasks in this view</p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  {selectedCategory !== "all" || filterText.trim() || activeHiddenCategoryCount > 0
                    ? "Try switching categories, showing hidden categories, or clearing your filter."
                    : "Create a Joplin to-do note or add `- [ ]` checkboxes inside any Markdown note."}
                </p>
                {(selectedCategory !== "all" || filterText.trim() || activeHiddenCategoryCount > 0) && (
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                    {selectedCategory !== "all" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => selectCategory("all")}
                        className="h-7 text-xs"
                      >
                        Show all categories
                      </Button>
                    )}
                    {activeHiddenCategoryCount > 0 && selectedCategory === "all" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={clearAllHiddenCategories}
                        className="h-7 text-xs"
                      >
                        Show hidden categories
                      </Button>
                    )}
                    {filterText.trim() && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setFilterText("")}
                        className="h-7 text-xs"
                      >
                        Clear filter
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : groupByCategory ? (
              <div className="space-y-4">
                {groupedTasks.length > 1 && (
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{groupedTasks.length} categories</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={toggleAllGroupsCollapsed}
                      className="h-7 px-2 text-xs"
                    >
                      {allGroupsCollapsed ? "Expand all" : "Collapse all"}
                    </Button>
                  </div>
                )}

                {groupedTasks.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  const limit = groupLimits[group.key] ?? TASKS_GROUP_PAGE_SIZE;
                  const visibleGroupTasks = group.tasks.slice(0, limit);
                  const remainingInGroup = Math.max(0, group.tasks.length - visibleGroupTasks.length);

                  return (
                    <section key={group.key} className="min-w-0 space-y-2">
                      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2">
                        <button
                          type="button"
                          aria-expanded={!collapsed}
                          onClick={() => toggleGroupCollapsed(group.key)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold text-foreground hover:text-primary"
                        >
                          {collapsed ? (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <Folder className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                          <span className="truncate">{group.label}</span>
                          <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                            {group.tasks.length}
                          </Badge>
                        </button>

                        {selectedCategory === "all" && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => selectCategory(group.key)}
                              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              Only
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Hide ${group.label} from All`}
                              title={`Hide ${group.label} from All`}
                              onClick={() => toggleHideCategory(group.key, group.label, true)}
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                            >
                              <EyeOff className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>

                      {!collapsed && (
                        <div className="min-w-0 space-y-2 pl-0 sm:pl-2">
                          {visibleGroupTasks.map((task) => renderTaskCard(task, false))}
                          {remainingInGroup > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setGroupLimits((prev) => ({
                                  ...prev,
                                  [group.key]: (prev[group.key] ?? TASKS_GROUP_PAGE_SIZE) + TASKS_PAGE_SIZE,
                                }))
                              }
                              className="w-full h-8 text-xs"
                            >
                              Show more in {group.label} ({remainingInGroup} remaining)
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="min-w-0 space-y-2">
                {visibleFlatTasks.map((task) => renderTaskCard(task, true))}
                {remainingFlatCount > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setVisibleCount((prev) => prev + TASKS_PAGE_SIZE)}
                    className="w-full h-8 text-xs"
                  >
                    Show more ({remainingFlatCount} remaining)
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
