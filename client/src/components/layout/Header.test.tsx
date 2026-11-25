import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { Header } from "./Header";
import { useScans } from "@/hooks/use-scans";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", logout: vi.fn() }),
}));
vi.mock("@/hooks/use-scans", () => ({ useScans: vi.fn() }));

const mockedUseScans = vi.mocked(useScans);

afterEach(cleanup);

beforeEach(() => {
  mockedUseScans.mockReturnValue({ data: undefined } as never);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: query.includes("max-width") && window.innerWidth < 768, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
});

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

describe("scan queue control", () => {
  it("stays hidden when scan status is disabled", () => {
    renderWithProviders(<Header searchQuery="" onSearchChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Scan queue/ })).toBeNull();
  });

  it("shows the active badge count", () => {
    mockedUseScans.mockReturnValue({ data: { enabled: true, active: 2, jobs: [], recent: [] } } as never);
    renderWithProviders(<Header searchQuery="" onSearchChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Scan queue, 2 in progress" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan queue, 2 in progress" }).textContent).toContain("2");
  });
});
