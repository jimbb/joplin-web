import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ScanStatus } from "@/lib/types";
import { getScans } from "@/lib/api";
import { toast } from "sonner";
import { scanRefetchInterval, useScans } from "./use-scans";

vi.mock("@/lib/api", () => ({ getScans: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
const refresh = vi.fn(() => Promise.resolve(true));
vi.mock("@/hooks/use-connection", () => ({ useRefresh: () => ({ refresh, isRefreshing: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const mockedGetScans = vi.mocked(getScans);
const mockedToast = vi.mocked(toast.success);
const id = "0123456789abcdef0123456789abcdef";
const now = new Date().toISOString();
const job = (stage: "received" | "done") => ({
  id: "scan-1",
  name: "scan.pdf",
  size: 10,
  stage,
  receivedAt: now,
  updatedAt: now,
  doneAt: stage === "done" ? now : null,
  noteId: id,
  resourceId: null,
  pages: null,
  page: null,
  error: null,
  queuePosition: null,
  stalled: false,
});
const active: ScanStatus = { enabled: true, available: true, active: 1, cycle: { phase: "ocr", running: true, startedAt: now, phaseAt: now, finishedAt: null, result: null, ocrTotal: 1, ocrDone: 0, nextRunAt: null }, jobs: [job("received")], recent: [] };
const idle: ScanStatus = { ...active, active: 0, cycle: { ...active.cycle!, running: false }, jobs: [], recent: [] };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}

describe("useScans", () => {
  it("selects 3-second, 30-second, and disabled polling intervals", () => {
    expect(scanRefetchInterval(active)).toBe(3_000);
    expect(scanRefetchInterval(idle)).toBe(30_000);
    expect(scanRefetchInterval({ enabled: false })).toBe(false);
  });

  it("stops polling when the server disables scan status", async () => {
    mockedGetScans.mockResolvedValue({ enabled: false });
    renderHook(() => useScans(), { wrapper });
    await waitFor(() => expect(mockedGetScans).toHaveBeenCalledTimes(1));
    expect(scanRefetchInterval({ enabled: false })).toBe(false);
  });

  it("does nothing on first load, then refreshes and toasts once for a done transition", async () => {
    mockedGetScans.mockResolvedValue(active);
    const { result } = renderHook(() => useScans(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(active));
    expect(refresh).not.toHaveBeenCalled();
    expect(mockedToast).not.toHaveBeenCalled();
    const done: ScanStatus = { ...idle, recent: [job("done")] };
    mockedGetScans.mockResolvedValueOnce(done);
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(mockedToast).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.refetch(); });
    expect(mockedToast).toHaveBeenCalledTimes(1);
  });

  it("does not toast when the first answer already contains a done job", async () => {
    mockedGetScans.mockResolvedValue({ ...idle, recent: [job("done")] });
    renderHook(() => useScans(), { wrapper });
    await waitFor(() => expect(mockedGetScans).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
    expect(mockedToast).not.toHaveBeenCalled();
  });
});
