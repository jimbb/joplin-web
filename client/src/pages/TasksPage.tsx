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
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag as TagIcon,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { QueryError } from "@/components/common/QueryError";
import { TaskCategoryDialog, type TaskCategoryPrefill } from "@/components/tasks/TaskCategoryDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes } from "@/hooks/use-notes";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useUpdateNote } from "@/hooks/use-mutations";
import { useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import {
  useCreateTaskCategory,
  useDeleteTaskCategory,
  usePreferences,
  useSetTaskCategoryAssignment,
  useUpdateTaskCategory,
} from "@/hooks/use-preferences";
import { useTags } from "@/hooks/use-tags";
import { TASKS_QUERY_KEY, useTasks, useToggleInlineTask } from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { ApiError } from "@/lib/api";
import { formatDueDate, isOverdue } from "@/lib/due";
import { noteDisplayTitle } from "@/lib/format";
import { buildNotebookPathMap } from "@/lib/notebooks";
import {
  buildNotebookLineageMap,
  customCategoryIdFromKey,
  customCategoryKey,
  extractSourceHost,
  getTaskCategoryColorStyle,
  isCustomCategoryKey,
  resolveTaskCustomCategories,
} from "@/lib/task-categories";
import type {
  InlineTaskItem,
  TaskCategory,
  TaskCategoryColor,
  TaskCategoryInput,
  TodoTaskItem,
} from "@/lib/types";
import {
  TASKS_GROUP_BY_CATEGORY_STORAGE_KEY,
  TASKS_HIDDEN_CATEGORIES_STORAGE_KEY,
} from "@/lib/ui-constants";
import { cn } from "@/lib/utils";

type TaskFilter = "open" | "overdue" | "completed" | "inline" | "todos";

const GROUP_PREFIX = "group:";
const TASKS_PAGE_SIZE = 100;
const TASKS_GROUP_PAGE_SIZE = 25;
const QUICK_CATEGORY_LIMIT = 4;

interface TaskBase {
  key: string;
  noteId: string;
  title: string;
  noteTitle: string;
  notebookId: string;
  notebookTitle: string;
  notebookCategoryKey: string;
  notebookCategoryLabel: string;
  topCategory: string;
  sourceUrl: string;
  tagIds: string[];
  manualCategoryId: string | null;
  autoMatchedCategoryIds: string[];
  effectiveCustomCategoryIds: string[];
  primaryCustomCategory: TaskCategory | null;
  groupKey: string;
  groupLabel: string;
  groupColor?: TaskCategoryColor;
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

interface NotebookCategoryInfo {
  key: string;
  label: string;
  topCategory: string;
  tabCount: number;
  totalCount: number;
  hidden: boolean;
}

interface NotebookCategoryGroupInfo {
  key: string;
  label: string;
  topCategory: string;
  memberKeys: string[];
  tabCount: number;
  totalCount: number;
  allHidden: boolean;
}

interface CustomCategoryInfo {
  category: TaskCategory;
  key: string;
  tabCount: number;
  totalCount: number;
  hidden: boolean;
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

function isTaskHiddenInAll(item: UnifiedTask, hiddenCategories: ReadonlySet<string>): boolean {
  if (hiddenCategories.has(item.notebookCategoryKey)) return true;
  for (const catId of item.effectiveCustomCategoryIds) {
    if (hiddenCategories.has(customCategoryKey(catId))) return true;
  }
  return false;
}

function matchesCategorySelection(
  item: UnifiedTask,
  selectedCategory: string,
  hiddenCategories: ReadonlySet<string>
): boolean {
  if (selectedCategory === "all") {
    return !isTaskHiddenInAll(item, hiddenCategories);
  }
  if (isCustomCategoryKey(selectedCategory)) {
    const targetId = customCategoryIdFromKey(selectedCategory);
    return item.effectiveCustomCategoryIds.includes(targetId);
  }
  if (isGroupCategoryKey(selectedCategory)) {
    return item.topCategory === groupNameFromKey(selectedCategory);
  }
  return item.notebookCategoryKey === selectedCategory;
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
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<TaskCategory | null>(null);
  const [categoryPrefill, setCategoryPrefill] = useState<TaskCategoryPrefill | null>(null);

  const rawSelectedCategory = searchParams.get("category") || "all";

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

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: notebooks } = useNotebooks();
  const { data: tags } = useTags();
  const { data: preferences } = usePreferences();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const tasksQuery = useTasks(true);
  const updateNote = useUpdateNote();
  const toggleInline = useToggleInlineTask();
  const createTaskCategoryMutation = useCreateTaskCategory();
  const updateTaskCategoryMutation = useUpdateTaskCategory();
  const deleteTaskCategoryMutation = useDeleteTaskCategory();
  const setAssignmentMutation = useSetTaskCategoryAssignment();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const customCategories = useMemo(
    () => preferences?.taskCategories ?? [],
    [preferences?.taskCategories]
  );
  const taskCategoryAssignments = useMemo(
    () => preferences?.taskCategoryAssignments ?? {},
    [preferences?.taskCategoryAssignments]
  );
  const customCategoryById = useMemo(
    () => new Map(customCategories.map((c) => [c.id, c])),
    [customCategories]
  );

  // Fall back to "all" immediately if a selected custom category was deleted (including from another tab)
  const selectedCategory =
    preferences !== undefined &&
    isCustomCategoryKey(rawSelectedCategory) &&
    !customCategoryById.has(customCategoryIdFromKey(rawSelectedCategory))
      ? "all"
      : rawSelectedCategory;

  // Reset progressive render slices synchronously when the active view changes
  const sliceResetKey = `${tab}\0${selectedCategory}\0${filterText}`;
  const [prevSliceResetKey, setPrevSliceResetKey] = useState(sliceResetKey);
  if (sliceResetKey !== prevSliceResetKey) {
    setPrevSliceResetKey(sliceResetKey);
    if (visibleCount !== TASKS_PAGE_SIZE) setVisibleCount(TASKS_PAGE_SIZE);
    if (Object.keys(groupLimits).length > 0) setGroupLimits({});
  }

  const notebookPathById = useMemo(() => buildNotebookPathMap(notebooks), [notebooks]);
  const notebookLineageById = useMemo(() => buildNotebookLineageMap(notebooks), [notebooks]);

  const allTasks = useMemo<UnifiedTask[]>(() => {
    const resolveNotebookCategory = (
      notebookId: string,
      notebookPath: string | undefined,
      notebookTitle: string
    ) => {
      const label =
        notebookPath?.trim() ||
        (notebookId ? notebookPathById.get(notebookId) : undefined) ||
        notebookTitle.trim() ||
        "Uncategorized";
      const key = notebookId || `title:${label.toLowerCase()}`;
      const topCategory = label.split(" / ")[0] || label;
      return { notebookCategoryKey: key, notebookCategoryLabel: label, topCategory };
    };

    const todoList: UnifiedTask[] = (tasksQuery.data?.todoNotes ?? []).map((t) => {
      const notebookId = t.parentId || t.notebookId || "";
      const notebookTitle = t.notebookTitle || "Notebook";
      const nbCat = resolveNotebookCategory(notebookId, t.notebookPath, t.notebookTitle || "");
      const key = `todo-${t.id}`;
      const title = noteDisplayTitle(t);
      const sourceUrl = t.sourceUrl ?? "";
      const tagIds = t.tagIds ?? [];
      const resolved = resolveTaskCustomCategories(
        {
          key,
          kind: "todo",
          title,
          noteTitle: title,
          notebookId,
          notebookCategoryLabel: nbCat.notebookCategoryLabel,
          sourceUrl,
          tagIds,
        },
        customCategories,
        taskCategoryAssignments,
        notebookLineageById
      );
      return {
        kind: "todo",
        key,
        noteId: t.id,
        title,
        noteTitle: title,
        notebookId,
        notebookTitle,
        ...nbCat,
        sourceUrl,
        tagIds,
        manualCategoryId: resolved.manualCategoryId,
        autoMatchedCategoryIds: resolved.autoMatchedCategoryIds,
        effectiveCustomCategoryIds: resolved.effectiveCategoryIds,
        primaryCustomCategory: resolved.primaryCustomCategory,
        groupKey: resolved.primaryCustomCategory
          ? customCategoryKey(resolved.primaryCustomCategory.id)
          : nbCat.notebookCategoryKey,
        groupLabel: resolved.primaryCustomCategory
          ? resolved.primaryCustomCategory.name
          : nbCat.notebookCategoryLabel,
        groupColor: resolved.primaryCustomCategory?.color,
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
      const nbCat = resolveNotebookCategory(notebookId, t.notebookPath, t.notebookTitle || "");
      const key = `inline-${t.noteId}-${t.line}-${t.column}`;
      const noteTitle = t.noteTitle || "Untitled Note";
      const sourceUrl = t.sourceUrl ?? "";
      const tagIds = t.tagIds ?? [];
      const resolved = resolveTaskCustomCategories(
        {
          key,
          kind: "inline",
          title: t.text,
          noteTitle,
          notebookId,
          notebookCategoryLabel: nbCat.notebookCategoryLabel,
          sourceUrl,
          tagIds,
        },
        customCategories,
        taskCategoryAssignments,
        notebookLineageById
      );
      return {
        kind: "inline",
        key,
        noteId: t.noteId,
        title: t.text,
        noteTitle,
        notebookId,
        notebookTitle,
        ...nbCat,
        sourceUrl,
        tagIds,
        manualCategoryId: resolved.manualCategoryId,
        autoMatchedCategoryIds: resolved.autoMatchedCategoryIds,
        effectiveCustomCategoryIds: resolved.effectiveCategoryIds,
        primaryCustomCategory: resolved.primaryCustomCategory,
        groupKey: resolved.primaryCustomCategory
          ? customCategoryKey(resolved.primaryCustomCategory.id)
          : nbCat.notebookCategoryKey,
        groupLabel: resolved.primaryCustomCategory
          ? resolved.primaryCustomCategory.name
          : nbCat.notebookCategoryLabel,
        groupColor: resolved.primaryCustomCategory?.color,
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
  }, [
    tasksQuery.data,
    mountTime,
    notebookPathById,
    customCategories,
    taskCategoryAssignments,
    notebookLineageById,
  ]);

  const {
    customCategoryInfos,
    customCategoryInfoByKey,
    notebookCategories,
    parentGroups,
    notebookCategoryByKey,
    parentGroupByKey,
  } = useMemo(() => {
    const customMap = new Map<string, CustomCategoryInfo>();
    for (const cat of customCategories) {
      const key = customCategoryKey(cat.id);
      customMap.set(key, {
        category: cat,
        key,
        tabCount: 0,
        totalCount: 0,
        hidden: hiddenCategories.has(key),
      });
    }

    const nbMap = new Map<string, NotebookCategoryInfo>();
    for (const item of allTasks) {
      const inTab = matchesTab(item, tab);

      for (const catId of item.effectiveCustomCategoryIds) {
        const info = customMap.get(customCategoryKey(catId));
        if (info) {
          info.totalCount++;
          if (inTab) info.tabCount++;
        }
      }

      let nbInfo = nbMap.get(item.notebookCategoryKey);
      if (!nbInfo) {
        nbInfo = {
          key: item.notebookCategoryKey,
          label: item.notebookCategoryLabel,
          topCategory: item.topCategory,
          tabCount: 0,
          totalCount: 0,
          hidden: hiddenCategories.has(item.notebookCategoryKey),
        };
        nbMap.set(item.notebookCategoryKey, nbInfo);
      }
      nbInfo.totalCount++;
      if (inTab) nbInfo.tabCount++;
    }

    const sortedCustom = [...customMap.values()];
    const sortedNotebooks = [...nbMap.values()].sort(
      (a, b) => b.tabCount - a.tabCount || b.totalCount - a.totalCount || a.label.localeCompare(b.label)
    );

    const byTop = new Map<string, NotebookCategoryInfo[]>();
    for (const cat of sortedNotebooks) {
      const list = byTop.get(cat.topCategory) ?? [];
      list.push(cat);
      byTop.set(cat.topCategory, list);
    }

    const groups: NotebookCategoryGroupInfo[] = [];
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
      customCategoryInfos: sortedCustom,
      customCategoryInfoByKey: customMap,
      notebookCategories: sortedNotebooks,
      parentGroups: groups,
      notebookCategoryByKey: nbMap,
      parentGroupByKey: new Map(groups.map((g) => [g.key, g])),
    };
  }, [allTasks, customCategories, tab, hiddenCategories]);

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
        (sum, item) => sum + (!isTaskHiddenInAll(item, hiddenCategories) && matchesTab(item, tab) ? 1 : 0),
        0
      ),
    [allTasks, hiddenCategories, tab]
  );

  const activeHiddenCategoryCount = useMemo(
    () =>
      customCategoryInfos.reduce((sum, c) => sum + (c.hidden ? 1 : 0), 0) +
      notebookCategories.reduce((sum, c) => sum + (c.hidden ? 1 : 0), 0),
    [customCategoryInfos, notebookCategories]
  );

  const totalCategoryCount = customCategoryInfos.length + notebookCategories.length;

  const filteredTasks = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return categoryScopedTasks.filter((item) => {
      if (!matchesTab(item, tab)) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.noteTitle.toLowerCase().includes(q) ||
        item.notebookTitle.toLowerCase().includes(q) ||
        item.notebookCategoryLabel.toLowerCase().includes(q) ||
        (item.primaryCustomCategory?.name.toLowerCase().includes(q) ?? false) ||
        item.sourceUrl.toLowerCase().includes(q)
      );
    });
  }, [categoryScopedTasks, tab, filterText]);

  const groupedTasks = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        customCategory: TaskCategory | null;
        tasks: UnifiedTask[];
        hasOverdue: boolean;
      }
    >();
    for (const task of filteredTasks) {
      let group = groups.get(task.groupKey);
      if (!group) {
        group = {
          key: task.groupKey,
          label: task.groupLabel,
          customCategory: task.primaryCustomCategory,
          tasks: [],
          hasOverdue: false,
        };
        groups.set(task.groupKey, group);
      }
      group.tasks.push(task);
      if (task.overdue) group.hasOverdue = true;
    }
    return [...groups.values()].sort(
      (a, b) =>
        Number(b.hasOverdue) - Number(a.hasOverdue) ||
        Number(Boolean(b.customCategory)) - Number(Boolean(a.customCategory)) ||
        b.tasks.length - a.tasks.length ||
        a.label.localeCompare(b.label)
    );
  }, [filteredTasks]);

  const quickCategories = useMemo(() => {
    const chips: Array<{
      key: string;
      label: string;
      count: number;
      color?: TaskCategoryColor;
    }> = [];

    for (const info of customCategoryInfos) {
      if (info.hidden) continue;
      chips.push({
        key: info.key,
        label: info.category.name,
        count: info.tabCount,
        color: info.category.color,
      });
      if (chips.length >= QUICK_CATEGORY_LIMIT) break;
    }

    if (chips.length < QUICK_CATEGORY_LIMIT) {
      for (const nb of notebookCategories) {
        if (nb.hidden || nb.tabCount <= 0) continue;
        chips.push({
          key: nb.key,
          label: nb.label,
          count: nb.tabCount,
        });
        if (chips.length >= QUICK_CATEGORY_LIMIT) break;
      }
    }

    if (selectedCategory !== "all" && !chips.some((c) => c.key === selectedCategory)) {
      if (isCustomCategoryKey(selectedCategory)) {
        const c = customCategoryInfoByKey.get(selectedCategory);
        if (c) {
          chips.push({
            key: c.key,
            label: c.category.name,
            count: c.tabCount,
            color: c.category.color,
          });
        }
      } else if (isGroupCategoryKey(selectedCategory)) {
        const g = parentGroupByKey.get(selectedCategory);
        chips.push({
          key: selectedCategory,
          label: g?.label ?? `${groupNameFromKey(selectedCategory)} (all)`,
          count: g?.tabCount ?? 0,
        });
      } else {
        const nb = notebookCategoryByKey.get(selectedCategory);
        chips.push({
          key: selectedCategory,
          label: nb?.label ?? notebookPathById.get(selectedCategory) ?? "Selected category",
          count: nb?.tabCount ?? 0,
        });
      }
    }
    return chips;
  }, [
    customCategoryInfos,
    notebookCategories,
    selectedCategory,
    customCategoryInfoByKey,
    parentGroupByKey,
    notebookCategoryByKey,
    notebookPathById,
  ]);

  const selectedCategoryHiddenKeys = useMemo(() => {
    if (selectedCategory === "all") return [];
    if (isGroupCategoryKey(selectedCategory)) {
      const g = parentGroupByKey.get(selectedCategory);
      return (g?.memberKeys ?? []).filter((k) => hiddenCategories.has(k));
    }
    return hiddenCategories.has(selectedCategory) ? [selectedCategory] : [];
  }, [selectedCategory, parentGroupByKey, hiddenCategories]);

  const filteredPopoverCustom = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return customCategoryInfos;
    return customCategoryInfos.filter((c) => c.category.name.toLowerCase().includes(q));
  }, [customCategoryInfos, categorySearch]);

  const filteredPopoverGroups = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return parentGroups;
    return parentGroups.filter((g) => g.label.toLowerCase().includes(q));
  }, [parentGroups, categorySearch]);

  const filteredPopoverNotebooks = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return notebookCategories;
    return notebookCategories.filter((c) => c.label.toLowerCase().includes(q));
  }, [notebookCategories, categorySearch]);

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

  const toggleHideGroup = (group: NotebookCategoryGroupInfo) => {
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

  const openCreateCategory = (prefill: TaskCategoryPrefill | null = null) => {
    setEditingCategory(null);
    setCategoryPrefill(prefill);
    setCategoryMenuOpen(false);
    setCategoryDialogOpen(true);
  };

  const openEditCategory = (cat: TaskCategory) => {
    setEditingCategory(cat);
    setCategoryPrefill(null);
    setCategoryMenuOpen(false);
    setCategoryDialogOpen(true);
  };

  const handleSaveCategory = async (input: TaskCategoryInput, existingId: string | null) => {
    try {
      if (existingId) {
        const updated = await updateTaskCategoryMutation.mutateAsync({ id: existingId, patch: input });
        toast.success(`Updated category "${updated.name}"`);
      } else {
        const created = await createTaskCategoryMutation.mutateAsync(input);
        toast.success(`Created category "${created.name}"`);
      }
      setCategoryDialogOpen(false);
      setEditingCategory(null);
      setCategoryPrefill(null);
    } catch (err) {
      toast.error(existingId ? "Could not update category" : "Could not create category", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleDeleteCategory = async (id: string) => {
    const existing = customCategoryById.get(id);
    try {
      await deleteTaskCategoryMutation.mutateAsync(id);
      const key = customCategoryKey(id);
      if (rawSelectedCategory === key) {
        selectCategory("all");
      }
      if (hiddenCategories.has(key)) {
        updateHiddenCategories((next) => {
          next.delete(key);
          return next;
        });
      }
      setCategoryDialogOpen(false);
      setEditingCategory(null);
      toast.success(existing ? `Deleted category "${existing.name}"` : "Deleted category");
    } catch (err) {
      toast.error("Could not delete category", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleAssignCategory = async (task: UnifiedTask, categoryId: string | null) => {
    try {
      await setAssignmentMutation.mutateAsync({ taskKey: task.key, categoryId });
    } catch (err) {
      toast.error("Could not assign category", {
        description: err instanceof Error ? err.message : undefined,
      });
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

  const renderTaskCard = (task: UnifiedTask, showPrimaryCategoryBadge: boolean) => {
    const busy = updateNote.isPending || toggleInline.isPending;
    const customCat = task.primaryCustomCategory;
    const customColor = customCat ? getTaskCategoryColorStyle(customCat.color) : null;
    const autoCategoryName =
      task.autoMatchedCategoryIds.length > 0
        ? customCategoryById.get(task.autoMatchedCategoryIds[0])?.name ?? task.notebookCategoryLabel
        : task.notebookCategoryLabel;
    const host = extractSourceHost(task.sourceUrl);
    const showNotebookChip = showPrimaryCategoryBadge || Boolean(customCat);

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

            {showPrimaryCategoryBadge && customCat && customColor && (
              <button
                type="button"
                onClick={() => selectCategory(customCategoryKey(customCat.id))}
                title={`Filter by ${customCat.name}`}
                className={cn(
                  "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-85",
                  customColor.badgeClass
                )}
              >
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", customColor.dotClass)}
                  aria-hidden="true"
                />
                <span className="truncate">{customCat.name}</span>
              </button>
            )}

            {showNotebookChip && (
              <button
                type="button"
                onClick={() => selectCategory(task.notebookCategoryKey)}
                title={`Filter by ${task.notebookCategoryLabel}`}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Folder className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                <span className="truncate">{task.notebookCategoryLabel}</span>
              </button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Assign category for "${task.title}"`}
                  title="Assign category"
                  className="inline-flex h-5 items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <TagIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60 max-w-[calc(100vw-2rem)] text-xs">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  Assign task category
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void handleAssignCategory(task, null)}
                  className="cursor-pointer flex items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <span className="truncate">Auto ({autoCategoryName})</span>
                  </span>
                  {task.manualCategoryId === null && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  )}
                </DropdownMenuItem>

                {customCategories.length > 0 && <DropdownMenuSeparator />}
                {customCategories.map((cat) => {
                  const style = getTaskCategoryColorStyle(cat.color);
                  const assigned = task.manualCategoryId === cat.id;
                  return (
                    <DropdownMenuItem
                      key={cat.id}
                      onClick={() => void handleAssignCategory(task, cat.id)}
                      className="cursor-pointer flex items-center justify-between gap-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn("h-2 w-2 shrink-0 rounded-full", style.dotClass)}
                          aria-hidden="true"
                        />
                        <span className="truncate">{cat.name}</span>
                      </span>
                      {assigned && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
                    </DropdownMenuItem>
                  );
                })}

                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    openCreateCategory({
                      name: task.notebookTitle !== "Notebook" ? task.notebookTitle : "",
                      rules: {
                        ...(task.notebookId ? { notebookIds: [task.notebookId] } : {}),
                        ...(task.notebookCategoryLabel !== "Uncategorized"
                          ? { notebookPathPrefixes: [task.notebookCategoryLabel] }
                          : {}),
                        ...(host ? { sourceUrlPatterns: [host] } : {}),
                      },
                    })
                  }
                  className="cursor-pointer flex items-center gap-1.5 text-primary focus:text-primary"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">New category from "{task.notebookCategoryLabel}"…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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

          {(totalCategoryCount > 0 || !tasksQuery.isLoading) && (
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
                const colorStyle = chip.color ? getTaskCategoryColorStyle(chip.color) : null;
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
                        ? colorStyle?.activeChipClass ?? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border/60 text-muted-foreground"
                    )}
                  >
                    {colorStyle ? (
                      <span
                        className={cn("h-2 w-2 shrink-0 rounded-full", colorStyle.dotClass)}
                        aria-hidden="true"
                      />
                    ) : (
                      <Folder className="size-3! shrink-0 opacity-75" aria-hidden="true" />
                    )}
                    <span className="truncate">{chip.label}</span>{" "}
                    <span className="shrink-0 opacity-75">({chip.count})</span>
                  </Button>
                );
              })}

              {totalCategoryCount > 0 && (
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
                      <span>Categories ({totalCategoryCount})</span>
                      <ChevronDown className="size-3! opacity-70" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-80 max-w-[calc(100vw-2rem)] p-2 space-y-2"
                  >
                    {totalCategoryCount > 6 && (
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
                          </span>{" "}
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

                      {filteredPopoverCustom.length > 0 && (
                        <div className="pt-1 space-y-0.5">
                          <p className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Custom Categories
                          </p>
                          {filteredPopoverCustom.map((info) => {
                            const active = selectedCategory === info.key;
                            const style = getTaskCategoryColorStyle(info.category.color);
                            return (
                              <div key={info.key} className="flex min-w-0 items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    selectCategory(info.key);
                                    setCategoryMenuOpen(false);
                                  }}
                                  className={cn(
                                    "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                                    active && "bg-accent font-medium text-foreground",
                                    info.hidden && "text-muted-foreground"
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
                                    <span
                                      className={cn("h-2 w-2 shrink-0 rounded-full", style.dotClass)}
                                      aria-hidden="true"
                                    />
                                    <span className="truncate">{info.category.name}</span>
                                  </span>{" "}
                                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                    {info.tabCount}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEditCategory(info.category)}
                                  aria-label={`Edit ${info.category.name}`}
                                  title={`Edit ${info.category.name}`}
                                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => toggleHideCategory(info.key, info.category.name)}
                                  aria-label={
                                    info.hidden
                                      ? `Show ${info.category.name} in All`
                                      : `Hide ${info.category.name} from All`
                                  }
                                  title={
                                    info.hidden
                                      ? `Show ${info.category.name} in All`
                                      : `Hide ${info.category.name} from All`
                                  }
                                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                >
                                  {info.hidden ? (
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
                        {filteredPopoverNotebooks.length === 0 ? (
                          <p className="px-2 py-2 text-xs text-muted-foreground">No matching categories</p>
                        ) : (
                          filteredPopoverNotebooks.map((cat) => {
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

                    <div className="border-t border-border pt-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => openCreateCategory(null)}
                        className="w-full h-7 justify-start gap-1.5 px-2 text-xs text-primary hover:text-primary"
                      >
                        <Plus className="size-3.5!" aria-hidden="true" />
                        <span>New category…</span>
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="New task category"
                onClick={() => openCreateCategory(null)}
                className="h-7 gap-1 px-2 text-xs"
              >
                <Plus className="size-3!" aria-hidden="true" />
                <span>New</span>
              </Button>

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
                  const customColor = group.customCategory
                    ? getTaskCategoryColorStyle(group.customCategory.color)
                    : null;

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
                          {customColor ? (
                            <span
                              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", customColor.dotClass)}
                              aria-hidden="true"
                            />
                          ) : (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                          )}
                          <span className="truncate">{group.label}</span>{" "}
                          <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                            {group.tasks.length}
                          </Badge>
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          {group.customCategory && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${group.label}`}
                              title={`Edit ${group.label}`}
                              onClick={() => openEditCategory(group.customCategory!)}
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="size-3.5!" />
                            </Button>
                          )}
                          {selectedCategory === "all" && (
                            <>
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
                                <EyeOff className="size-3.5!" />
                              </Button>
                            </>
                          )}
                        </div>
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

      <TaskCategoryDialog
        open={categoryDialogOpen}
        onOpenChange={(open) => {
          setCategoryDialogOpen(open);
          if (!open) {
            setEditingCategory(null);
            setCategoryPrefill(null);
          }
        }}
        category={editingCategory}
        prefill={categoryPrefill}
        notebooks={notebooks ?? []}
        tags={tags ?? []}
        allTasks={allTasks}
        isSaving={createTaskCategoryMutation.isPending || updateTaskCategoryMutation.isPending}
        isDeleting={deleteTaskCategoryMutation.isPending}
        onSave={handleSaveCategory}
        onDelete={handleDeleteCategory}
      />
    </AppLayout>
  );
}
