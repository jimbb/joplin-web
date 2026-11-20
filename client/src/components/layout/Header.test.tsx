import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { Header } from "./Header";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", logout: vi.fn() }),
}));

afterEach(cleanup);

describe("Header search field", () => {
  it("keeps focus when a page hands the query over and the header remounts mid-typing", () => {
    const { rerender } = renderWithProviders(<Header key="home" searchQuery="f" onSearchChange={vi.fn()} />);
    screen.getByRole("searchbox", { name: "Search notes" }).focus();

    rerender(<Header key="notes" searchQuery="fl" onSearchChange={vi.fn()} />);
    const input = screen.getByRole("searchbox", { name: "Search notes" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
  });

  it("doesn't grab focus on remount when the search field wasn't focused", () => {
    const { rerender } = renderWithProviders(<Header key="a" searchQuery="fl" onSearchChange={vi.fn()} />);
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(<Header key="b" searchQuery="fl" onSearchChange={vi.fn()} />);
    expect(document.activeElement).not.toBe(screen.getByRole("searchbox", { name: "Search notes" }));
  });
});
