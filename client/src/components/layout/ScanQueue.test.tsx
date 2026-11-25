import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ScanJob, ScanStatus } from "@/lib/types";
import { renderWithProviders } from "@/test/render";
import { ScanQueueContent } from "./ScanQueue";

afterEach(cleanup);

const now = new Date().toISOString();
const job = (id: string, stage: ScanJob["stage"], extra: Partial<ScanJob> = {}): ScanJob => ({
  id,
  name: `${id}.pdf`,
  size: 1_024,
  stage,
  receivedAt: now,
  updatedAt: now,
  doneAt: null,
  noteId: null,
  resourceId: null,
  pages: null,
  page: null,
  error: null,
  queuePosition: null,
  stalled: false,
  ...extra,
});

const cycle = { phase: "ocr" as const, running: true, startedAt: now, phaseAt: now, finishedAt: null, result: null, ocrTotal: 3, ocrDone: 1, nextRunAt: null };

describe("ScanQueueContent", () => {
  it("renders each active stage, stalled status, and received import errors", () => {
    const status: ScanStatus = {
      enabled: true,
      available: true,
      active: 6,
      cycle,
      jobs: [
        job("received", "received", { error: "permission denied" }),
        job("importing", "importing"),
        job("queued", "queued", { queuePosition: 2 }),
        job("ocr", "ocr", { pages: 3, page: 2 }),
        job("syncing", "syncing"),
        job("stalled", "ocr", { stalled: true }),
      ],
      recent: [],
    };
    renderWithProviders(<ScanQueueContent status={status} />);
    expect(screen.getByText("Import failed, retrying on the next run")).toBeTruthy();
    expect(screen.getByText("Importing into Pending to sort")).toBeTruthy();
    expect(screen.getByText("Waiting for OCR, #2 in queue")).toBeTruthy();
    expect(screen.getByText("OCR page 2 of 3")).toBeTruthy();
    expect(screen.getByText("Uploading to Joplin Server")).toBeTruthy();
    expect(screen.getByText("Interrupted, continues on the next run")).toBeTruthy();
    expect(screen.getAllByText("OCR").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 3 attachments")).toBeTruthy();
  });

  it("marks completed steps separately from the current primary step", () => {
    renderWithProviders(<ScanQueueContent status={{ enabled: true, available: true, active: 1, cycle, jobs: [job("ocr", "ocr", { pages: 2, page: 1 })], recent: [] }} />);
    const importStep = screen.getByText("Import", { exact: true });
    const ocrStep = screen.getByText("OCR", { exact: true });
    expect(importStep.getAttribute("data-complete")).toBe("true");
    expect(ocrStep.getAttribute("data-complete")).toBe("false");
    expect(ocrStep.className).toContain("border-primary");
  });

  it("renders unavailable and all recent result variants", () => {
    const recent = [
      job("done", "done", { doneAt: now, noteId: "0123456789abcdef0123456789abcdef" }),
      job("error", "done", { doneAt: now, error: "OCR failed" }),
      job("skip", "skipped", { doneAt: now, error: "Not a document" }),
      job("failed", "failed", { doneAt: now, error: "Could not read file" }),
    ];
    renderWithProviders(<ScanQueueContent status={{ enabled: true, available: false, error: "down", active: 0, jobs: [], recent }} />);
    expect(screen.getByText("Scan status unavailable")).toBeTruthy();
    cleanup();
    renderWithProviders(<ScanQueueContent status={{ enabled: true, available: true, active: 0, cycle: { ...cycle, running: false }, jobs: [], recent }} />);
    expect(screen.getAllByText(/Ready,/).length).toBeGreaterThan(0);
    expect(screen.getByText("Ready, OCR failed")).toBeTruthy();
    expect(screen.getByText("Not a document, kept on the server")).toBeTruthy();
    expect(screen.getByText("Could not read file")).toBeTruthy();
  });
});
