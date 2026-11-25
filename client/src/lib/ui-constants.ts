/** Id of the search field in the mobile menu, so Ctrl+K can focus it when it opens the menu */
export const MOBILE_SEARCH_INPUT_ID = "mobile-sidebar-search";

/** Short summary of the search syntax, shown as the search fields' tooltip and with empty results */
export const SEARCH_SYNTAX_HINT =
  'Searches titles, bodies, and attachment OCR. Use "exact phrase", -word to exclude, tag:name, notebook:name, tag:none, type:todo, iscompleted:0, has:attachment, has:ocr, sourceurl:domain, created:week, updated:today.';

/** Number of items rendered per page in progressive lists (NoteList, SearchResults) */
export const NOTE_LIST_PAGE_SIZE = 100;

/** localStorage key holding the NoteList view layout ("list" | "gallery" | "table" | "board") */
export const NOTE_LIST_VIEW_STORAGE_KEY = "joplin-note-list-view";

/**
 * Classes for sidebar row action buttons: shown on hover/focus on wide screens with a mouse,
 * always visible on small or touch screens, which have no hover.
 */
export const ROW_ACTION_VISIBILITY =
  "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/** localStorage key holding the JSON array of explicitly expanded notebook IDs in the sidebar */
export const EXPANDED_NOTEBOOKS_STORAGE_KEY = "joplin-sidebar-expanded-notebooks";

/** localStorage key holding whether the sidebar Tags section is explicitly expanded ("true"/"false") */
export const TAGS_EXPANDED_STORAGE_KEY = "joplin-sidebar-tags-expanded";

/** localStorage key holding whether Tasks Hub groups tasks by category ("true"/"false") */
export const TASKS_GROUP_BY_CATEGORY_STORAGE_KEY = "joplin-tasks-group-by-category";

/** localStorage key holding the JSON array of category keys hidden from Tasks Hub's All view */
export const TASKS_HIDDEN_CATEGORIES_STORAGE_KEY = "joplin-tasks-hidden-categories";

/** localStorage key holding the remembered AI title detail level ("short" | "standard" | "detailed") */
export const TITLE_DETAIL_STORAGE_KEY = "joplin-organize-title-detail";
