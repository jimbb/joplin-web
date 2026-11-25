import { useMemo, useState } from "react";
import { Folder, Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { flattenNotebooks } from "@/lib/notebooks";
import { Notebook, OrganizeJobMode } from "@/lib/types";

interface NewOrganizeJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebooks: Notebook[];
  isPending?: boolean;
  onConfirm: (input: { sourceNotebookIds?: string[]; mode: OrganizeJobMode; includeSubNotebooks: boolean }) => void;
}

export function NewOrganizeJobDialog({ open, onOpenChange, notebooks, isPending = false, onConfirm }: NewOrganizeJobDialogProps) {
  const [sourceIds, setSourceIds] = useState<Set<string>>(new Set());
  const [allNotes, setAllNotes] = useState(true);
  const [includeSubNotebooks, setIncludeSubNotebooks] = useState(true);
  const [mode, setMode] = useState<OrganizeJobMode>("organize");
  const flat = useMemo(() => flattenNotebooks(notebooks).filter((nb) => !nb.encrypted), [notebooks]);
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
  const submit = () => onConfirm({ sourceNotebookIds: allNotes ? [] : [...sourceIds], mode, includeSubNotebooks });
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
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
              {flat.map((nb) => {
                const checked = !allNotes && sourceIds.has(nb.id);
                return <label key={nb.id} style={{ paddingLeft: `${8 + nb.depth * 14}px` }} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                  <input type="checkbox" checked={checked} onChange={() => { setAllNotes(false); toggle(nb.id); }} />
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" /><span className="truncate">{nb.title || "Untitled Folder"}</span><span className="ml-auto text-xs text-muted-foreground">{noteCounts.get(nb.id) ?? 0}</span>
                </label>;
              })}
            </div>
            {!allNotes && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={includeSubNotebooks} onChange={(event) => setIncludeSubNotebooks(event.target.checked)} /> Include sub-notebooks</label>}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Job mode</p>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={mode === "organize"} onChange={() => setMode("organize")} /> Organize (title, notebook, tags)</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={mode === "retitle"} onChange={() => setMode("retitle")} /> Retitle only</label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={isPending || (!allNotes && sourceIds.size === 0)} onClick={submit}>{isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Start job</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
