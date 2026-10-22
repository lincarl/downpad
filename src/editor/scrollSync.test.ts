// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mirroredScrollTop, ScrollSync } from "./scrollSync";

describe("mirroredScrollTop", () => {
  it("maps the source's fractional position onto the destination's range", () => {
    // Source 50% down a 1000px range; destination range is 400px → 200px.
    const top = mirroredScrollTop(
      { scrollTop: 500, scrollHeight: 2000, clientHeight: 1000 },
      { scrollHeight: 1400, clientHeight: 1000 },
    );
    expect(top).toBe(200);
  });

  it("maps the extremes exactly (top → 0, bottom → destination max)", () => {
    const src = { scrollHeight: 2000, clientHeight: 1000 };
    const dst = { scrollHeight: 1600, clientHeight: 1000 }; // max = 600
    expect(mirroredScrollTop({ ...src, scrollTop: 0 }, dst)).toBe(0);
    expect(mirroredScrollTop({ ...src, scrollTop: 1000 }, dst)).toBe(600);
  });

  it("returns 0 when the source cannot scroll (content fits)", () => {
    expect(
      mirroredScrollTop(
        { scrollTop: 0, scrollHeight: 500, clientHeight: 1000 },
        { scrollHeight: 2000, clientHeight: 1000 },
      ),
    ).toBe(0);
  });

  it("returns 0 when the destination cannot scroll (content fits)", () => {
    expect(
      mirroredScrollTop(
        { scrollTop: 500, scrollHeight: 2000, clientHeight: 1000 },
        { scrollHeight: 800, clientHeight: 1000 },
      ),
    ).toBe(0);
  });

  it("never exceeds the destination range even if the source is over-scrolled", () => {
    const top = mirroredScrollTop(
      { scrollTop: 5000, scrollHeight: 2000, clientHeight: 1000 }, // ratio > 1
      { scrollHeight: 1600, clientHeight: 1000 }, // max = 600
    );
    expect(top).toBe(600);
  });
});

describe("ScrollSync", () => {
  // jsdom does no layout, so fake a scroll container whose scrollTop is a real
  // stored (and clamped) value and whose scroll metrics we control. Every write
  // to scrollTop is counted (`__writes`) so a test can assert that an echo did
  // NOT write back — a value-equality check can't, since the fractional mapping
  // is a fixed point on the round trip (A→B→A returns A's exact position).
  function fakePane(scrollHeight: number, clientHeight: number): HTMLElement {
    const el = document.createElement("div");
    let top = 0;
    let writes = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        writes += 1;
        top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
      },
    });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
    Object.defineProperty(el, "__writes", { configurable: true, get: () => writes });
    return el;
  }

  const writesOf = (el: HTMLElement): number => (el as unknown as { __writes: number }).__writes;

  const fireScroll = (el: HTMLElement): void => {
    el.dispatchEvent(new Event("scroll"));
  };

  let sync: ScrollSync;

  beforeEach(() => {
    vi.useFakeTimers();
    sync = new ScrollSync();
  });

  afterEach(() => {
    sync.disconnect();
    vi.useRealTimers();
  });

  it("mirrors a scroll in pane A into pane B proportionally", () => {
    const a = fakePane(2000, 1000); // max 1000
    const b = fakePane(1400, 1000); // max 400
    sync.connect(a, b);

    a.scrollTop = 500; // 50%
    fireScroll(a);

    expect(b.scrollTop).toBe(200); // 50% of 400
  });

  it("mirrors both directions (B drives A) once the driver lock releases", () => {
    const a = fakePane(2000, 1000); // max 1000
    const b = fakePane(1400, 1000); // max 400
    sync.connect(a, b);

    a.scrollTop = 1000; // bottom
    fireScroll(a);
    expect(b.scrollTop).toBe(400);

    vi.advanceTimersByTime(200); // let A's driver lock release

    b.scrollTop = 100; // 25%
    fireScroll(b);
    expect(a.scrollTop).toBe(250); // 25% of 1000
  });

  it("ignores the mirrored pane's echo so the panes don't fight", () => {
    const a = fakePane(2000, 1000); // max 1000
    const b = fakePane(1400, 1000); // max 400
    sync.connect(a, b);

    a.scrollTop = 600; // 60%, set by the user (counts as 1 write to A)
    fireScroll(a); // A drives → B mirrored (write to B)
    expect(b.scrollTop).toBe(240); // 60% of 400

    // The browser now fires B's scroll event (the echo of the line above). While A
    // is still the driver it must be DROPPED — i.e. cause NO write back to A. A
    // value check can't prove this (the round trip is a fixed point: B's 60% maps
    // back to A's exact 600), so assert A is never written by the echo.
    const aWritesBefore = writesOf(a);
    fireScroll(b);
    expect(writesOf(a)).toBe(aWritesBefore); // guard dropped the echo: no write to A
    expect(a.scrollTop).toBe(600);
  });

  it("suppressNext drops the next scroll so an app-originated scroll can't drive", () => {
    const a = fakePane(2000, 1000); // max 1000
    const b = fakePane(1400, 1000); // max 400
    sync.connect(a, b);

    // e.g. Find's scrollIntoView scrolls the document pane programmatically.
    sync.suppressNext();
    a.scrollTop = 1000;
    fireScroll(a);
    expect(b.scrollTop).toBe(0); // not mirrored — the raw pane stays put

    // The window expires; a genuine user scroll afterwards syncs normally.
    vi.advanceTimersByTime(200);
    a.scrollTop = 500;
    fireScroll(a);
    expect(b.scrollTop).toBe(200);
  });

  it("stops mirroring after disconnect", () => {
    const a = fakePane(2000, 1000);
    const b = fakePane(1400, 1000);
    sync.connect(a, b);
    sync.disconnect();

    a.scrollTop = 500;
    fireScroll(a);
    expect(b.scrollTop).toBe(0); // untouched
  });

  it("rewires to a new pair, dropping the old listeners", () => {
    const a = fakePane(2000, 1000);
    const b = fakePane(1400, 1000);
    sync.connect(a, b);

    const c = fakePane(2000, 1000);
    const d = fakePane(1400, 1000);
    sync.connect(c, d);

    // The old pair no longer syncs.
    a.scrollTop = 500;
    fireScroll(a);
    expect(b.scrollTop).toBe(0);

    // The new pair does.
    c.scrollTop = 500;
    fireScroll(c);
    expect(d.scrollTop).toBe(200);
  });

  it("is idempotent for the same pair (no duplicate mirroring)", () => {
    const a = fakePane(2000, 1000);
    const b = fakePane(1400, 1000);
    sync.connect(a, b);
    sync.connect(a, b); // again — must not double-bind

    const before = writesOf(b);
    a.scrollTop = 500;
    fireScroll(a);
    expect(b.scrollTop).toBe(200);
    expect(writesOf(b) - before).toBe(1);
  });
});
