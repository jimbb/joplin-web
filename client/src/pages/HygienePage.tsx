import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  CopyCheck,
  ExternalLink,
  FileWarning,
  Loader2,
  Paperclip,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { QueryError } from "@/components/common/QueryError";
import { DuplicateCompareDialog } from "@/components/hygiene/DuplicateCompareDialog";
import { loadTitleDetail } from "@/components/organize/TitleDetailControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes } from "@/hooks/use-notes";
import { useBulkUpdateNotes, useDeleteNote, useRestoreNote } from "@/hooks/use-mutations";
import { useCreateOrganizeJob, useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import {
  HYGIENE_QUERY_KEY,
  useDismissDuplicates,
  useHygieneReport,
  useResolveDuplicates,
  useUndismissDuplicates,
} from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";
import type { DuplicateCluster, DuplicateTier, HygieneNoteItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const CLUSTERS_PER_PAGE = 25;

type TierFilter = "all" | DuplicateTier;

function formatCompactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function attachmentSummary(note: HygieneNoteItem): string | null {
  const atts = note.attachments;
  if (!atts || atts.length === 0) return null;
  const totalBytes = atts.reduce((sum, a) => sum + (a.size || 0), 0);
  const hasOcr = atts.some((a) => a.hasOcr);
  const label = atts.length === 1 ? atts[0].kind.toUpperCase() : `${atts.length} files`;
  const parts = [label];
  if (totalBytes > 0) parts.push(formatCompactBytes(totalBytes));
  if (hasOcr) parts.push("OCR");
  return parts.join(" · ");
}

export function HygienePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [headerSearch, setHeaderSearch] = useState("");
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [page, setPage] = useState(0);
  const [keeperOverrides, setKeeperOverrides] = useState<Record<string, string>>({});
  const [comparingClusterId, setComparingClusterId] = useState<string | null>(null);
  const [bulkIdenticalDialogOpen, setBulkIdenticalDialogOpen] = useState(false);
  const [bulkMergeTags, setBulkMergeTags] = useState(true);
  const [bulkProgress, setBulkProgress] = useState<{ completed: number; total: number } | null>(null);

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const hygieneQuery = useHygieneReport(true);
  const deleteNote = useDeleteNote();
  const restoreNote = useRestoreNote();
  const bulkUpdate = useBulkUpdateNotes();
  const createOrganizeJob = useCreateOrganizeJob();
  const dismissDuplicates = useDismissDuplicates();
  const undismissDuplicates = useUndismissDuplicates();
  const resolveDuplicates = useResolveDuplicates();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const clusters = useMemo(() => hygieneQuery.data?.duplicateClusters ?? [], [hygieneQuery.data?.duplicateClusters]);
  const emptyNotes = hygieneQuery.data?.emptyNotes ?? [];
  const untaggedNotes = hygieneQuery.data?.untaggedNotes ?? [];

  const identicalClusters = useMemo(
    () => clusters.filter((c) => c.tier === "identical"),
    [clusters]
  );
  const nearClusters = useMemo(
    () => clusters.filter((c) => c.tier === "near"),
    [clusters]
  );
  const identicalCopyCount = useMemo(
    () => identicalClusters.reduce((sum, c) => sum + Math.max(0, c.notes.length - 1), 0),
    [identicalClusters]
  );

  const filteredClusters = useMemo(() => {
    if (tierFilter === "identical") return identicalClusters;
    if (tierFilter === "near") return nearClusters;
    return clusters;
  }, [clusters, identicalClusters, nearClusters, tierFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredClusters.length / CLUSTERS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const visibleClusters = useMemo(
    () => filteredClusters.slice(safePage * CLUSTERS_PER_PAGE, (safePage + 1) * CLUSTERS_PER_PAGE),
    [filteredClusters, safePage]
  );

  const comparingCluster = useMemo(
    () => (comparingClusterId ? clusters.find((c) => c.id === comparingClusterId) ?? null : null),
    [clusters, comparingClusterId]
  );

  const keeperIdOf = (cluster: DuplicateCluster): string => {
    const override = keeperOverrides[cluster.id];
    if (override && cluster.notes.some((n) => n.id === override)) return override;
    return cluster.suggestedKeeperId || cluster.notes[0]?.id || "";
  };

  const handleTrashNote = async (noteId: string, title: string) => {
    setBusyNoteId(noteId);
    try {
      await deleteNote.mutateAsync({ id: noteId });
      await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
      toast.success(`Moved "${title}" to trash`, {
        action: {
          label: "Undo",
          onClick: () => {
            void restoreNote.mutateAsync(noteId).then(() => {
              void queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
              toast.success("Note restored");
            });
          },
        },
      });
    } catch (err) {
      toast.error("Could not move note to trash", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusyNoteId(null);
    }
  };

  const handleResolveCluster = async ({
    keepNoteId,
    trashNoteIds,
    mergeTags,
  }: {
    keepNoteId: string;
    trashNoteIds: string[];
    mergeTags: boolean;
  }) => {
    if (trashNoteIds.length === 0) return;
    try {
      const res = await resolveDuplicates.mutateAsync({ keepNoteId, trashNoteIds, mergeTags });
      setComparingClusterId(null);
      const trashedCount = res.trashedNoteIds.length;
      const mergedSummary =
        res.mergedTags.length > 0
          ? ` and merged ${res.mergedTags.length} ${res.mergedTags.length === 1 ? "tag" : "tags"}`
          : "";
      toast.success(
        `Moved ${trashedCount} duplicate ${trashedCount === 1 ? "copy" : "copies"} to trash${mergedSummary}`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void (async () => {
                try {
                  if (res.trashedNoteIds.length > 0) {
                    await bulkUpdate.mutateAsync({
                      items: res.trashedNoteIds.map((id) => ({ id })),
                      restore: true,
                    });
                  }
                  if (res.mergedTags.length > 0) {
                    await bulkUpdate.mutateAsync({
                      items: [{ id: res.keepNoteId, removeTags: res.mergedTags }],
                    });
                  }
                  await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
                  toast.success("Restored trashed copies");
                } catch (undoErr) {
                  toast.error("Could not undo duplicate resolution", {
                    description: undoErr instanceof Error ? undoErr.message : undefined,
                  });
                }
              })();
            },
          },
        }
      );
    } catch (err) {
      toast.error("Could not resolve duplicate cluster", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleDismiss = async (payload: { noteIds?: string[]; pairs?: Array<[string, string]> }, label = "Marked as not duplicates") => {
    try {
      await dismissDuplicates.mutateAsync(payload);
      toast.success(label, {
        action: {
          label: "Undo",
          onClick: () => {
            void undismissDuplicates.mutateAsync(payload).then(() => {
              toast.success("Dismissal undone");
            });
          },
        },
      });
    } catch (err) {
      toast.error("Could not dismiss duplicate", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleTrashAllIdentical = async () => {
    if (identicalClusters.length === 0) return;

    const trashIds: string[] = [];
    const tagMergeItems: Array<{ id: string; addTags: string[] }> = [];

    for (const cluster of identicalClusters) {
      const keepId = keeperIdOf(cluster);
      const keeper = cluster.notes.find((n) => n.id === keepId);
      const copies = cluster.notes.filter((n) => n.id !== keepId);
      for (const c of copies) trashIds.push(c.id);

      if (bulkMergeTags && keeper) {
        const keeperTags = new Set((keeper.tags ?? []).map((t) => t.title.toLowerCase()));
        const extras: string[] = [];
        for (const c of copies) {
          for (const t of c.tags ?? []) {
            const lower = t.title.toLowerCase();
            if (!keeperTags.has(lower)) {
              keeperTags.add(lower);
              extras.push(t.title);
            }
          }
        }
        if (extras.length > 0) {
          tagMergeItems.push({ id: keeper.id, addTags: extras });
        }
      }
    }

    if (trashIds.length === 0) return;

    try {
      setBulkProgress({ completed: 0, total: trashIds.length });

      const addedTagsByKeeper: Array<{ id: string; removeTags: string[] }> = [];
      if (tagMergeItems.length > 0) {
        const mergeRes = await bulkUpdate.mutateAsync({ items: tagMergeItems });
        for (const r of mergeRes) {
          if (r.status === "ok" && r.addedTags && r.addedTags.length > 0) {
            addedTagsByKeeper.push({ id: r.id, removeTags: r.addedTags });
          }
        }
      }

      const trashRes = await bulkUpdate.mutateAsync({
        items: trashIds.map((id) => ({ id })),
        trash: true,
        onProgress: (p) => setBulkProgress(p),
      });
      const trashedIds = trashRes.filter((r) => r.status === "ok").map((r) => r.id);
      setBulkIdenticalDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });

      toast.success(
        `Moved ${trashedIds.length} identical ${trashedIds.length === 1 ? "copy" : "copies"} to trash`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void (async () => {
                try {
                  if (trashedIds.length > 0) {
                    await bulkUpdate.mutateAsync({
                      items: trashedIds.map((id) => ({ id })),
                      restore: true,
                    });
                  }
                  if (addedTagsByKeeper.length > 0) {
                    await bulkUpdate.mutateAsync({ items: addedTagsByKeeper });
                  }
                  await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
                  toast.success(`Restored ${trashedIds.length} notes`);
                } catch (undoErr) {
                  toast.error("Could not undo bulk trash", {
                    description: undoErr instanceof Error ? undoErr.message : undefined,
                  });
                }
              })();
            },
          },
        }
      );
    } catch (err) {
      toast.error("Could not trash identical copies", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleTrashAllEmpty = async () => {
    const empty = hygieneQuery.data?.emptyNotes ?? [];
    if (empty.length === 0) return;
    try {
      await bulkUpdate.mutateAsync({
        items: empty.map((n) => ({ id: n.id })),
        trash: true,
      });
      await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
      toast.success(`Moved ${empty.length} empty ${empty.length === 1 ? "note" : "notes"} to trash`);
    } catch (err) {
      toast.error("Could not trash empty notes", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleOrganizeUntagged = async () => {
    const untagged = hygieneQuery.data?.untaggedNotes ?? [];
    if (untagged.length === 0) return;
    try {
      const { jobId } = await createOrganizeJob.mutateAsync({
        noteIds: untagged.map((n) => n.id),
        titleDetail: loadTitleDetail(),
      });
      navigate(`/organize/${jobId}`);
    } catch (err) {
      toast.error("Could not start Auto-organize", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <AppLayout
      notebookTitle="Hygiene & Duplicates"
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
          activeView="hygiene"
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
      <div className="h-full overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <ScanSearch className="h-5 w-5 text-primary" aria-hidden="true" />
              Workspace Hygiene &amp; Duplicates
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Duplicates matched by note content, attachment files, and OCR text. Compare side by side before trashing copies.
            </p>
          </div>

          {hygieneQuery.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : hygieneQuery.error ? (
            <QueryError
              message="Couldn't compute hygiene report"
              error={hygieneQuery.error}
              onRetry={() => void hygieneQuery.refetch()}
              isRetrying={hygieneQuery.isFetching}
            />
          ) : (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground">Duplicate clusters</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono text-foreground">{clusters.length}</span>
                    {clusters.length > 0 && (
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {identicalClusters.length} identical · {nearClusters.length} near
                      </span>
                    )}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground">Empty notes</div>
                  <div className="mt-1 text-2xl font-bold font-mono text-foreground">{emptyNotes.length}</div>
                </div>
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground">Untagged notes</div>
                  <div className="mt-1 text-2xl font-bold font-mono text-foreground">{untaggedNotes.length}</div>
                </div>
              </div>

              {/* Duplicate Clusters */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CopyCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                    Possible Duplicates ({clusters.length})
                  </h2>

                  <div className="flex flex-wrap items-center gap-2">
                    {clusters.length > 0 && (
                      <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
                        {(
                          [
                            { id: "all", label: `All (${clusters.length})` },
                            { id: "identical", label: `Identical (${identicalClusters.length})` },
                            { id: "near", label: `Near (${nearClusters.length})` },
                          ] as const
                        ).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => {
                              setTierFilter(tab.id);
                              setPage(0);
                            }}
                            className={cn(
                              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                              tierFilter === tab.id
                                ? "bg-background text-foreground shadow-xs"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {!readOnly && identicalCopyCount > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={bulkUpdate.isPending}
                        onClick={() => setBulkIdenticalDialogOpen(true)}
                        className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                        Trash all identical copies ({identicalCopyCount})
                      </Button>
                    )}
                  </div>
                </div>

                {filteredClusters.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card/30 px-4 py-6 text-xs text-muted-foreground text-center">
                    {clusters.length === 0
                      ? "No duplicate note clusters detected."
                      : `No ${tierFilter} duplicate clusters.`}
                  </p>
                ) : (
                  <div className="space-y-4">
                    {visibleClusters.map((cluster) => {
                      const activeKeeperId = keeperIdOf(cluster);
                      return (
                        <article
                          key={cluster.id}
                          className="rounded-xl border border-border bg-card/50 p-4 space-y-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <Badge
                                variant={cluster.tier === "identical" ? "default" : "outline"}
                                className={cn(
                                  "text-[11px]",
                                  cluster.tier === "identical"
                                    ? "bg-emerald-600 text-white hover:bg-emerald-600"
                                    : "border-amber-500/50 text-amber-700 dark:text-amber-300"
                                )}
                              >
                                {cluster.tier === "identical" ? "Identical" : "Near match"}
                              </Badge>
                              <span className="text-xs font-mono text-muted-foreground">
                                {Math.round(cluster.score * 100)}% · {cluster.notes.length} notes
                              </span>
                              <span className="text-xs text-foreground/80">
                                {cluster.evidence}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button
                                type="button"
                                variant="default"
                                size="sm"
                                onClick={() => setComparingClusterId(cluster.id)}
                                className="h-7 text-xs gap-1"
                              >
                                <Columns2 className="h-3 w-3" aria-hidden="true" />
                                Compare
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={dismissDuplicates.isPending}
                                onClick={() =>
                                  void handleDismiss(
                                    { noteIds: cluster.notes.map((n) => n.id) },
                                    "Dismissed cluster as not duplicates"
                                  )
                                }
                                className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
                              >
                                <XCircle className="h-3 w-3" aria-hidden="true" />
                                Not duplicates
                              </Button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {cluster.notes.map((n) => {
                              const isKeeper = n.id === activeKeeperId;
                              const isSuggested = n.id === cluster.suggestedKeeperId;
                              const attInfo = attachmentSummary(n);
                              const otherIds = cluster.notes.filter((x) => x.id !== n.id).map((x) => x.id);
                              return (
                                <div
                                  key={n.id}
                                  className={cn(
                                    "rounded-lg border bg-background p-3 flex flex-col justify-between gap-2 min-w-0",
                                    isKeeper ? "border-primary/50 ring-1 ring-primary/15" : "border-border"
                                  )}
                                >
                                  <div className="space-y-1.5 min-w-0">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-sm text-foreground truncate">
                                            {noteDisplayTitle(n)}
                                          </span>
                                          {isKeeper && (
                                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 shrink-0">
                                              <ShieldCheck className="h-2.5 w-2.5 text-primary" aria-hidden="true" />
                                              {isSuggested ? "Suggested keeper" : "Keeper"}
                                            </Badge>
                                          )}
                                        </div>
                                      </div>
                                      <span className="shrink-0 text-[11px] font-mono text-muted-foreground">
                                        {formatRelativeTime(n.updatedTime)}
                                      </span>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-muted-foreground">
                                      <span className="truncate">{n.notebookPath || n.notebookTitle || "Unfiled"}</span>
                                      {attInfo && (
                                        <span className="inline-flex items-center gap-1 text-foreground/80">
                                          <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
                                          {attInfo}
                                        </span>
                                      )}
                                      {!attInfo && typeof n.previewLength === "number" && (
                                        <span>· {n.previewLength} chars</span>
                                      )}
                                    </div>

                                    {n.tags && n.tags.length > 0 && (
                                      <div className="flex flex-wrap items-center gap-1">
                                        {n.tags.map((t) => (
                                          <Badge key={t.id} variant="outline" className="text-[10px] px-1.5 py-0">
                                            {t.title}
                                          </Badge>
                                        ))}
                                      </div>
                                    )}

                                    <p className="text-xs text-muted-foreground line-clamp-3">
                                      {n.preview || (attInfo ? `(Attachment: ${attInfo})` : "(Empty preview)")}
                                    </p>
                                  </div>

                                  <div className="flex flex-wrap items-center justify-between gap-1.5 pt-2 border-t border-border/50">
                                    <div className="flex items-center gap-1">
                                      {!isKeeper && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          onClick={() =>
                                            setKeeperOverrides((prev) => ({ ...prev, [cluster.id]: n.id }))
                                          }
                                          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                        >
                                          Set keeper
                                        </Button>
                                      )}
                                    </div>

                                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                                      <Button asChild type="button" variant="outline" size="sm" className="h-7 text-xs gap-1">
                                        <Link to={`/notes/${n.id}`}>
                                          <ExternalLink className="h-3 w-3" aria-hidden="true" /> Open
                                        </Link>
                                      </Button>
                                      {!readOnly && (
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          disabled={resolveDuplicates.isPending}
                                          onClick={() =>
                                            void handleResolveCluster({
                                              keepNoteId: n.id,
                                              trashNoteIds: otherIds,
                                              mergeTags: true,
                                            })
                                          }
                                          className="h-7 text-xs gap-1"
                                        >
                                          <ShieldCheck className="h-3 w-3 text-primary" aria-hidden="true" />
                                          Keep this
                                        </Button>
                                      )}
                                      {!readOnly && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          disabled={busyNoteId === n.id}
                                          onClick={() => void handleTrashNote(n.id, noteDisplayTitle(n))}
                                          className="h-7 text-xs text-destructive hover:text-destructive gap-1"
                                        >
                                          {busyNoteId === n.id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                          ) : (
                                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                                          )}
                                          Move to trash
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}

                    {/* Pagination controls when there are more than CLUSTERS_PER_PAGE clusters */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between gap-2 pt-2">
                        <span className="text-xs font-mono text-muted-foreground">
                          Showing {safePage * CLUSTERS_PER_PAGE + 1}–
                          {Math.min((safePage + 1) * CLUSTERS_PER_PAGE, filteredClusters.length)} of{" "}
                          {filteredClusters.length} clusters
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={safePage === 0}
                            onClick={() => setPage((p) => Math.max(0, p - 1))}
                            className="h-7 text-xs gap-1"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                            Previous
                          </Button>
                          <span className="text-xs font-mono text-muted-foreground px-1">
                            {safePage + 1} / {totalPages}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={safePage >= totalPages - 1}
                            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                            className="h-7 text-xs gap-1"
                          >
                            Next
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Empty Notes */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileWarning className="h-4 w-4 text-primary" aria-hidden="true" />
                    Empty Notes ({emptyNotes.length})
                  </h2>
                  {!readOnly && emptyNotes.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={bulkUpdate.isPending}
                      onClick={() => void handleTrashAllEmpty()}
                      className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      Trash all empty ({emptyNotes.length})
                    </Button>
                  )}
                </div>

                {emptyNotes.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card/30 px-4 py-6 text-xs text-muted-foreground text-center">
                    No empty notes found.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-xl border border-border bg-card/50">
                    {emptyNotes.map((n) => (
                      <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <Link
                            to={`/notes/${n.id}`}
                            className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate block"
                          >
                            {noteDisplayTitle(n)}
                          </Link>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {n.notebookTitle} · Updated {formatRelativeTime(n.updatedTime)}
                          </div>
                        </div>
                        {!readOnly && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busyNoteId === n.id}
                            onClick={() => void handleTrashNote(n.id, noteDisplayTitle(n))}
                            aria-label={`Move ${noteDisplayTitle(n)} to trash`}
                            className="h-7 text-xs text-destructive hover:text-destructive gap-1 shrink-0"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Trash
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Untagged Notes */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Tag className="h-4 w-4 text-primary" aria-hidden="true" />
                    Untagged Notes ({untaggedNotes.length})
                  </h2>
                  {!readOnly && organizeStatus?.enabled && untaggedNotes.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={createOrganizeJob.isPending}
                      onClick={() => void handleOrganizeUntagged()}
                      className="h-7 text-xs gap-1"
                    >
                      {createOrganizeJob.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                      )}
                      Auto-organize untagged
                    </Button>
                  )}
                </div>

                {untaggedNotes.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card/30 px-4 py-6 text-xs text-muted-foreground text-center">
                    Every note has at least one tag.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-xl border border-border bg-card/50">
                    {untaggedNotes.slice(0, 50).map((n) => (
                      <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <Link
                            to={`/notes/${n.id}`}
                            className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate block"
                          >
                            {noteDisplayTitle(n)}
                          </Link>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {n.notebookTitle} · Updated {formatRelativeTime(n.updatedTime)}
                          </div>
                        </div>
                        <Button asChild type="button" variant="outline" size="sm" className="h-7 text-xs shrink-0">
                          <Link to={`/notes/${n.id}`}>Review</Link>
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {/* Side-by-side comparison modal */}
      <DuplicateCompareDialog
        cluster={comparingCluster}
        initialKeeperId={comparingCluster ? keeperIdOf(comparingCluster) : undefined}
        open={Boolean(comparingCluster)}
        readOnly={readOnly}
        isResolving={resolveDuplicates.isPending}
        isDismissing={dismissDuplicates.isPending}
        onOpenChange={(open) => {
          if (!open) setComparingClusterId(null);
        }}
        onKeeperChange={(clusterId, nextKeeperId) =>
          setKeeperOverrides((prev) => ({ ...prev, [clusterId]: nextKeeperId }))
        }
        onResolve={handleResolveCluster}
        onDismissPair={async (leftId, rightId) => {
          await handleDismiss({ pairs: [[leftId, rightId]] }, "Marked pair as not duplicates");
          if (comparingCluster && comparingCluster.notes.length <= 2) {
            setComparingClusterId(null);
          }
        }}
      />

      {/* Bulk identical copies confirmation dialog */}
      <Dialog open={bulkIdenticalDialogOpen} onOpenChange={setBulkIdenticalDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Trash all identical copies?</DialogTitle>
            <DialogDescription>
              This will move{" "}
              <strong className="text-foreground">
                {identicalCopyCount} identical {identicalCopyCount === 1 ? "copy" : "copies"}
              </strong>{" "}
              across{" "}
              <strong className="text-foreground">
                {identicalClusters.length} {identicalClusters.length === 1 ? "cluster" : "clusters"}
              </strong>{" "}
              to Trash, keeping each cluster&apos;s selected keeper. Near matches are never touched.
            </DialogDescription>
          </DialogHeader>

          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={bulkMergeTags}
              onChange={(e) => setBulkMergeTags(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Merge tags from trashed copies into each keeper</span>
          </label>

          {bulkProgress && (
            <div className="text-xs font-mono text-muted-foreground">
              Trashing {bulkProgress.completed} / {bulkProgress.total}...
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkUpdate.isPending}
              onClick={() => setBulkIdenticalDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={bulkUpdate.isPending}
              onClick={() => void handleTrashAllIdentical()}
              className="gap-1.5"
            >
              {bulkUpdate.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Trash {identicalCopyCount} identical {identicalCopyCount === 1 ? "copy" : "copies"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
