import { describe, it, expect } from "vitest";
import { truncateHeadTail, DEFAULT_MAX_OUTPUT_CHARS } from "../src/output.js";

describe("truncateHeadTail", () => {
  it("returns short text unchanged", () => {
    const result = truncateHeadTail("hello world");
    expect(result.text).toBe("hello world");
    expect(result.truncated).toBe(false);
  });

  it("does not truncate text exactly at the limit", () => {
    const text = "a".repeat(DEFAULT_MAX_OUTPUT_CHARS);
    const result = truncateHeadTail(text);
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
  });

  it("truncates long text head+tail and reports omitted chars", () => {
    const text = "a".repeat(30_000) + "MIDDLE" + "b".repeat(30_000);
    const result = truncateHeadTail(text, 50_000);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[... truncated");
    expect(result.text).toContain("a".repeat(100)); // head preserved
    expect(result.text).toContain("b".repeat(100)); // tail preserved
    expect(result.text).not.toContain("MIDDLE");
    expect(result.text.length).toBeLessThanOrEqual(
      DEFAULT_MAX_OUTPUT_CHARS + 100,
    );
  });

  it("preserves odd limits correctly", () => {
    const text = "x".repeat(100);
    const result = truncateHeadTail(text, 51);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("x")).toBe(true);
    expect(result.text.endsWith("x")).toBe(true);
  });
});
