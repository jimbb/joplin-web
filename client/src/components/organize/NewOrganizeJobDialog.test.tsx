import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Notebook } from "@/lib/types";
import { TITLE_DETAIL_STORAGE_KEY } from "@/lib/ui-constants";
import { NewOrganizeJobDialog } from "./NewOrganizeJobDialog";

const id = (value: string) => value.repeat(32);
const notebooks: Notebook[] = [{ id: id("1"), title: "Pending", parentId: "", children: [], noteCount: 4 }];

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("NewOrganizeJobDialog", () => {
  it("shows the server dry-run count and defaults to Standard title length before continuing", () => {
    const onConfirm = vi.fn();
    render(<NewOrganizeJobDialog open onOpenChange={vi.fn()} notebooks={notebooks} matched={17} onConfirm={onConfirm} />);
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Standard" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/PrimeCredit/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConfirm).toHaveBeenCalledWith({
      sourceNotebookIds: [],
      mode: "organize",
      includeSubNotebooks: true,
      titleDetail: "standard",
    });
  });

  it("selects retitle mode, remembers chosen title length in localStorage, and passes it on confirm", () => {
    const onConfirm = vi.fn();
    const { unmount } = render(
      <NewOrganizeJobDialog open onOpenChange={vi.fn()} notebooks={notebooks} matched={2} onConfirm={onConfirm} />
    );
    fireEvent.click(screen.getByLabelText("Retitle only"));
    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    expect(localStorage.getItem(TITLE_DETAIL_STORAGE_KEY)).toBe("detailed");
    expect(screen.getByText(/SA100/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConfirm).toHaveBeenCalledWith({
      sourceNotebookIds: [],
      mode: "retitle",
      includeSubNotebooks: true,
      titleDetail: "detailed",
    });

    // Re-mounting restores remembered level from localStorage
    unmount();
    render(<NewOrganizeJobDialog open onOpenChange={vi.fn()} notebooks={notebooks} matched={2} onConfirm={onConfirm} />);
    expect(screen.getByRole("button", { name: "Detailed" }).getAttribute("aria-pressed")).toBe("true");
  });
});
