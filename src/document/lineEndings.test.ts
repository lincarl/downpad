import { describe, it, expect } from "vitest";
import { stripBom, detectEol, normalizeToLf, applyEol } from "./lineEndings";

describe("stripBom", () => {
  it("removes a leading BOM and reports it", () => {
    expect(stripBom("﻿hello")).toEqual(["hello", true]);
  });
  it("leaves BOM-less text untouched", () => {
    expect(stripBom("hello")).toEqual(["hello", false]);
  });
});

describe("detectEol", () => {
  it("detects CRLF when dominant", () => {
    expect(detectEol("a\r\nb\r\nc")).toBe("crlf");
  });
  it("detects LF when dominant", () => {
    expect(detectEol("a\nb\nc")).toBe("lf");
  });
  it("defaults to LF for single-line / markerless text", () => {
    expect(detectEol("no newlines here")).toBe("lf");
  });
  it("resolves a tie toward CRLF", () => {
    expect(detectEol("a\r\nb\nc")).toBe("crlf");
  });
});

describe("normalizeToLf / applyEol round-trip", () => {
  it("CRLF text round-trips byte-for-byte", () => {
    const original = "# Title\r\n\r\nBody line\r\n";
    const lf = normalizeToLf(original);
    expect(lf).toBe("# Title\n\nBody line\n");
    expect(applyEol(lf, "crlf")).toBe(original);
  });
  it("LF text stays LF", () => {
    const original = "a\nb\n";
    expect(applyEol(normalizeToLf(original), "lf")).toBe(original);
  });
  it("normalizes lone CR and mixed endings to LF", () => {
    expect(normalizeToLf("a\rb\r\nc\nd")).toBe("a\nb\nc\nd");
  });
});
