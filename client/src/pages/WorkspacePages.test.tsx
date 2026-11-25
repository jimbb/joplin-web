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
  NoteEditor: ({ note, focusTitle }: { note: Note; focusTitle?: boolean }) => (
    <div data-focus-title={focusTitle ? "true" : "false"}>Editing {note.id}</div>
  ),
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

  it("opens /tasks/:id in the right pane, preserves filters/category/group, syncs completion, and highlights inline tasks", async () => {
    let todoDone = false;
    const todoNote: Note = {
      ...sampleNoteA,
      id: noteAId,
      title: "Renew cert",
      body: "Renew TLS certificate before expiry.",
      parentId: workNb.id,
      notebookId: workNb.id,
      notebookTitle: "Work",
      isTodo: true,
      todoCompleted: false,
    };
    const checklistNote: Note = {
      ...sampleNoteA,
      id: noteCId,
      title: "Launch Plan",
      body: "# Checklist\n\n- [ ] Verify DNS\n- [ ] Smoke test\n",
      parentId: workNb.id,
      notebookId: workNb.id,
      notebookTitle: "Work",
      isTodo: false,
      todoCompleted: false,
    };

    mockBaseWorkspace((call) => {
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            {
              id: noteAId,
              parentId: workNb.id,
              title: "Renew cert",
              notebookTitle: "Work",
              notebookPath: "Work",
              todoCompleted: todoDone,
              todoDue: 0,
              updatedTime: 2000,
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
              line: 3,
              column: 1,
              checked: false,
              updatedTime: 1800,
            },
          ],
        });
      }
      if (call.method === "GET" && call.path === `/api/notes/${noteAId}`) {
        return jsonResponse({ ...todoNote, todoCompleted: todoDone });
      }
      if (call.method === "GET" && call.path === `/api/notes/${noteCId}`) {
        return jsonResponse(checklistNote);
      }
      if (call.method === "PUT" && call.path === `/api/notes/${noteAId}`) {
        todoDone = Boolean((call.body as { todoCompleted?: boolean }).todoCompleted);
        return jsonResponse({ ...todoNote, todoCompleted: todoDone, updatedTime: Date.now() });
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TasksPage />} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/tasks" }
    );

    expect(await screen.findByText("Renew cert")).toBeTruthy();
    expect(screen.getByText("No task selected")).toBeTruthy();

    // Set category filter, local filter, and Group mode before opening a task
    const categoryBar = screen.getByRole("group", { name: "Task categories" });
    fireEvent.click(within(categoryBar).getByRole("button", { name: /^Work \(2\)$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    expect(screen.getByRole("button", { name: "Group" }).getAttribute("aria-pressed")).toBe("true");

    // Click task -> opens /tasks/:id in the right pane and highlights the selected row
    fireEvent.click(screen.getByRole("link", { name: "Renew cert" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/tasks/${noteAId}?category=${workNb.id}`));
    expect(await screen.findByRole("heading", { level: 1, name: "Renew cert" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Renew cert" }).closest("[data-selected]")).toBeTruthy();
    // Should NOT show "Open in Tasks" when already inside Tasks Hub
    expect(screen.queryByRole("link", { name: "Open in Tasks" })).toBeNull();

    // Toggle completion inside the NoteViewer pane -> updates the task list counts
    fireEvent.click(screen.getByRole("button", { name: "To do: mark as done" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Completed (1)" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Open (1)" })).toBeTruthy();

    // Open inline checklist item -> opens containing note with ?line=3 and highlights the task line
    fireEvent.click(screen.getByRole("link", { name: "Verify DNS" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(`/tasks/${noteCId}?category=${workNb.id}&line=3`)
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Launch Plan" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-highlighted-task="true"]')).toBeTruthy());

    // Close pane -> returns to /tasks keeping category and Group state intact
    fireEvent.click(screen.getByRole("button", { name: "Close note view" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/tasks?category=${workNb.id}`));
    expect(screen.getByRole("button", { name: "Group" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("uses single-pane phone layout (list -> note -> close back to list)", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );

    const todoNote: Note = {
      ...sampleNoteA,
      id: noteAId,
      title: "Phone task",
      body: "Mobile detail text",
      isTodo: true,
      todoCompleted: false,
    };

    mockBaseWorkspace((call) => {
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            { id: noteAId, parentId: inboxNb.id, title: "Phone task", notebookTitle: "Inbox", todoCompleted: false, todoDue: 0, updatedTime: 1000 },
          ],
          inlineTasks: [],
        });
      }
      if (call.method === "GET" && call.path === `/api/notes/${noteAId}`) return jsonResponse(todoNote);
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TasksPage />} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/tasks" }
    );

    const listScroller = await screen.findByTestId("tasks-scroll-container");
    const listPane = listScroller.parentElement!;
    expect(listPane.className).not.toContain("hidden md:flex");

    fireEvent.click(await screen.findByRole("link", { name: "Phone task" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Phone task" })).toBeTruthy();
    expect(listPane.className).toContain("hidden md:flex");

    fireEvent.click(screen.getByRole("button", { name: "Close note view" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/tasks"));
    expect(listPane.className).not.toContain("hidden md:flex");
  });

  it("creates a new task in the filtered category's notebook (or default) and opens it with title focused", async () => {
    const newId = id("9");
    let createdNote: Note | null = null;
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            { id: noteAId, parentId: workNb.id, title: "Existing work task", notebookTitle: "Work", notebookPath: "Work", todoCompleted: false, todoDue: 0, updatedTime: 1000 },
          ],
          inlineTasks: [],
        });
      }
      if (call.method === "POST" && call.path === "/api/notes") {
        const body = call.body as { parentId: string; title: string; body: string; isTodo?: boolean };
        createdNote = {
          ...sampleNoteA,
          id: newId,
          title: body.title,
          body: body.body,
          parentId: body.parentId,
          notebookId: body.parentId,
          notebookTitle: body.parentId === workNb.id ? "Work" : "Inbox",
          isTodo: Boolean(body.isTodo),
          todoCompleted: false,
        };
        return jsonResponse(createdNote, 201);
      }
      if (call.method === "GET" && call.path === `/api/notes/${newId}` && createdNote) {
        return jsonResponse(createdNote);
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TasksPage />} />
        </Routes>
        <LocationProbe />
      </>,
      { route: `/tasks?category=${workNb.id}` }
    );

    expect(await screen.findByText("Existing work task")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/tasks/${newId}?category=${workNb.id}`));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/notes")!;
    expect(post.body).toEqual({ parentId: workNb.id, title: "", body: "", isTodo: true });
    const editor = await screen.findByText(`Editing ${newId}`);
    expect(editor.getAttribute("data-focus-title")).toBe("true");
  });
});

describe("HygienePage", () => {
  it("displays tiered hygiene clusters, trashes duplicates & empty notes, and triggers Auto-organize for untagged notes", async () => {
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/organize/hygiene") {
        return jsonResponse({
          duplicateClusters: [
            {
              id: "identical-1",
              tier: "identical",
              score: 1,
              evidence: "Identical text (48 words)",
              suggestedKeeperId: noteAId,
              notes: [
                {
                  id: noteAId,
                  title: "Meeting Notes",
                  notebookTitle: "Work",
                  notebookPath: "Work",
                  preview: "Notes from Monday",
                  previewLength: 17,
                  updatedTime: 2000,
                  tags: [{ id: id("7"), title: "planning" }],
                },
                {
                  id: noteBId,
                  title: "Imported Copy",
                  notebookTitle: "Pending to sort",
                  notebookPath: "Pending to sort",
                  preview: "Notes from Monday",
                  previewLength: 17,
                  updatedTime: 1000,
                  tags: [{ id: id("8"), title: "archive" }],
                },
              ],
            },
          ],
          totalDuplicateClusters: 1,
          identicalClusterCount: 1,
          nearClusterCount: 0,
          emptyNotes: [{ id: noteCId, title: "Blank Scratch", notebookTitle: "Inbox", updatedTime: 500 }],
          untaggedNotes: [{ id: noteAId, title: "Meeting Notes", notebookTitle: "Work", updatedTime: 2000 }],
        });
      }
      if (call.method === "DELETE" && call.path === `/api/notes/${noteBId}`) {
        return jsonResponse(null, 204);
      }
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        return jsonResponse([{ id: noteCId, status: "ok" }]);
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
    expect(screen.getByText("Identical text (48 words)")).toBeTruthy();
    expect(screen.getByText("Suggested keeper")).toBeTruthy();
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

  it("opens side-by-side compare dialog with word diff, supports resolve with tag merge, dismiss, and bulk identical trash", async () => {
    const resAId = id("5");
    const resBId = id("6");
    const noteDId = id("d");

    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/organize/hygiene") {
        return jsonResponse({
          duplicateClusters: [
            {
              id: "identical-cluster",
              tier: "identical",
              score: 1,
              evidence: "Same attachment (312 KB) and identical OCR text",
              suggestedKeeperId: noteAId,
              notes: [
                {
                  id: noteAId,
                  title: "2024-04-01 Thames Water Bill",
                  notebookTitle: "Utilities",
                  notebookPath: "Home / Utilities",
                  preview: "",
                  createdTime: 1000,
                  updatedTime: 2000,
                  tags: [{ id: id("7"), title: "utilities" }],
                  attachments: [{ id: resAId, name: "water.pdf", mime: "application/pdf", size: 319488, kind: "pdf", hasOcr: true }],
                },
                {
                  id: noteBId,
                  title: "Scan_20240402.pdf",
                  notebookTitle: "Pending to sort",
                  notebookPath: "Pending to sort",
                  preview: "",
                  createdTime: 3000,
                  updatedTime: 4000,
                  tags: [{ id: id("8"), title: "tax-2024" }],
                  attachments: [{ id: resBId, name: "scan.pdf", mime: "application/pdf", size: 319488, kind: "pdf", hasOcr: true }],
                },
              ],
            },
            {
              id: "near-cluster",
              tier: "near",
              score: 0.96,
              evidence: "96% same text, same dates/amounts",
              suggestedKeeperId: noteCId,
              notes: [
                {
                  id: noteCId,
                  title: "Annual Statement",
                  notebookTitle: "Finance",
                  notebookPath: "Finance",
                  preview: "Total GBP 486.20",
                  createdTime: 1000,
                  updatedTime: 2000,
                  tags: [],
                },
                {
                  id: noteDId,
                  title: "Annual Statement Rescan",
                  notebookTitle: "Pending to sort",
                  notebookPath: "Pending to sort",
                  preview: "Total GBP 486.20",
                  createdTime: 3000,
                  updatedTime: 4000,
                  tags: [],
                },
              ],
            },
          ],
          totalDuplicateClusters: 2,
          identicalClusterCount: 1,
          nearClusterCount: 1,
          emptyNotes: [],
          untaggedNotes: [],
        });
      }
      if (call.path === `/api/notes/${noteAId}`) {
        return jsonResponse({
          ...sampleNoteA,
          id: noteAId,
          title: "2024-04-01 Thames Water Bill",
          body: `[water.pdf](:/${resAId})`,
          notebookTitle: "Utilities",
          notebookPath: [
            { id: id("1"), title: "Home" },
            { id: id("2"), title: "Utilities" },
          ],
          tags: [{ id: id("7"), title: "utilities" }],
        });
      }
      if (call.path === `/api/notes/${noteBId}`) {
        return jsonResponse({
          ...sampleNoteA,
          id: noteBId,
          title: "Scan_20240402.pdf",
          body: `[scan.pdf](:/${resBId})`,
          notebookTitle: "Pending to sort",
          notebookPath: [{ id: id("3"), title: "Pending to sort" }],
          tags: [{ id: id("8"), title: "tax-2024" }],
        });
      }
      if (call.path === `/api/notes/${noteAId}/attachments`) {
        return jsonResponse([
          {
            id: resAId,
            title: "water.pdf",
            filename: "water.pdf",
            mime: "application/pdf",
            fileExtension: "pdf",
            size: 319488,
            updatedTime: 2000,
            kind: "pdf",
            ocrStatus: "done",
            ocrText: "THAMES WATER LIMITED Total GBP 486.20",
          },
        ]);
      }
      if (call.path === `/api/notes/${noteBId}/attachments`) {
        return jsonResponse([
          {
            id: resBId,
            title: "scan.pdf",
            filename: "scan.pdf",
            mime: "application/pdf",
            fileExtension: "pdf",
            size: 319488,
            updatedTime: 4000,
            kind: "pdf",
            ocrStatus: "done",
            ocrText: "THAMES WATER LlMITED Total GBP 486.20",
          },
        ]);
      }
      if (call.method === "POST" && call.path === "/api/organize/hygiene/resolve") {
        return jsonResponse({
          keepNoteId: noteAId,
          trashedNoteIds: [noteBId],
          mergedTags: ["tax-2024"],
          results: [{ id: noteBId, status: "ok" }],
        });
      }
      if (call.method === "POST" && call.path === "/api/organize/hygiene/dismiss") {
        return jsonResponse({ dismissedCount: 1, dismissedPairs: [`${noteCId}:${noteDId}`] });
      }
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        const body = (call.body ?? {}) as { items?: Array<{ id: string }> };
        return jsonResponse((body.items ?? []).map((item) => ({ id: item.id, status: "ok", addedTags: [] })));
      }
      return undefined;
    });

    renderWithProviders(
      <Routes>
        <Route path="/hygiene" element={<HygienePage />} />
      </Routes>,
      { route: "/hygiene" }
    );

    expect(await screen.findByText("Possible Duplicates (2)")).toBeTruthy();

    // Open Compare on the first cluster
    const compareButtons = screen.getAllByRole("button", { name: "Compare" });
    fireEvent.click(compareButtons[0]);

    // Verify side-by-side panes and OCR word diff render
    expect(await screen.findByTestId("compare-pane-left")).toBeTruthy();
    expect(screen.getByTestId("compare-pane-right")).toBeTruthy();
    const diffBox = await screen.findByTestId("compare-word-diff");
    await waitFor(() => expect(diffBox.textContent).toContain("LlMITED"));

    // Resolve cluster (mergeTags checkbox defaults to true)
    fireEvent.click(screen.getByRole("button", { name: "Keep left, trash other" }));
    await waitFor(() => {
      const resolveCall = calls.find((c) => c.method === "POST" && c.path === "/api/organize/hygiene/resolve");
      expect(resolveCall).toBeTruthy();
      expect(resolveCall!.body).toEqual({
        keepNoteId: noteAId,
        trashNoteIds: [noteBId],
        mergeTags: true,
      });
    });

    // Dismiss the near cluster as "Not duplicates"
    const dismissButtons = screen.getAllByRole("button", { name: "Not duplicates" });
    fireEvent.click(dismissButtons[1]);
    await waitFor(() => {
      const dismissCall = calls.find((c) => c.method === "POST" && c.path === "/api/organize/hygiene/dismiss");
      expect(dismissCall).toBeTruthy();
      expect(dismissCall!.body).toEqual({ noteIds: [noteCId, noteDId] });
    });

    // Bulk trash identical copies only (shows confirmation with exact count = 1, never touches near cluster)
    fireEvent.click(screen.getByRole("button", { name: /Trash all identical copies \(1\)/ }));
    expect(await screen.findByText("Trash all identical copies?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trash 1 identical copy" }));
    await waitFor(() => {
      const trashCall = calls.find((c) => {
        if (c.method !== "POST" || c.path !== "/api/notes/batch") return false;
        const parsed = (c.body ?? {}) as { trash?: boolean };
        return parsed.trash === true;
      });
      expect(trashCall).toBeTruthy();
      const parsed = (trashCall!.body ?? {}) as { items: Array<{ id: string }> };
      expect(parsed.items.map((i) => i.id)).toEqual([noteBId]);
    });
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
