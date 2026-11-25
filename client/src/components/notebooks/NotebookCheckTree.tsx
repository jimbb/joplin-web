import { ReactNode, useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findNotebookAncestors } from "@/lib/notebooks";
import { Notebook } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NotebookCheckTreeProps {
  notebooks: Notebook[];
  checkedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Title filter: while non-empty, matching notebooks are listed flat instead of as a tree */
  filter?: string;
  disabled?: boolean;
  /** Right-aligned text for a row, e.g. its note count or "Source" */
  meta?: (notebook: Notebook) => ReactNode;
  "aria-label": string;
  className?: string;
}

/** Drops encrypted notebooks (nothing can be filed there), lifting any readable children into their place. */
function readableTree(nodes: Notebook[]): Notebook[] {
  return nodes.flatMap((nb) =>
    nb.encrypted ? readableTree(nb.children ?? []) : [{ ...nb, children: readableTree(nb.children ?? []) }]
  );
}

function walk(nodes: Notebook[], visit: (nb: Notebook) => void) {
  nodes.forEach((nb) => {
    visit(nb);
    walk(nb.children, visit);
  });
}

/**
 * Checkbox notebook tree for the AI job dialogs. Starts collapsed to the top level, except for the
 * ancestors of notebooks already checked when it mounts, so a preselected notebook stays visible.
 */
export function NotebookCheckTree({
  notebooks,
  checkedIds,
  onToggle,
  filter = "",
  disabled = false,
  meta,
  "aria-label": ariaLabel,
  className,
}: NotebookCheckTreeProps) {
  const tree = useMemo(() => readableTree(notebooks), [notebooks]);
  const parentIds = useMemo(() => {
    const ids: string[] = [];
    walk(tree, (nb) => nb.children.length > 0 && ids.push(nb.id));
    return ids;
  }, [tree]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set([...checkedIds].flatMap((id) => findNotebookAncestors(notebooks, id)))
  );
  const query = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!query) return [];
    const found: Notebook[] = [];
    walk(tree, (nb) => nb.title.toLowerCase().includes(query) && found.push(nb));
    return found;
  }, [tree, query]);

  const allExpanded = parentIds.length > 0 && parentIds.every((id) => expandedIds.has(id));
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderRow = (nb: Notebook, depth: number, nested: boolean): ReactNode => {
    const title = nb.title || "Untitled Folder";
    const hasChildren = nested && nb.children.length > 0;
    const isOpen = hasChildren && expandedIds.has(nb.id);
    const FolderIcon = isOpen ? FolderOpen : Folder;
    const metaText = meta?.(nb);
    return (
      <div key={nb.id}>
        <div
          style={{ paddingLeft: `${4 + depth * 16}px` }}
          className="flex items-center gap-1 rounded-md pr-2 text-sm text-foreground hover:bg-muted/60"
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleExpanded(nb.id)}
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${title}`}
              aria-expanded={isOpen}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-200", isOpen && "rotate-90")} />
            </button>
          ) : (
            nested && <span className="w-[18px] shrink-0" aria-hidden="true" />
          )}
          <label className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 py-1.5">
            <input
              type="checkbox"
              checked={checkedIds.has(nb.id)}
              disabled={disabled}
              onChange={() => onToggle(nb.id)}
              className="h-4 w-4 shrink-0 cursor-pointer rounded border-input accent-primary"
            />
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{title}</span>
            {metaText !== undefined && metaText !== null && (
              <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{metaText}</span>
            )}
          </label>
        </div>
        {isOpen && nb.children.map((child) => renderRow(child, depth + 1, true))}
      </div>
    );
  };

  return (
    <div className="space-y-1">
      {!query && parentIds.length > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpandedIds(allExpanded ? new Set() : new Set(parentIds))}
            className="h-6 px-2 text-xs text-muted-foreground"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      )}
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn("max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-muted/20 p-1", className)}
      >
        {query ? matches.map((nb) => renderRow(nb, 0, false)) : tree.map((nb) => renderRow(nb, 0, true))}
        {(query ? matches : tree).length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            {query ? "No matching notebooks" : "No notebooks"}
          </p>
        )}
      </div>
    </div>
  );
}
