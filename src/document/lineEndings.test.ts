import { describe, it, expect } from "vitest";
import { stripBom, normalizeToLf } from "./lineEndings";

describe("stripBom", () => {
  it("removes a leading BOM and reports it", () => {
    expect(stripBom("﻿hello")).toEqual(["hello", true]);
  });
  it("leaves BOM-less text untouched", () => {
    expect(stripBom("hello")).toEqual(["hello", false]);
  });
});

describe("normalizeToLf", () => {
  it("converts CRLF text to LF", () => {
    expect(normalizeToLf("# Title\r\n\r\nBody line\r\n")).toBe("# Title\n\nBody line\n");
  });
  it("leaves LF text unchanged", () => {
    expect(normalizeToLf("a\nb\n")).toBe("a\nb\n");
  });
  it("normalizes lone CR and mixed endings to LF", () => {
    expect(normalizeToLf("a\rb\r\nc\nd")).toBe("a\nb\nc\nd");
  });
});
