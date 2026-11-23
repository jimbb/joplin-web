import { describe, expect, it } from "vitest";
import type { Notebook, TaskCategory } from "./types";
import {
  buildNotebookLineageMap,
  extractSourceHost,
  parseRuleTokens,
  resolveTaskCustomCategories,
  taskMatchesRules,
  type MatchableTask,
} from "./task-categories";

const id = (c: string) => c.repeat(32);

const savedNb: Notebook = {
  id: id("1"),
  title: "Saved items",
  parentId: "",
  noteCount: 0,
  children: [
    { id: id("2"), title: "Facebook", parentId: id("1"), children: [], noteCount: 10 },
    { id: id("3"), title: "X @jimbb", parentId: id("1"), children: [], noteCount: 4 },
  ],
};

const fbTask: MatchableTask = {
  key: `todo-${id("a")}`,
  kind: "todo",
  title: "Nice ramen reel",
  noteTitle: "Nice ramen reel",
  notebookId: id("2"),
  notebookCategoryLabel: "Saved items / Facebook",
  sourceUrl: "https://www.facebook.com/reel/123456/",
  tagIds: [id("t")],
};

const workTask: MatchableTask = {
  key: `inline-${id("b")}-4-1`,
  kind: "inline",
  title: "Verify DNS record",
  noteTitle: "Launch checklist",
  notebookId: id("9"),
  notebookCategoryLabel: "Work / ParcelBright",
  sourceUrl: "",
  tagIds: [],
};

describe("task-categories", () => {
  const lineage = buildNotebookLineageMap([savedNb]);

  it("matches by notebook ID (including parent notebooks), path prefix, source URL, tag, keyword, and task kind", () => {
    expect(taskMatchesRules(fbTask, { notebookIds: [id("1")] }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, { notebookPathPrefixes: ["Saved items / Facebook"] }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, { notebookPathPrefixes: ["saved items"] }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, { notebookPathPrefixes: ["Saved"] }, lineage)).toBe(false);
    expect(taskMatchesRules(fbTask, { sourceUrlPatterns: ["facebook.com"] }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, { tagIds: [id("t")] }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, { keywords: ["RAMEN"] }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, { taskKind: "inline", sourceUrlPatterns: ["facebook.com"] }, lineage)).toBe(
      false
    );
    expect(taskMatchesRules(fbTask, { taskKind: "todo" }, lineage)).toBe(true);
    expect(taskMatchesRules(fbTask, {}, lineage)).toBe(false);
  });

  it("lets manual assignment override automatic rule matches", () => {
    const fbCat: TaskCategory = {
      id: "cat-fb",
      name: "Facebook Bookmarked",
      color: "sky",
      rules: { notebookPathPrefixes: ["Saved items / Facebook"] },
      createdAt: 1,
      updatedAt: 1,
    };
    const weekendCat: TaskCategory = {
      id: "cat-weekend",
      name: "Weekend",
      color: "emerald",
      rules: {},
      createdAt: 2,
      updatedAt: 2,
    };

    const auto = resolveTaskCustomCategories(fbTask, [fbCat, weekendCat], {}, lineage);
    expect(auto.manualCategoryId).toBeNull();
    expect(auto.primaryCustomCategory?.id).toBe("cat-fb");
    expect(auto.effectiveCategoryIds).toEqual(["cat-fb"]);

    const manual = resolveTaskCustomCategories(
      fbTask,
      [fbCat, weekendCat],
      { [fbTask.key]: "cat-weekend" },
      lineage
    );
    expect(manual.manualCategoryId).toBe("cat-weekend");
    expect(manual.primaryCustomCategory?.id).toBe("cat-weekend");
    expect(manual.effectiveCategoryIds).toEqual(["cat-weekend"]);
    expect(manual.autoMatchedCategoryIds).toEqual(["cat-fb"]);

    const unmatched = resolveTaskCustomCategories(workTask, [fbCat, weekendCat], {}, lineage);
    expect(unmatched.primaryCustomCategory).toBeNull();
    expect(unmatched.effectiveCategoryIds).toEqual([]);
  });

  it("parses rule tokens and extracts hostnames cleanly", () => {
    expect(parseRuleTokens("facebook.com, fb.watch\nFACEBOOK.COM,  ")).toEqual([
      "facebook.com",
      "fb.watch",
    ]);
    expect(extractSourceHost("https://www.facebook.com/reel/123")).toBe("facebook.com");
    expect(extractSourceHost("not-a-url")).toBe("");
  });
});
