import type { NoteListItem } from "@/lib/types";

/** What a list of notes is ordered by; "relevance" is the search's own ranking */
export type SortField = "relevance" | "updated" | "created" | "title";
export type SortOrder = "asc" | "desc";

export interface SortChoice {
  field: SortField;
  order: SortOrder;
}

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  relevance: "Relevance",
  updated: "Updated date",
  created: "Created date",
  title: "Title",
};

/** Sort fields offered for notebook, tag and other note lists */
export const LIST_SORT_FIELDS: readonly SortField[] = ["updated", "created", "title"];
/** Sort fields offered for search results (and a list while its filter has text) */
export const SEARCH_SORT_FIELDS: readonly SortField[] = ["relevance", "updated", "created", "title"];

/** localStorage key of the sort for note lists */
export const LIST_SORT_STORAGE_KEY = "joplin-note-sort";
/** localStorage key of the sort for search results */
export const SEARCH_SORT_STORAGE_KEY = "joplin-search-sort";

export const DEFAULT_LIST_SORT: SortChoice = { field: "updated", order: "desc" };
export const DEFAULT_SEARCH_SORT: SortChoice = { field: "relevance", order: "desc" };

/**
 * Reads a remembered sort, so it survives remounts and reloads. Falls back when storage is
 * unavailable or holds something invalid, or a field that `fields` doesn't offer.
 */
export function loadSort(key: string, fallback: SortChoice, fields: readonly SortField[]): SortChoice {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    if (stored && fields.includes(stored.field) && (stored.order === "asc" || stored.order === "desc")) {
      return { field: stored.field, order: stored.order };
    }
  } catch {
    // storage unavailable or invalid
  }
  return fallback;
}

/** Remembers a sort choice under `key` */
export function saveSort(key: string, sort: SortChoice) {
  try {
    localStorage.setItem(key, JSON.stringify(sort));
  } catch {
    // storage unavailable
  }
}

/** Direction labels that fit the field: A-Z for titles, newest/oldest for dates */
export function orderLabel(field: SortField, order: SortOrder): string {
  if (field === "title") return order === "asc" ? "A–Z" : "Z–A";
  return order === "desc" ? "Newest first" : "Oldest first";
}

/** The direction a field starts with: titles read naturally A-Z, dates newest first */
export function defaultOrder(field: SortField): SortOrder {
  return field === "title" ? "asc" : "desc";
}

/** "Updated date, Newest first", or just "Relevance", which has a single direction */
export function sortDescription(sort: SortChoice): string {
  const label = SORT_FIELD_LABELS[sort.field];
  return sort.field === "relevance" ? label : `${label}, ${orderLabel(sort.field, sort.order)}`;
}

const titleCollator = new Intl.Collator();

/**
 * Returns a sorted copy of `notes`. Relevance keeps the given order (search results arrive ranked)
 * unless `compareRelevance` ranks them; equal notes keep their relative order.
 */
export function sortNotes<T extends Pick<NoteListItem, "title" | "createdTime" | "updatedTime">>(
  notes: readonly T[],
  sort: SortChoice,
  compareRelevance?: (a: T, b: T) => number
): T[] {
  const sorted = [...notes];
  if (sort.field === "relevance") {
    return compareRelevance ? sorted.sort(compareRelevance) : sorted;
  }
  const sign = sort.order === "asc" ? 1 : -1;
  if (sort.field === "title") {
    return sorted.sort((a, b) => sign * titleCollator.compare(a.title, b.title));
  }
  const time = (n: T) => (sort.field === "created" ? n.createdTime : n.updatedTime) || 0;
  return sorted.sort((a, b) => sign * (time(a) - time(b)));
}
