import { describe, expect, it } from "vitest";
import { differingRuns, type Run } from "./differingRuns";

/** The runs in which the characters of `a` and `b` differ. */
const runs = (a: string, b: string, budget?: number): Run[] => differingRuns(a.length, b.length, (i, j) => a[i] === b[j], budget);

/** `a` with each run replaced by its part of `b`. */
function apply(a: string, b: string, found: Run[]): string {
  let out = "";
  let at = 0;
  for (const run of found) {
    out += a.slice(at, run.fromA) + b.slice(run.fromB, run.toB);
    at = run.toA;
  }
  return out + a.slice(at);
}

describe("differingRuns", () => {
  it("finds no run in equal lists", () => {
    expect(runs("abc", "abc")).toEqual([]);
    expect(runs("", "")).toEqual([]);
  });

  it("finds each place that changed as a run of its own", () => {
    expect(runs("aXbcdYe", "aZbcdWe")).toEqual([
      { fromA: 1, toA: 2, fromB: 1, toB: 2 },
      { fromA: 5, toA: 6, fromB: 5, toB: 6 },
    ]);
    expect(runs("abcdef", "Xabcdef")).toEqual([{ fromA: 0, toA: 0, fromB: 0, toB: 1 }]);
    expect(runs("abcdef", "abcef")).toEqual([{ fromA: 3, toA: 4, fromB: 3, toB: 3 }]);
  });

  it.each([
    ["abcabba", "cbabac"],
    ["kitten", "sitting"],
    ["- a\n- b\nx\n- c", "* a\n* b\nx\n* c"],
    ["abc", ""],
    ["", "abc"],
  ])("turns %j into %j", (a, b) => {
    expect(apply(a, b, runs(a, b))).toBe(b);
  });

  it("gives one run from the first difference to the last once the diff would take too long", () => {
    expect(runs("aXbcdYe", "aZbcdWe", 10)).toEqual([{ fromA: 1, toA: 6, fromB: 1, toB: 6 }]);
  });
});
