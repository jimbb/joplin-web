import { useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NotebookCheckTree } from "@/components/notebooks/NotebookCheckTree";
import { Notebook, OrganizeJobMode, TitleDetail } from "@/lib/types";
import { TitleDetailControl, useTitleDetail } from "./TitleDetailControl";

interface NewOrganizeJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebooks: Notebook[];
  isPending?: boolean;
  matched?: number;
  onConfirm: (input: {
    sourceNotebookIds?: string[];
    mode: OrganizeJobMode;
    includeSubNotebooks: boolean;
    titleDetail: TitleDetail;
  }) => void | Promise<void>;
}

const NONE: ReadonlySet<string> = new Set();

/** Picks a source scope, AI mode, and title detail level before the disclosure/exclusion confirmation. */
export function NewOrganizeJobDialog({ open, onOpenChange, notebooks, isPending = false, matched, onConfirm }: NewOrganizeJobDialogProps) {
  const [sourceIds, setSourceIds] = useState<Set<string>>(new Set());
  const [allNotes, setAllNotes] = useState(true);
  const [includeSubNotebooks, setIncludeSubNotebooks] = useState(true);
  const [mode, setMode] = useState<OrganizeJobMode>("organize");
  const [titleDetail, setTitleDetail] = useTitleDetail();
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const walk = (nodes: Notebook[]) => nodes.forEach((node) => {
      walk(node.children);
      counts.set(node.id, (node.noteCount ?? 0) + node.children.reduce((sum, child) => sum + (counts.get(child.id) ?? 0), 0));
    });
    walk(notebooks);
    return counts;
  }, [notebooks]);
  const toggle = (id: string) => setSourceIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectAll = () => { setAllNotes(true); setSourceIds(new Set()); };
  const submit = () => onConfirm({ sourceNotebookIds: allNotes ? [] : [...sourceIds], mode, includeSubNotebooks, titleDetail });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />New AI job</DialogTitle>
          <DialogDescription>Choose the notes to analyze. Nothing changes until you review and apply the suggestions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Source scope</p>
            <button type="button" className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm" onClick={selectAll}>
              <input type="radio" checked={allNotes} onChange={selectAll} /> All notes
            </button>
            <NotebookCheckTree
              notebooks={notebooks}
              checkedIds={allNotes ? NONE : sourceIds}
              onToggle={(id) => { setAllNotes(false); toggle(id); }}
              meta={(nb) => noteCounts.get(nb.id) ?? 0}
              aria-label="Source notebooks"
            />
            {!allNotes && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={includeSubNotebooks} onChange={(event) => setIncludeSubNotebooks(event.target.checked)} /> Include sub-notebooks</label>}
          </div>
          {matched !== undefined && <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground"><strong>{matched.toLocaleString()}</strong> notes matched this scope.</p>}
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Job mode</p>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={mode === "organize"} onChange={() => setMode("organize")} /> Organize (title, notebook, tags)</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={mode === "retitle"} onChange={() => setMode("retitle")} /> Retitle only</label>
          </div>
          <TitleDetailControl value={titleDetail} onChange={setTitleDetail} disabled={isPending} />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={isPending || (!allNotes && sourceIds.size === 0)} onClick={submit}>{isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{matched === undefined ? "Check scope" : "Continue"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
