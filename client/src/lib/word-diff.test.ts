import { describe, expect, it } from "vitest";
import { buildComparableText, diffWords } from "./word-diff";

describe("diffWords", () => {
  it("reports identical text with no added or removed words", () => {
    const res = diffWords("Total Annual Charge: GBP 486.20", "Total Annual Charge: GBP 486.20");
    expect(res.identical).toBe(true);
    expect(res.addedWords).toBe(0);
    expect(res.removedWords).toBe(0);
    expect(res.segments).toEqual([{ kind: "equal", text: "Total Annual Charge: GBP 486.20" }]);
  });

  it("highlights word-level OCR typos while preserving unchanged context", () => {
    const res = diffWords(
      "THAMES WATER UTILITIES LIMITED calculated on actual reading",
      "THAMES WATER UTILITIES LlMITED calculaled on actual reading"
    );
    expect(res.identical).toBe(false);
    expect(res.removedWords).toBe(2);
    expect(res.addedWords).toBe(2);
    expect(res.segments.some((s) => s.kind === "removed" && s.text.includes("LIMITED"))).toBe(true);
    expect(res.segments.some((s) => s.kind === "added" && s.text.includes("LlMITED"))).toBe(true);
    expect(res.segments.some((s) => s.kind === "equal" && s.text.includes("THAMES WATER"))).toBe(true);
  });

  it("handles insertions and deletions cleanly", () => {
    const res = diffWords("one two three four", "one two extra three");
    expect(res.addedWords).toBe(1);
    expect(res.removedWords).toBe(1);
    expect(res.segments.some((s) => s.kind === "added" && s.text.includes("extra"))).toBe(true);
    expect(res.segments.some((s) => s.kind === "removed" && s.text.includes("four"))).toBe(true);
  });
});

describe("buildComparableText", () => {
  it("strips linked resource markdown links and appends attachment OCR text", () => {
    const resId = "a".repeat(32);
    const text = buildComparableText(`[scan_001.pdf](:/${resId})`, [
      { id: resId, ocrText: "INVOICE #42\nTotal: $120.00" },
    ]);
    expect(text).toBe("INVOICE #42\nTotal: $120.00");
  });

  it("combines non-attachment body text with attachment OCR text", () => {
    const resId = "b".repeat(32);
    const text = buildComparableText(`Filed copy.\n\n[receipt.pdf](:/${resId})`, [
      { id: resId, ocrText: "Paid in full" },
    ]);
    expect(text).toBe("Filed copy.\n\nPaid in full");
  });

  it("handles pathological unclosed resource links in linear time", () => {
    const resId = "c".repeat(32);
    const startedAt = performance.now();
    const text = buildComparableText(`${`<a href=":/${resId}">`.repeat(15_000)}${"![".repeat(20_000)}`, [
      { id: resId, ocrText: "ok" },
    ]);
    expect(text).toContain("ok");
    expect(performance.now() - startedAt).toBeLessThan(300);
  });
});
