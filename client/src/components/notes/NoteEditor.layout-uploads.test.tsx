import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { NoteEditor } from "./NoteEditor";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
// Desktop width, so Split is available
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const RESOURCE_ID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

const newNote: Note = {
  id: NOTE_ID,
  title: "",
  body: "",
  updatedTime: 1000,
  createdTime: 1000,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Work",
  tags: [],
  isTodo: false,
  todoCompleted: false,
  markupLanguage: 1,
};

/** Upload and save endpoints; the upload answers only once `release` is called */
function mockServer(note: Note) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls = mockFetch(async (call: FetchCall) => {
    if (call.method === "POST" && call.path === "/api/resources") {
      await gate;
      return jsonResponse({ id: RESOURCE_ID, title: "report.pdf", mime: "application/pdf", size: 8 }, 201);
    }
    if (call.method === "PUT" && call.path === `/api/notes/${NOTE_ID}`) {
      return jsonResponse({ ...note, ...(call.body as object), updatedTime: 2000 });
    }
    return undefined;
  });
  return { calls, release };
}

function renderEditor(note: Note) {
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NoteEditor note={note} focusTitle onDone={onDone} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return onDone;
}

function attachPdf() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" })] } });
}

const richContent = () =>
  waitFor(() => {
    const el = document.querySelector(".rich-editor-content");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });

async function savedBody(calls: FetchCall[]) {
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  // TipTap ends its Markdown with blank lines
  return (calls.find((c) => c.method === "PUT")!.body as { body: string }).body.trimEnd();
}

// CodeMirror and ProseMirror measure text; jsdom has no layout
beforeAll(() => {
  const empty = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = vi.fn();
  if (!("elementFromPoint" in document)) {
    Object.defineProperty(document, "elementFromPoint", { value: () => null, configurable: true });
  }
});

beforeEach(() => {
  localStorage.clear();
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NoteEditor uploads across a layout switch", () => {
  it("links a file still uploading in Split once Rich has taken over", async () => {
    localStorage.setItem("joplin-editor-mode", "split");
    const { calls, release } = mockServer(newNote);
    renderEditor(newNote);

    attachPdf();
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("Uploading report.pdf…"));
    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    const rich = await richContent();
    expect(rich.textContent).toContain("Uploading report.pdf…");
    // Formatting in Rich rewrites the whole text; the placeholder has to survive that
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);

    release();
    await waitFor(() => expect(rich.querySelector("a")?.textContent).toBe("report.pdf"));
    expect(rich.querySelector("a")?.getAttribute("href")).toBe(`/joplin-item/${RESOURCE_ID}`);
    expect(rich.textContent).not.toContain("Uploading");

    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", false));
    expect(await savedBody(calls)).toBe(`## [report.pdf](:/${RESOURCE_ID})`);
  });

  it("drops the placeholder of a failed upload after the switch", async () => {
    localStorage.setItem("joplin-editor-mode", "split");
    const note = { ...newNote, body: "Intro" };
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => (fail = resolve));
    const calls = mockFetch(async (call) => {
      if (call.path === "/api/resources") {
        await gate;
        return jsonResponse({ error: "Upload too large" }, 413);
      }
      if (call.method === "PUT") return jsonResponse({ ...note, ...(call.body as object), updatedTime: 2000 });
      return undefined;
    });
    const onDone = renderEditor(note);

    attachPdf();
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("Uploading report.pdf…"));
    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    const rich = await richContent();

    fail();
    await waitFor(() => expect(rich.textContent).toBe("Intro"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", false));
    // Back to the text the server has: nothing to save
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("links a file still uploading in Rich at the end of the text after switching to Edit", async () => {
    localStorage.setItem("joplin-editor-mode", "rich");
    const note = { ...newNote, title: "Report", body: "Intro" };
    const { calls, release } = mockServer(note);
    renderEditor(note);

    await richContent();
    attachPdf();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/resources")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(document.querySelector(".cm-content")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);

    release();
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain(`[report.pdf](:/${RESOURCE_ID})`));
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", false));
    expect(await savedBody(calls)).toBe(`Intro\n\n[report.pdf](:/${RESOURCE_ID})`);
  });
});
