import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Notebook } from "@/lib/types";
import { NewOrganizeJobDialog } from "./NewOrganizeJobDialog";

const id = (value: string) => value.repeat(32);
const notebooks: Notebook[] = [{ id: id("1"), title: "Pending", parentId: "", children: [], noteCount: 4 }];

afterEach(cleanup);

describe("NewOrganizeJobDialog", () => {
  it("shows the server dry-run count before continuing", () => {
    const onConfirm = vi.fn();
    render(<NewOrganizeJobDialog open onOpenChange={vi.fn()} notebooks={notebooks} matched={17} onConfirm={onConfirm} />);
    expect(screen.getByText("17")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConfirm).toHaveBeenCalledWith({ sourceNotebookIds: [], mode: "organize", includeSubNotebooks: true });
  });

  it("selects retitle mode and leaves target exclusions to the next confirmation", () => {
    const onConfirm = vi.fn();
    render(<NewOrganizeJobDialog open onOpenChange={vi.fn()} notebooks={notebooks} matched={2} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText("Retitle only"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConfirm).toHaveBeenCalledWith({ sourceNotebookIds: [], mode: "retitle", includeSubNotebooks: true });
  });
});
