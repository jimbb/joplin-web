import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight,
  Calendar,
  Check,
  ExternalLink,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  ScanText,
  ShieldCheck,
  Tag,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { ResourceImage } from "@/components/common/ResourceImage";
import { useNote } from "@/hooks/use-notes";
import { useNoteAttachments } from "@/hooks/use-workspace";
import { getResourceUrl } from "@/lib/api";
import { noteDisplayTitle } from "@/lib/format";
import { getCachedPdfThumbnail, getPdfThumbnail } from "@/lib/pdf-thumbnail";
import { buildComparableText, diffWords } from "@/lib/word-diff";
import type { DuplicateCluster, HygieneNoteItem, Note, NoteAttachment } from "@/lib/types";
import { cn } from "@/lib/utils";

interface DuplicateCompareDialogProps {
  cluster: DuplicateCluster | null;
  initialKeeperId?: string;
  open: boolean;
  readOnly: boolean;
  isResolving: boolean;
  isDismissing: boolean;
  onOpenChange: (open: boolean) => void;
  onKeeperChange?: (clusterId: string, keeperId: string) => void;
  onResolve: (payload: { keepNoteId: string; trashNoteIds: string[]; mergeTags: boolean }) => Promise<void>;
  onDismissPair: (leftId: string, rightId: string) => Promise<void>;
}

function formatBytes(bytes: number): string {
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

function formatDateTime(ts?: number): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return "Unknown";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PdfThumbPreview({ resourceId, name }: { resourceId: string; name: string }) {
  const [thumb, setThumb] = useState<{ id: string; url: string | null } | null>(null);
  const resolvedUrl =
    thumb?.id === resourceId ? thumb.url : (getCachedPdfThumbnail(resourceId)?.url ?? undefined);

  useEffect(() => {
    if (getCachedPdfThumbnail(resourceId)) return;
    let cancelled = false;
    getPdfThumbnail(resourceId)
      .then((res) => !cancelled && setThumb({ id: resourceId, url: res.url }))
      .catch(() => !cancelled && setThumb({ id: resourceId, url: null }));
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  if (!resolvedUrl) return null;
  return (
    <img
      src={resolvedUrl}
      alt={`Preview of ${name}`}
      loading="lazy"
      className="h-14 w-11 shrink-0 rounded border border-border/60 bg-white object-cover object-top"
    />
  );
}

function AttachmentKindIcon({ kind }: { kind: NoteAttachment["kind"] }) {
  switch (kind) {
    case "image":
      return <ImageIcon className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />;
    case "pdf":
      return <FileText className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />;
    case "audio":
      return <FileAudio className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />;
    case "video":
      return <FileVideo className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />;
    default:
      return <Paperclip className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />;
  }
}

interface ComparePaneProps {
  role: "keeper" | "copy";
  isSuggested: boolean;
  summary: HygieneNoteItem;
  detail?: Note;
  detailLoading: boolean;
  attachments?: NoteAttachment[];
  attachmentsLoading: boolean;
  extraTagsToMerge?: Set<string>;
  onPromoteToKeeper?: () => void;
}

function ComparePane({
  role,
  isSuggested,
  summary,
  detail,
  detailLoading,
  attachments,
  attachmentsLoading,
  extraTagsToMerge,
  onPromoteToKeeper,
}: ComparePaneProps) {
  const title = noteDisplayTitle(detail ?? summary);
  const notebookPath =
    detail?.notebookPath && detail.notebookPath.length > 0
      ? detail.notebookPath.map((b) => b.title).join(" / ")
      : summary.notebookPath || detail?.notebookTitle || summary.notebookTitle || "Unfiled";
  const createdTime = detail?.createdTime ?? summary.createdTime;
  const updatedTime = detail?.updatedTime ?? summary.updatedTime;
  const tags = detail?.tags ?? summary.tags ?? [];
  const isKeeper = role === "keeper";

  return (
    <div
      data-testid={isKeeper ? "compare-pane-left" : "compare-pane-right"}
      className={cn(
        "flex flex-col rounded-xl border bg-background overflow-hidden min-w-0",
        isKeeper ? "border-primary/60 ring-1 ring-primary/20" : "border-border"
      )}
    >
      {/* Pane header */}
      <div className={cn("px-3.5 py-2.5 border-b border-border space-y-2", isKeeper ? "bg-primary/5" : "bg-muted/30")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Badge variant={isKeeper ? "default" : "outline"} className="text-[11px] shrink-0 gap-1">
              {isKeeper && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
              {isKeeper ? "Keep (Left)" : "Copy (Right)"}
            </Badge>
            {isSuggested && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                Suggested keeper
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!isKeeper && onPromoteToKeeper && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onPromoteToKeeper}
                className="h-7 px-2 text-xs gap-1"
              >
                <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                Keep this instead
              </Button>
            )}
            <Button asChild type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1">
              <Link to={`/notes/${summary.id}`}>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                Open
              </Link>
            </Button>
          </div>
        </div>

        <h3 className="text-sm font-semibold text-foreground break-words">{title}</h3>

        <div className="space-y-1 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5 min-w-0">
            <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="font-mono truncate" title={notebookPath}>
              {notebookPath}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3 w-3 shrink-0" aria-hidden="true" />
              Created {formatDateTime(createdTime)}
            </span>
            <span>Updated {formatDateTime(updatedTime)}</span>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <Tag className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />
          {tags.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">No tags</span>
          ) : (
            tags.map((tag) => {
              const willMerge = extraTagsToMerge?.has(tag.title.toLowerCase());
              return (
                <Badge
                  key={tag.id}
                  variant={willMerge ? "default" : "secondary"}
                  className={cn(
                    "text-[10px] px-1.5 py-0",
                    willMerge && "bg-emerald-600 text-white hover:bg-emerald-600"
                  )}
                  title={willMerge ? "Will be merged into the keeper" : undefined}
                >
                  {tag.title}
                  {willMerge ? " +" : ""}
                </Badge>
              );
            })
          )}
        </div>
      </div>

      {/* Attachments */}
      {(attachmentsLoading || (attachments && attachments.length > 0)) && (
        <div className="px-3.5 py-2.5 border-b border-border bg-card/40 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Paperclip className="h-3 w-3" aria-hidden="true" />
            Attachments {attachments ? `(${attachments.length})` : ""}
          </div>
          {attachmentsLoading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading attachments...
            </div>
          ) : (
            <div className="space-y-2">
              {(attachments ?? []).map((att) => {
                const name = att.filename || att.title || att.id;
                return (
                  <div
                    key={att.id}
                    className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background p-2"
                  >
                    {att.kind === "image" ? (
                      <ResourceImage
                        resourceId={att.id}
                        alt={name}
                        className="h-12 w-12 shrink-0 rounded object-cover border border-border/50"
                      />
                    ) : att.kind === "pdf" ? (
                      <PdfThumbPreview resourceId={att.id} name={name} />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <AttachmentKindIcon kind={att.kind} />
                        <span className="text-xs font-medium text-foreground truncate" title={name}>
                          {name}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5 text-[11px] font-mono text-muted-foreground">
                        <span>{att.mime || att.kind}</span>
                        {att.size > 0 && <span>· {formatBytes(att.size)}</span>}
                        {att.ocrText && (
                          <Badge variant="secondary" className="text-[10px] px-1 py-0 gap-0.5 font-sans">
                            <ScanText className="h-2.5 w-2.5" aria-hidden="true" />
                            OCR
                          </Badge>
                        )}
                      </div>
                    </div>
                    {att.kind === "pdf" && (
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs shrink-0">
                        <a href={`${getResourceUrl(att.id)}?view=pdf`} target="_blank" rel="noopener noreferrer">
                          View
                        </a>
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Rendered body */}
      <div className="p-3.5 flex-1 max-h-44 overflow-y-auto text-sm">
        {detailLoading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground justify-center">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading note content...
          </div>
        ) : detail?.body?.trim() ? (
          <MarkdownRenderer
            content={detail.body}
            html={detail.markupLanguage === 2}
            className="text-xs sm:text-sm"
          />
        ) : (
          <p className="text-xs italic text-muted-foreground">(No body text)</p>
        )}
      </div>
    </div>
  );
}

/**
 * Side-by-side comparison modal for a duplicate cluster:
 * - Full-screen with stacked panes on phones, two-column grid on desktop
 * - Keeper pinned on the left; 3+ note clusters let the user choose which two to compare
 * - Shows metadata, tags, attachments + lightweight previews, rendered body, and word-level body+OCR diff
 */
export function DuplicateCompareDialog({
  cluster,
  initialKeeperId,
  open,
  readOnly,
  isResolving,
  isDismissing,
  onOpenChange,
  onKeeperChange,
  onResolve,
  onDismissPair,
}: DuplicateCompareDialogProps) {
  const [keeperId, setKeeperId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");
  const [mergeTags, setMergeTags] = useState<boolean>(true);

  const notes = useMemo(() => cluster?.notes ?? [], [cluster]);
  const suggestedKeeperId = cluster?.suggestedKeeperId;

  const resolvedKeeperId = useMemo(() => {
    if (notes.length === 0) return "";
    if (keeperId && notes.some((n) => n.id === keeperId)) return keeperId;
    if (initialKeeperId && notes.some((n) => n.id === initialKeeperId)) return initialKeeperId;
    if (suggestedKeeperId && notes.some((n) => n.id === suggestedKeeperId)) {
      return suggestedKeeperId;
    }
    return notes[0].id;
  }, [notes, keeperId, initialKeeperId, suggestedKeeperId]);

  const otherNotes = useMemo(
    () => notes.filter((n) => n.id !== resolvedKeeperId),
    [notes, resolvedKeeperId]
  );

  const resolvedRightId = useMemo(() => {
    if (otherNotes.length === 0) return "";
    if (rightId && otherNotes.some((n) => n.id === rightId)) return rightId;
    return otherNotes[0].id;
  }, [otherNotes, rightId]);

  const leftSummary = notes.find((n) => n.id === resolvedKeeperId);
  const rightSummary = notes.find((n) => n.id === resolvedRightId);

  const leftNoteQuery = useNote(open ? resolvedKeeperId : null);
  const rightNoteQuery = useNote(open ? resolvedRightId : null);
  const leftAttQuery = useNoteAttachments(resolvedKeeperId, open && Boolean(resolvedKeeperId));
  const rightAttQuery = useNoteAttachments(resolvedRightId, open && Boolean(resolvedRightId));

  const leftComparable = useMemo(
    () => buildComparableText(leftNoteQuery.data?.body, leftAttQuery.data),
    [leftNoteQuery.data?.body, leftAttQuery.data]
  );
  const rightComparable = useMemo(
    () => buildComparableText(rightNoteQuery.data?.body, rightAttQuery.data),
    [rightNoteQuery.data?.body, rightAttQuery.data]
  );

  const wordDiff = useMemo(
    () => diffWords(leftComparable, rightComparable),
    [leftComparable, rightComparable]
  );

  // Tags present on any non-keeper note in the cluster that are not yet on the keeper
  const extraTagsToMerge = useMemo(() => {
    const keeperTags = new Set(
      (leftNoteQuery.data?.tags ?? leftSummary?.tags ?? []).map((t) => t.title.toLowerCase())
    );
    const extras = new Set<string>();
    for (const n of otherNotes) {
      const sourceTags = n.id === resolvedRightId && rightNoteQuery.data ? rightNoteQuery.data.tags : (n.tags ?? []);
      for (const t of sourceTags) {
        const lower = t.title.toLowerCase();
        if (!keeperTags.has(lower)) extras.add(lower);
      }
    }
    return extras;
  }, [leftNoteQuery.data?.tags, leftSummary?.tags, otherNotes, resolvedRightId, rightNoteQuery.data]);

  const handleSelectKeeper = (nextKeeperId: string) => {
    setKeeperId(nextKeeperId);
    if (cluster) onKeeperChange?.(cluster.id, nextKeeperId);
    if (nextKeeperId === resolvedRightId) {
      setRightId(resolvedKeeperId);
    }
  };

  if (!cluster || !leftSummary || !rightSummary) return null;

  const isDiffLoading =
    leftNoteQuery.isLoading || rightNoteQuery.isLoading || leftAttQuery.isLoading || rightAttQuery.isLoading;
  const trashCount = otherNotes.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="Compare duplicate notes"
        className="left-0 top-0 translate-x-0 translate-y-0 w-screen h-[100dvh] max-w-none rounded-none border-0 p-0 flex flex-col gap-0 sm:left-[50%] sm:top-[50%] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:h-[90vh] sm:w-[95vw] sm:max-w-6xl sm:rounded-xl sm:border"
      >
        {/* Sticky top header */}
        <DialogHeader className="px-4 py-3 sm:px-6 sm:py-4 border-b border-border shrink-0 pr-12 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
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
            <DialogTitle className="text-sm sm:text-base font-semibold">
              Compare Duplicates ({notes.length} notes)
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            {cluster.evidence}
          </DialogDescription>

          {/* Picker bar for 3+ note clusters */}
          {notes.length > 2 && (
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
              <label className="flex items-center gap-1.5 min-w-0">
                <span className="text-muted-foreground shrink-0 font-medium">Keeper (Left):</span>
                <select
                  aria-label="Choose keeper note"
                  value={resolvedKeeperId}
                  onChange={(e) => handleSelectKeeper(e.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground max-w-[220px] truncate"
                >
                  {notes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {noteDisplayTitle(n)} ({n.notebookTitle || "Unfiled"})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 min-w-0">
                <span className="text-muted-foreground shrink-0 font-medium">Compare with (Right):</span>
                <select
                  aria-label="Choose note to compare against"
                  value={resolvedRightId}
                  onChange={(e) => setRightId(e.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground max-w-[220px] truncate"
                >
                  {otherNotes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {noteDisplayTitle(n)} ({n.notebookTitle || "Unfiled"})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </DialogHeader>

        {/* Scrollable body: side-by-side panes + word-level diff */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ComparePane
              role="keeper"
              isSuggested={resolvedKeeperId === cluster.suggestedKeeperId}
              summary={leftSummary}
              detail={leftNoteQuery.data}
              detailLoading={leftNoteQuery.isLoading}
              attachments={leftAttQuery.data}
              attachmentsLoading={leftAttQuery.isLoading}
            />
            <ComparePane
              role="copy"
              isSuggested={resolvedRightId === cluster.suggestedKeeperId}
              summary={rightSummary}
              detail={rightNoteQuery.data}
              detailLoading={rightNoteQuery.isLoading}
              attachments={rightAttQuery.data}
              attachmentsLoading={rightAttQuery.isLoading}
              extraTagsToMerge={mergeTags ? extraTagsToMerge : undefined}
              onPromoteToKeeper={() => handleSelectKeeper(resolvedRightId)}
            />
          </div>

          {/* Word-level diff of Body + OCR */}
          <section
            aria-label="Text and OCR diff"
            className="rounded-xl border border-border bg-card/40 overflow-hidden"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 border-b border-border bg-muted/30">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <ScanText className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Body &amp; OCR Word Diff
              </div>
              {isDiffLoading ? (
                <span className="text-[11px] text-muted-foreground">Computing diff...</span>
              ) : wordDiff.identical ? (
                <Badge variant="secondary" className="text-[11px] gap-1">
                  <Check className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                  Identical text
                </Badge>
              ) : (
                <div className="flex items-center gap-2 text-[11px] font-mono">
                  <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">
                    -{wordDiff.removedWords} left only
                  </span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                    +{wordDiff.addedWords} right only
                  </span>
                </div>
              )}
            </div>
            <div className="p-3.5 max-h-60 overflow-y-auto">
              {isDiffLoading ? (
                <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading text and OCR...
                </div>
              ) : wordDiff.segments.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                  No extracted text or OCR content to diff (matched by attachment signature).
                </p>
              ) : (
                <div
                  data-testid="compare-word-diff"
                  className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-foreground/90"
                >
                  {wordDiff.segments.map((seg, idx) => {
                    if (seg.kind === "equal") {
                      return <span key={idx}>{seg.text}</span>;
                    }
                    if (seg.kind === "removed") {
                      return (
                        <del
                          key={idx}
                          className="rounded-sm bg-destructive/15 px-0.5 text-destructive line-through decoration-destructive/70"
                        >
                          {seg.text}
                        </del>
                      );
                    }
                    return (
                      <ins
                        key={idx}
                        className="rounded-sm bg-emerald-500/15 px-0.5 text-emerald-800 dark:text-emerald-300 no-underline font-semibold"
                      >
                        {seg.text}
                      </ins>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Sticky bottom actions */}
        <div className="px-4 py-3 sm:px-6 border-t border-border bg-card/60 shrink-0 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {!readOnly ? (
            <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={mergeTags}
                onChange={(e) => setMergeTags(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span>
                Merge tags from trashed {trashCount === 1 ? "copy" : "copies"} into keeper
                {extraTagsToMerge.size > 0 && (
                  <span className="ml-1 text-emerald-700 dark:text-emerald-400 font-medium">
                    (+{extraTagsToMerge.size} {extraTagsToMerge.size === 1 ? "tag" : "tags"})
                  </span>
                )}
              </span>
            </label>
          ) : (
            <span className="text-xs text-muted-foreground">Account is read-only</span>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isDismissing || isResolving}
              onClick={() => void onDismissPair(resolvedKeeperId, resolvedRightId)}
              className="h-8 text-xs gap-1.5"
            >
              {isDismissing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Not duplicates
            </Button>

            {!readOnly && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isResolving || isDismissing}
                onClick={() =>
                  void onResolve({
                    keepNoteId: resolvedKeeperId,
                    trashNoteIds: otherNotes.map((n) => n.id),
                    mergeTags,
                  })
                }
                className="h-8 text-xs gap-1.5"
              >
                {isResolving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {trashCount === 1 ? "Keep left, trash other" : `Keep left, trash ${trashCount} others`}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
