import { describe, it, expect } from "vitest";
import {
  validateCommand,
  shellQuoteArg,
  shellJoin,
} from "../src/exec.js";

describe("validateCommand", () => {
  it("allows safe commands", () => {
    expect(() => validateCommand("ls -la")).not.toThrow();
    expect(() => validateCommand("npm test")).not.toThrow();
    expect(() => validateCommand("rm -rf ./node_modules")).not.toThrow();
  });

  it("blocks rm -rf /", () => {
    expect(() => validateCommand("rm -rf /")).toThrow("BLOCKED");
  });

  it("blocks rm -rf /*", () => {
    expect(() => validateCommand("rm -rf /*")).toThrow("BLOCKED");
  });

  it("blocks mkfs", () => {
    expect(() => validateCommand("mkfs.ext4 /dev/sda")).toThrow("BLOCKED");
  });

  it("blocks dd to device", () => {
    expect(() =>
      validateCommand("dd if=/dev/zero of=/dev/sda"),
    ).toThrow("BLOCKED");
  });

  it("blocks fork bomb", () => {
    expect(() => validateCommand(":(){ :|:& };:")).toThrow("BLOCKED");
  });

  it("blocks git force push", () => {
    expect(() =>
      validateCommand("git push --force origin main"),
    ).toThrow("BLOCKED");
  });
});

describe("shellQuoteArg / shellJoin", () => {
  it("leaves safe arguments unchanged", () => {
    expect(shellQuoteArg("ls")).toBe("ls");
    expect(shellQuoteArg("/path/to/file.txt")).toBe("/path/to/file.txt");
  });

  it("quotes arguments with spaces", () => {
    expect(shellQuoteArg("a b")).toBe("'a b'");
  });

  it("escapes single quotes inside arguments", () => {
    expect(shellQuoteArg("it's")).toBe("'it'\\''s'");
  });

  it("joins mixed arguments correctly", () => {
    expect(shellJoin(["echo", "a b", "it's"])).toBe(
      "echo 'a b' 'it'\\''s'",
    );
  });
});
