import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { Note, Notebook } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import * as clipboard from "@/lib/clipboard";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { HomePage } from "./HomePage";
import { RecentPage } from "./RecentPage";
import { TasksPage } from "./TasksPage";
import { HygienePage } from "./HygienePage";
import { ClipPage } from "./ClipPage";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", serverHost: "notes.example.com", logout: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/components/notes/NoteEditor", () => ({
  NoteEditor: ({ note }: { note: Note }) => <div>Editing {note.id}</div>,
}));

const id = (c: string) => c.repeat(32);
const inboxNb: Notebook = { id: id("1"), title: "Inbox", parentId: "", children: [], noteCount: 2 };
const workNb: Notebook = { id: id("2"), title: "Work", parentId: "", children: [], noteCount: 3 };
const noteAId = id("a");
const noteBId = id("b");
const noteCId = id("c");

const sampleNoteA: Note = {
  id: noteAId,
  title: "Q4 Architecture Review",
  body: "# Overview\n\nDetailed review body.",
  updatedTime: 1_700_000_000_000,
  createdTime: 1_699_000_000_000,
  parentId: inboxNb.id,
  notebookId: inboxNb.id,
  notebookTitle: inboxNb.title,
  tags: [],
  isTodo: false,
  todoCompleted: false,
};

function mockBaseWorkspace(override?: (call: FetchCall) => Response | undefined) {
  return mockFetch((call) => {
    const custom = override?.(call);
    if (custom) return custom;
    const url = new URL(call.path, "http://localhost");
    if (url.pathname === "/api/notebooks") return jsonResponse([inboxNb, workNb]);
    if (url.pathname === "/api/tags") return jsonResponse([]);
    if (url.pathname === "/api/notes" && url.searchParams.get("conflict")) return jsonResponse([]);
    if (url.pathname === "/api/organize/status") return jsonResponse({ enabled: true, model: "deepseek-flash" });
    if (url.pathname === "/api/organize/jobs" && call.method === "GET") return jsonResponse({ jobs: [] });
    if (url.pathname === "/api/ai/status") return jsonResponse({ enabled: true, model: "deepseek-flash" });
    if (url.pathname === "/api/preferences" && call.method === "GET") {
      return jsonResponse({
        favoriteNoteIds: [noteAId],
        favoriteNotebookIds: [inboxNb.id],
        savedSearches: [{ id: "s1", name: "Unread", query: "tag:unread", createdAt: 1000 }],
        recentReads: [{ noteId: noteAId, readAt: 1_700_000_500_000 }],
        scratchpad: "Call Alice tomorrow",
        favoriteNotes: [
          {
            id: noteAId,
            title: sampleNoteA.title,
            preview: "Detailed review body.",
            updatedTime: sampleNoteA.updatedTime,
            createdTime: sampleNoteA.createdTime,
            parentId: inboxNb.id,
          },
        ],
        favoriteNotebooks: [{ id: inboxNb.id, title: inboxNb.title, parentId: "", noteCount: 2, encrypted: false }],
      });
    }
    return undefined;
  });
}

beforeEach(() => {
  localStorage.clear();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HomePage", () => {
  it("renders shortcuts, recent lists, quick capture to Inbox, and scratchpad promote", async () => {
    let scratchpad = "Initial scratch line\nSecond detail";
    const calls = mockBaseWorkspace((call) => {
      if (call.method === "GET" && call.path === "/api/preferences") {
        return jsonResponse({
          favoriteNoteIds: [noteAId],
          favoriteNotebookIds: [inboxNb.id],
          savedSearches: [{ id: "s1", name: "Unread", query: "tag:unread", createdAt: 1000 }],
          recentReads: [{ noteId: noteAId, readAt: 1_700_000_500_000 }],
          scratchpad,
          favoriteNotes: [
            {
              id: noteAId,
              title: sampleNoteA.title,
              preview: "Detailed review body.",
              updatedTime: sampleNoteA.updatedTime,
              createdTime: sampleNoteA.createdTime,
              parentId: inboxNb.id,
            },
          ],
          favoriteNotebooks: [{ id: inboxNb.id, title: inboxNb.title, parentId: "", noteCount: 2, encrypted: false }],
        });
      }
      if (call.path === "/api/notes/recent") {
        return jsonResponse({
          recentRead: [{ id: noteAId, title: sampleNoteA.title, preview: "Read", updatedTime: 1000, createdTime: 900, readAt: 2000 }],
          recentCreated: [{ id: noteBId, title: "Fresh Note", preview: "New", updatedTime: 3000, createdTime: 3000 }],
        });
      }
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            { id: noteCId, title: "Book venue", notebookTitle: "Work", todoCompleted: false, todoDue: 0, updatedTime: 1000 },
          ],
          inlineTasks: [],
        });
      }
      if (call.method === "POST" && call.path === "/api/notes") {
        const body = call.body as { title: string; body: string; parentId: string; isTodo?: boolean };
        return jsonResponse({ ...sampleNoteA, id: id("e"), title: body.title, body: body.body, parentId: body.parentId, isTodo: Boolean(body.isTodo) }, 201);
      }
      if (call.method === "PUT" && call.path === "/api/preferences/scratchpad") {
        scratchpad = (call.body as { scratchpad: string }).scratchpad;
        return jsonResponse({ scratchpad });
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/home" element={<HomePage />} />
          <Route path="/notes/:id" element={<div>Note Route</div>} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/home" }
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Workspace Home" })).toBeTruthy();
    expect(await screen.findByText("Open Tasks (1)")).toBeTruthy();
    expect(screen.getByText("Fresh Note")).toBeTruthy();
    expect(screen.getAllByText(sampleNoteA.title).length).toBeGreaterThanOrEqual(1);

    // Quick Capture picks Inbox by default and posts note
    const select = screen.getByLabelText("Capture target notebook") as HTMLSelectElement;
    expect(select.value).toBe(inboxNb.id);

    fireEvent.change(screen.getByLabelText("Quick capture title"), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByLabelText("Quick capture body"), { target: { value: "- [ ] Milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as To-do" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/notes")).toBe(true));
    const createCall = calls.find((c) => c.method === "POST" && c.path === "/api/notes")!;
    expect(createCall.body).toEqual({
      parentId: inboxNb.id,
      title: "Groceries",
      body: "- [ ] Milk",
      isTodo: true,
    });

    // Save scratchpad manually then promote to note
    const scratchArea = screen.getByLabelText("Scratchpad") as HTMLTextAreaElement;
    expect(scratchArea.value).toContain("Initial scratch line");
    fireEvent.change(scratchArea, { target: { value: "# Promoted Heading\nLine two" } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.path === "/api/preferences/scratchpad")).toBe(true)
    );

    fireEvent.click(screen.getByRole("button", { name: "Promote to Note" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/notes/${id("e")}`));
  });
});

describe("RecentPage", () => {
  it("switches between Recently Read / Recently Created, filters notes, and records read after 500ms", async () => {
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/notes/recent") {
        return jsonResponse({
          recentRead: [
            { id: noteAId, title: sampleNoteA.title, preview: "Read summary", updatedTime: 1000, createdTime: 900, readAt: 5000 },
          ],
          recentCreated: [
            { id: noteBId, title: "Brand New Spec", preview: "Created spec", updatedTime: 6000, createdTime: 6000 },
          ],
        });
      }
      if (call.path === `/api/notes/${noteAId}` && call.method === "GET") {
        return jsonResponse(sampleNoteA);
      }
      if (call.method === "POST" && call.path === `/api/preferences/recent-reads/${noteAId}`) {
        return jsonResponse({ ok: true });
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/recent" element={<RecentPage />} />
          <Route path="/recent/:id" element={<RecentPage />} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/recent" }
    );

    const main = screen.getByRole("main");
    expect(await within(main).findByText(sampleNoteA.title)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Recently Created" }));
    expect(await within(main).findByText("Brand New Spec")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/recent?tab=created");

    fireEvent.change(screen.getByLabelText("Filter recent notes"), { target: { value: "nonexistent" } });
    expect(screen.getByText("No matching recent notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(within(main).getByText("Brand New Spec")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Recently Read" }));
    fireEvent.click(await within(main).findByRole("button", { name: new RegExp(sampleNoteA.title) }));
    expect(screen.getByTestId("location").textContent).toBe(`/recent/${noteAId}`);

    await waitFor(
      () =>
        expect(
          calls.some((c) => c.method === "POST" && c.path === `/api/preferences/recent-reads/${noteAId}`)
        ).toBe(true),
      { timeout: 1500 }
    );
  });
});

describe("TasksPage", () => {
  it("filters task tabs, toggles to-do & inline checklist items, and warns on 409 checklist conflict", async () => {
    const overdueTime = Date.now() - 24 * 60 * 60 * 1000;
    let triggerConflict = false;
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            { id: noteAId, title: "Renew cert", notebookTitle: "Work", todoCompleted: false, todoDue: overdueTime, updatedTime: 1000 },
            { id: noteBId, title: "Archived task", notebookTitle: "Inbox", todoCompleted: true, todoDue: 0, updatedTime: 900 },
          ],
          inlineTasks: [
            { noteId: noteCId, noteTitle: "Launch Plan", notebookTitle: "Work", text: "Verify DNS", line: 4, column: 0, checked: false, updatedTime: 2000 },
          ],
        });
      }
      if (call.method === "PUT" && call.path === `/api/notes/${noteAId}`) {
        return jsonResponse({ ...sampleNoteA, todoCompleted: (call.body as { todoCompleted: boolean }).todoCompleted });
      }
      if (call.method === "POST" && call.path === "/api/tasks/toggle") {
        if (triggerConflict) return jsonResponse({ error: "Changed elsewhere" }, 409);
        return jsonResponse({ ...sampleNoteA, id: noteCId, updatedTime: 3000 });
      }
      return undefined;
    });

    renderWithProviders(<TasksPage />, { route: "/tasks" });

    expect(await screen.findByText("Renew cert")).toBeTruthy();
    expect(screen.getByText("Verify DNS")).toBeTruthy();
    expect(screen.queryByText("Archived task")).toBeNull();

    // Check tab filtering
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(screen.getByText("Archived task")).toBeTruthy();
    expect(screen.queryByText("Renew cert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Overdue (1)" }));
    expect(screen.getByText("Renew cert")).toBeTruthy();
    expect(screen.queryByText("Verify DNS")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open (2)" }));

    // Toggle to-do
    fireEvent.click(screen.getByRole("checkbox", { name: 'Toggle "Renew cert"' }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === `/api/notes/${noteAId}`)).toBe(true));

    // Toggle inline checklist cleanly, then simulate 409 conflict
    fireEvent.click(screen.getByRole("checkbox", { name: 'Toggle "Verify DNS"' }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks/toggle")).toBe(true));

    triggerConflict = true;
    fireEvent.click(screen.getByRole("checkbox", { name: 'Toggle "Verify DNS"' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("Checklist moved since this list loaded; refreshed.")
    );
  });

  it("filters, groups, and hides task categories including nested notebook paths", async () => {
    const savedNbId = id("5");
    const fbNbId = id("6");
    const xNbId = id("7");
    const noteDId = id("d");

    mockBaseWorkspace((call) => {
      if (call.path === "/api/notebooks") {
        return jsonResponse([
          workNb,
          {
            id: savedNbId,
            title: "Saved items",
            parentId: "",
            noteCount: 0,
            children: [
              { id: fbNbId, title: "Facebook", parentId: savedNbId, children: [], noteCount: 2 },
              { id: xNbId, title: "X @jimbb", parentId: savedNbId, children: [], noteCount: 1 },
            ],
          },
        ]);
      }
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            {
              id: noteAId,
              parentId: fbNbId,
              title: "FB Reel bookmark",
              notebookTitle: "Facebook",
              notebookPath: "Saved items / Facebook",
              todoCompleted: false,
              todoDue: 0,
              updatedTime: 3000,
            },
            {
              id: noteBId,
              parentId: xNbId,
              title: "X thread bookmark",
              notebookTitle: "X @jimbb",
              notebookPath: "Saved items / X @jimbb",
              todoCompleted: false,
              todoDue: 0,
              updatedTime: 2500,
            },
          ],
          inlineTasks: [
            {
              noteId: noteCId,
              parentId: workNb.id,
              noteTitle: "Launch Plan",
              notebookTitle: "Work",
              notebookPath: "Work",
              text: "Verify DNS",
              line: 4,
              column: 1,
              checked: false,
              updatedTime: 2000,
            },
            {
              noteId: noteDId,
              parentId: fbNbId,
              noteTitle: "FB Post",
              notebookTitle: "Facebook",
              notebookPath: "Saved items / Facebook",
              text: "Try recipe",
              line: 2,
              column: 1,
              checked: false,
              updatedTime: 1800,
            },
          ],
        });
      }
      return undefined;
    });

    renderWithProviders(<TasksPage />, { route: "/tasks" });

    expect(await screen.findByText("FB Reel bookmark")).toBeTruthy();
    expect(screen.getByText("X thread bookmark")).toBeTruthy();
    expect(screen.getByText("Verify DNS")).toBeTruthy();

    // Quick category filter pill filters to Saved items / Facebook and updates status counts
    const categoryBar = screen.getByRole("group", { name: "Task categories" });
    fireEvent.click(within(categoryBar).getByRole("button", { name: /Saved items \/ Facebook \(2\)/ }));
    expect(screen.getByText("FB Reel bookmark")).toBeTruthy();
    expect(screen.getByText("Try recipe")).toBeTruthy();
    expect(screen.queryByText("Verify DNS")).toBeNull();
    expect(screen.queryByText("X thread bookmark")).toBeNull();
    expect(screen.getByRole("button", { name: "Open (2)" })).toBeTruthy();

    // Categories popover lets the user pick a parent group (Saved items (all))
    fireEvent.click(screen.getByRole("button", { name: "Choose task category" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Saved items \(all\)/ }));
    expect(screen.getByText("FB Reel bookmark")).toBeTruthy();
    expect(screen.getByText("X thread bookmark")).toBeTruthy();
    expect(screen.queryByText("Verify DNS")).toBeNull();

    // Return to All and hide Saved items (all) from All view
    fireEvent.click(within(categoryBar).getByRole("button", { name: /^All \(4\)$/ }));
    expect(screen.getByText("Verify DNS")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose task category" }));
    fireEvent.click(await screen.findByRole("button", { name: "Hide Saved items (all) from All" }));
    expect(screen.queryByText("FB Reel bookmark")).toBeNull();
    expect(screen.queryByText("X thread bookmark")).toBeNull();
    expect(screen.getByText("Verify DNS")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open (1)" })).toBeTruthy();

    // Explicitly selecting a hidden category still displays it with an unhide banner
    fireEvent.click(screen.getByRole("button", { name: /^Saved items \/ Facebook/ }));
    expect(screen.getByText("FB Reel bookmark")).toBeTruthy();
    expect(screen.getByText("Hidden from All categories view.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show in All" }));
    expect(screen.queryByText("Hidden from All categories view.")).toBeNull();

    // Clear category and test Group by category with collapsible sections
    fireEvent.click(screen.getByRole("button", { name: "Clear category filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    const main = screen.getByRole("main");
    const fbSectionBtn = within(main)
      .getAllByRole("button", { name: /^Saved items \/ Facebook/ })
      .find((btn) => btn.hasAttribute("aria-expanded"))!;
    expect(fbSectionBtn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fbSectionBtn);
    expect(fbSectionBtn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("FB Reel bookmark")).toBeNull();
    expect(screen.getByText("Verify DNS")).toBeTruthy();

    // Scroll container locks horizontal overflow
    const scroller = screen.getByTestId("tasks-scroll-container");
    expect(scroller.className).toContain("overflow-x-hidden");
  });

  it("creates, edits, manually assigns, and deletes custom task categories with auto-match rules", async () => {
    const savedNbId = id("5");
    const fbNbId = id("6");
    let customCategories: Array<{
      id: string;
      name: string;
      color: string;
      rules: Record<string, unknown>;
      createdAt: number;
      updatedAt: number;
    }> = [];
    let assignments: Record<string, string> = {};

    mockBaseWorkspace((call) => {
      if (call.path === "/api/notebooks") {
        return jsonResponse([
          workNb,
          {
            id: savedNbId,
            title: "Saved items",
            parentId: "",
            noteCount: 0,
            children: [
              { id: fbNbId, title: "Facebook", parentId: savedNbId, children: [], noteCount: 1 },
            ],
          },
        ]);
      }
      if (call.path === "/api/preferences" && call.method === "GET") {
        return jsonResponse({
          favoriteNoteIds: [],
          favoriteNotebookIds: [],
          savedSearches: [],
          recentReads: [],
          scratchpad: "",
          taskCategories: customCategories,
          taskCategoryAssignments: assignments,
          favoriteNotes: [],
          favoriteNotebooks: [],
        });
      }
      if (call.path === "/api/preferences/task-categories" && call.method === "POST") {
        const body = call.body as { name: string; color?: string; rules?: Record<string, unknown> };
        const created = {
          id: "cat-1",
          name: body.name,
          color: body.color ?? "terracotta",
          rules: body.rules ?? {},
          createdAt: 100,
          updatedAt: 100,
        };
        customCategories = [...customCategories, created];
        return jsonResponse(created, 201);
      }
      if (call.path === "/api/preferences/task-categories/cat-1" && call.method === "PUT") {
        const body = call.body as { name?: string; color?: string; rules?: Record<string, unknown> };
        const updated = {
          ...customCategories[0],
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.rules !== undefined ? { rules: body.rules } : {}),
          updatedAt: 200,
        };
        customCategories = [updated];
        return jsonResponse(updated);
      }
      if (call.path === "/api/preferences/task-categories/assignments" && call.method === "PUT") {
        const body = call.body as { taskKey: string; categoryId: string | null };
        const next = { ...assignments };
        if (body.categoryId) next[body.taskKey] = body.categoryId;
        else delete next[body.taskKey];
        assignments = next;
        return jsonResponse({ taskCategoryAssignments: next });
      }
      if (call.path === "/api/preferences/task-categories/cat-1" && call.method === "DELETE") {
        customCategories = [];
        assignments = {};
        return jsonResponse(null, 204);
      }
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            {
              id: noteAId,
              parentId: fbNbId,
              title: "FB Reel bookmark",
              notebookTitle: "Facebook",
              notebookPath: "Saved items / Facebook",
              sourceUrl: "https://www.facebook.com/reel/123/",
              todoCompleted: false,
              todoDue: 0,
              updatedTime: 3000,
            },
          ],
          inlineTasks: [
            {
              noteId: noteCId,
              parentId: workNb.id,
              noteTitle: "Launch Plan",
              notebookTitle: "Work",
              notebookPath: "Work",
              text: "Verify DNS",
              line: 4,
              column: 1,
              checked: false,
              updatedTime: 2000,
            },
          ],
        });
      }
      return undefined;
    });

    renderWithProviders(<TasksPage />, { route: "/tasks" });
    expect(await screen.findByText("FB Reel bookmark")).toBeTruthy();

    // Create a custom category with an import path prefix rule
    fireEvent.click(screen.getByRole("button", { name: "New task category" }));
    fireEvent.change(await screen.findByLabelText("Category name"), {
      target: { value: "Facebook Bookmarked" },
    });
    fireEvent.change(screen.getByLabelText("Import / notebook path prefixes"), {
      target: { value: "Saved items / Facebook" },
    });
    expect(screen.getByText("Matches 1 task currently.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create category" }));

    // Custom category pill appears with auto-matched count (1) and filters correctly
    const categoryBar = await screen.findByRole("group", { name: "Task categories" });
    const fbPill = await within(categoryBar).findByRole("button", {
      name: /^Facebook Bookmarked \(1\)$/,
    });
    fireEvent.click(fbPill);
    expect(screen.getByText("FB Reel bookmark")).toBeTruthy();
    expect(screen.queryByText("Verify DNS")).toBeNull();

    // Edit category via Categories popover -> rename
    fireEvent.click(screen.getByRole("button", { name: "Choose task category" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Facebook Bookmarked" }));
    fireEvent.change(await screen.findByLabelText("Category name"), {
      target: { value: "FB Saved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const barAfterEdit = await screen.findByRole("group", { name: "Task categories" });
    expect(
      await within(barAfterEdit).findByRole("button", { name: /^FB Saved \(1\)$/ })
    ).toBeTruthy();

    // Delete category via Edit dialog (2-step confirm) and return to All view
    fireEvent.click(screen.getByRole("button", { name: "Choose task category" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit FB Saved" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    const barAfterDelete = await screen.findByRole("group", { name: "Task categories" });
    await waitFor(() =>
      expect(within(barAfterDelete).queryByRole("button", { name: /^FB Saved/ })).toBeNull()
    );
    expect(screen.getByText("Verify DNS")).toBeTruthy();
  });
});

describe("HygienePage", () => {
  it("displays hygiene clusters, trashes duplicates & empty notes, and triggers Auto-organize for untagged notes", async () => {
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/organize/hygiene") {
        return jsonResponse({
          duplicateClusters: [
            {
              id: "cluster-1",
              reason: "exact-title",
              score: 1,
              notes: [
                {
                  id: noteAId,
                  title: "Meeting Notes",
                  notebookTitle: "Work",
                  preview: "Notes from Monday",
                  previewLength: 17,
                  updatedTime: 2000,
                },
                {
                  id: noteBId,
                  title: "Meeting Notes",
                  notebookTitle: "Inbox",
                  preview: "Old duplicate",
                  previewLength: 13,
                  updatedTime: 1000,
                },
              ],
            },
          ],
          emptyNotes: [{ id: noteCId, title: "Blank Scratch", notebookTitle: "Inbox", updatedTime: 500 }],
          untaggedNotes: [{ id: noteAId, title: "Meeting Notes", notebookTitle: "Work", updatedTime: 2000 }],
        });
      }
      if (call.method === "DELETE" && call.path === `/api/notes/${noteBId}`) {
        return jsonResponse(null, 204);
      }
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        return jsonResponse([{ id: noteCId, ok: true }]);
      }
      if (call.method === "POST" && call.path === "/api/organize/jobs") {
        return jsonResponse({ jobId: "job-99" }, 201);
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/hygiene" element={<HygienePage />} />
          <Route path="/organize/:jobId" element={<div>Job Page</div>} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/hygiene" }
    );

    expect(await screen.findByText("Possible Duplicates (1)")).toBeTruthy();
    expect(screen.getByText("Empty Notes (1)")).toBeTruthy();
    expect(screen.getByText("Untagged Notes (1)")).toBeTruthy();

    // Trash second duplicate
    const trashButtons = screen.getAllByRole("button", { name: "Move to trash" });
    fireEvent.click(trashButtons[1]);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/notes/${noteBId}`)).toBe(true)
    );

    // Trash all empty notes
    fireEvent.click(screen.getByRole("button", { name: /Trash all empty \(1\)/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/notes/batch")).toBe(true)
    );

    // Auto-organize untagged notes
    fireEvent.click(screen.getByRole("button", { name: "Auto-organize untagged" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/organize/jobs")).toBe(true)
    );
    expect(screen.getByTestId("location").textContent).toBe("/organize/job-99");
  });
});

describe("ClipPage", () => {
  it("prefills shared URL/title/text, submits Web Clipper & Email/.eml import, and copies bookmarklet", async () => {
    const copySpy = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    const calls = mockBaseWorkspace((call) => {
      if (call.method === "POST" && call.path === "/api/clip") {
        return jsonResponse({
          note: { ...sampleNoteA, id: id("c"), title: "Clipped Article" },
          extractedTitle: "Clipped Article",
        });
      }
      if (call.method === "POST" && call.path === "/api/integrations/email") {
        return jsonResponse({
          note: { ...sampleNoteA, id: id("d"), title: "Monthly Receipt" },
        });
      }
      return undefined;
    });

    renderWithProviders(<ClipPage />, {
      route: "/clip?url=https%3A%2F%2Fexample.com%2Fpost&title=Post%20Title",
    });

    const urlInput = (await screen.findByLabelText("Article URL")) as HTMLInputElement;
    expect(urlInput.value).toBe("https://example.com/post");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Clip to Note" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/clip")).toBe(true));
    expect(await screen.findByText("Clipped successfully")).toBeTruthy();

    // Switch to Email / .eml Import tab and submit Compose Fields
    fireEvent.click(screen.getByRole("tab", { name: /Email \/ \.eml Import/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compose Fields" }));

    const subjectInput = screen.getByLabelText("Email subject") as HTMLInputElement;
    expect(subjectInput.value).toBe("Post Title");
    fireEvent.change(subjectInput, { target: { value: "Monthly Receipt" } });
    fireEvent.change(screen.getByLabelText("Email sender"), { target: { value: "billing@example.com" } });
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "Amount paid: $15" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Email as Note" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/integrations/email")).toBe(true)
    );
    const emailReq = calls.find((c) => c.method === "POST" && c.path === "/api/integrations/email")!;
    expect(within(document.body).getByText("Email imported")).toBeTruthy();
    expect(emailReq.body).toEqual({
      subject: "Monthly Receipt",
      from: "billing@example.com",
      text: "Amount paid: $15",
      parentId: inboxNb.id,
      tags: ["email"],
    });
  });
});
