import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Notebook } from "@/lib/types";
import { NotebookCheckTree } from "./NotebookCheckTree";

const id = (c: string) => c.repeat(32);

const notebooks: Notebook[] = [
  { id: id("1"), title: "Pending to sort", parentId: "", children: [], noteCount: 12 },
  {
    id: id("2"),
    title: "Personal",
    parentId: "",
    noteCount: 1,
    children: [
      {
        id: id("3"),
        title: "Bank",
        parentId: id("2"),
        noteCount: 5,
        children: [{ id: id("4"), title: "OMYCard", parentId: id("3"), children: [], noteCount: 9 }],
      },
    ],
  },
  {
    id: id("5"),
    title: "Vault",
    parentId: "",
    noteCount: 2,
    encrypted: true,
    children: [{ id: id("6"), title: "Readable", parentId: id("5"), children: [], noteCount: 1 }],
  },
];

afterEach(cleanup);

const renderTree = (props: Partial<Parameters<typeof NotebookCheckTree>[0]> = {}) =>
  render(
    <NotebookCheckTree notebooks={notebooks} checkedIds={new Set()} onToggle={vi.fn()} aria-label="Notebooks" {...props} />
  );

describe("NotebookCheckTree", () => {
  it("starts collapsed and expands or collapses one notebook at a time", () => {
    renderTree();
    expect(screen.getByRole("checkbox", { name: /Personal/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Bank/ })).toBeNull();

    const expand = screen.getByRole("button", { name: "Expand Personal" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(screen.getByRole("checkbox", { name: /Bank/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /OMYCard/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Bank" }));
    expect(screen.getByRole("checkbox", { name: /OMYCard/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Personal" }));
    expect(screen.queryByRole("checkbox", { name: /Bank/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /OMYCard/ })).toBeNull();
  });

  it("expands and collapses everything at once", () => {
    renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("checkbox", { name: /OMYCard/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("checkbox", { name: /Bank/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeTruthy();
  });

  it("opens the ancestors of notebooks checked on mount", () => {
    renderTree({ checkedIds: new Set([id("4")]) });
    const card = screen.getByRole("checkbox", { name: /OMYCard/ }) as HTMLInputElement;
    expect(card.checked).toBe(true);
    expect(screen.getByRole("button", { name: "Collapse Personal" })).toBeTruthy();
  });

  it("lists nested matches flat while filtering and passes toggles through", () => {
    const onToggle = vi.fn();
    renderTree({ filter: "omy", onToggle });
    expect(screen.queryByRole("button", { name: /Expand/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Personal/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /OMYCard/ }));
    expect(onToggle).toHaveBeenCalledWith(id("4"));

    cleanup();
    renderTree({ filter: "nothing like this" });
    expect(screen.getByText("No matching notebooks")).toBeTruthy();
  });

  it("hides encrypted notebooks but keeps their readable children and shows row meta", () => {
    renderTree({ meta: (nb) => nb.noteCount });
    expect(screen.queryByRole("checkbox", { name: /Vault/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Readable/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Pending to sort/ }).closest("label")?.textContent).toContain("12");
  });
});
