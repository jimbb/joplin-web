import { ArrowDownUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SORT_FIELD_LABELS,
  SortChoice,
  SortField,
  SortOrder,
  defaultOrder,
  orderLabel,
  sortDescription,
} from "@/lib/note-sort";

interface NoteSortMenuProps {
  sort: SortChoice;
  onChange: (next: SortChoice) => void;
  /** Fields offered, in menu order */
  fields: readonly SortField[];
}

/** Sort button with a "Sort by" field menu and, except for Relevance, the direction */
export function NoteSortMenu({ sort, onChange, fields }: NoteSortMenuProps) {
  const description = sortDescription(sort);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={`Sort notes (${description})`}
          title={`Sorted by ${description}`}
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 text-xs">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort.field}
          onValueChange={(v) => {
            const field = v as SortField;
            if (field !== sort.field) onChange({ field, order: defaultOrder(field) });
          }}
        >
          {fields.map((field) => (
            <DropdownMenuRadioItem key={field} value={field}>
              {SORT_FIELD_LABELS[field]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {sort.field !== "relevance" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sort.order}
              onValueChange={(v) => onChange({ field: sort.field, order: v as SortOrder })}
            >
              {(sort.field === "title" ? (["asc", "desc"] as const) : (["desc", "asc"] as const)).map((order) => (
                <DropdownMenuRadioItem key={order} value={order}>
                  {orderLabel(sort.field, order)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
