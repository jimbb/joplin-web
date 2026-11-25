import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { mockFetch } from "@/test/fetch-mock";
import { NoteEditor } from "./NoteEditor";

// Controls whether the dynamic import of the Rich editor chunk fails (as for a tab opened before a deployment)
const chunk = vi.hoisted(() => ({ fail: true }));
vi.mock("./RichEditor", () => {
  if (chunk.fail) throw new Error("Failed to fetch dynamically imported module");
  return { RichEditor: () => <div>Rich editor loaded</div> };
});
// CodeMirror needs layout APIs jsdom lacks; a textarea stands in for it
vi.mock("./MarkdownEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    UPLOAD_PLACEHOLDER: /$^/g,
    MarkdownEditor: forwardRef<unknown, { value: string; onChange: (v: string) => void }>(function MarkdownEditor(
      { value, onChange },
      ref
    ) {
      void ref;
      return <textarea aria-label="Note body" value={value} onChange={(e) => onChange(e.target.value)} />;
    }),
  };
});
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const note: Note = {
  id: "0123456789abcdef0123456789abcdef",
  title: "Shopping list",
  body: "Server text",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Personal",
  tags: [],
  isTodo: false,
  todoCompleted: false,
  markupLanguage: 1,
};

function renderEditor() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteEditor note={note} onDone={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("joplin-editor-mode", "split");
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  mockFetch(() => undefined);
  // React logs caught render errors; keep the test output readable
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The tests share the module-level lazy Rich editor, so they run in order
describe("NoteEditor when the Rich editor chunk fails to load", () => {
  it("keeps the editor open and offers Edit instead", async () => {
    chunk.fail = true;
    renderEditor();
    fireEvent.change(screen.getByLabelText("Note body"), { target: { value: "Unsaved text" } });

    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    expect(await screen.findByText("Rich editor could not be loaded")).toBeTruthy();
    // The rest of the editor is still there
    expect(screen.getByLabelText("Note title")).toHaveProperty("value", "Shopping list");
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Edit" }));
    expect(screen.queryByText("Rich editor could not be loaded")).toBeNull();
    expect(screen.getByLabelText("Note body")).toHaveProperty("value", "Unsaved text");
    expect(localStorage.getItem("joplin-editor-mode")).toBe("edit");
  });

  it("reloads the page when the fresh import fails as well", async () => {
    chunk.fail = true;
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    await screen.findByText("Rich editor could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Rich editor could not be loaded");
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("loads the Rich editor on Retry once the chunk is reachable again", async () => {
    chunk.fail = true;
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    await screen.findByText("Rich editor could not be loaded");

    chunk.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Rich editor loaded")).toBeTruthy();
  });
});
