import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_SORT,
  DEFAULT_SEARCH_SORT,
  LIST_SORT_FIELDS,
  SEARCH_SORT_FIELDS,
  loadSort,
  saveSort,
  sortDescription,
  sortNotes,
} from "./note-sort";

afterEach(() => localStorage.clear());

const note = (id: string, title: string, createdTime: number, updatedTime: number) => ({
  id,
  title,
  createdTime,
  updatedTime,
});

// In the order a search returns them (best match first)
const ranked = [
  note("a", "beta", 3, 10),
  note("b", "Alpha", 1, 30),
  note("c", "gamma", 2, 20),
  note("d", "alpha", 4, 30),
];
const ids = (list: Array<{ id: string }>) => list.map((n) => n.id).join("");

describe("sortNotes", () => {
  it("keeps the search ranking for relevance, in a copy", () => {
    const sorted = sortNotes(ranked, DEFAULT_SEARCH_SORT);
    expect(ids(sorted)).toBe("abcd");
    expect(sorted).not.toBe(ranked);
  });

  it("ranks with the given comparator for relevance", () => {
    expect(ids(sortNotes(ranked, DEFAULT_SEARCH_SORT, (x, y) => x.createdTime - y.createdTime))).toBe("bcad");
  });

  it("sorts by date or title in either direction, ties keeping the ranking", () => {
    expect(ids(sortNotes(ranked, { field: "updated", order: "desc" }))).toBe("bdca");
    expect(ids(sortNotes(ranked, { field: "updated", order: "asc" }))).toBe("acbd");
    expect(ids(sortNotes(ranked, { field: "created", order: "desc" }))).toBe("dacb");
    expect(ids(sortNotes(ranked, { field: "title", order: "asc" }))).toBe("dbac");
    expect(ids(sortNotes(ranked, { field: "title", order: "desc" }))).toBe("cabd");
  });
});

describe("loadSort / saveSort", () => {
  it("falls back to the default without a valid stored choice", () => {
    expect(loadSort("k", DEFAULT_SEARCH_SORT, SEARCH_SORT_FIELDS)).toEqual(DEFAULT_SEARCH_SORT);
    localStorage.setItem("k", "{not json");
    expect(loadSort("k", DEFAULT_SEARCH_SORT, SEARCH_SORT_FIELDS)).toEqual(DEFAULT_SEARCH_SORT);
    localStorage.setItem("k", JSON.stringify({ field: "updated", order: "sideways" }));
    expect(loadSort("k", DEFAULT_SEARCH_SORT, SEARCH_SORT_FIELDS)).toEqual(DEFAULT_SEARCH_SORT);
  });

  it("round-trips a choice, but only for fields the list offers", () => {
    saveSort("k", { field: "title", order: "desc" });
    expect(loadSort("k", DEFAULT_SEARCH_SORT, SEARCH_SORT_FIELDS)).toEqual({ field: "title", order: "desc" });

    saveSort("k", { field: "relevance", order: "desc" });
    expect(loadSort("k", DEFAULT_LIST_SORT, LIST_SORT_FIELDS)).toEqual(DEFAULT_LIST_SORT);
  });
});

it("describes a sort with its direction, except relevance", () => {
  expect(sortDescription(DEFAULT_SEARCH_SORT)).toBe("Relevance");
  expect(sortDescription({ field: "title", order: "asc" })).toBe("Title, A–Z");
  expect(sortDescription(DEFAULT_LIST_SORT)).toBe("Updated date, Newest first");
});
