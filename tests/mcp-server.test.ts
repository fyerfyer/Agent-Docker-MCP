import { describe, it, expect } from "vitest";
import { isValidEnvName } from "../src/mcp-server.js";

describe("isValidEnvName", () => {
  it("accepts valid names", () => {
    expect(isValidEnvName("PATH")).toBe(true);
    expect(isValidEnvName("_X1")).toBe(true);
    expect(isValidEnvName("HOME_DIR_2")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidEnvName("$(x)")).toBe(false);
    expect(isValidEnvName("1ABC")).toBe(false);
    expect(isValidEnvName("A B")).toBe(false);
    expect(isValidEnvName("A;rm")).toBe(false);
    expect(isValidEnvName("")).toBe(false);
  });
});
