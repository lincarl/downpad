import { describe, expect, it } from "vitest";
import { keptTimes, listFiles, myVersionPath, timeAgo } from "./gitText";

describe("gitText", () => {
  it("says how long ago a change was", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    expect(timeAgo(now - 20_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(timeAgo(now - 26 * 60 * 60_000, now)).toBe("yesterday");
  });

  it("names when copies were kept by their local day and time, with the second only where the minute is shared", () => {
    const time = (day: number, hours: number, minutes: number, seconds = 0) => new Date(2026, 10, day, hours, minutes, seconds).getTime();
    expect(keptTimes([time(3, 9, 5), time(28, 23, 59)])).toEqual(["3 Nov, 09:05", "28 Nov, 23:59"]);
    expect(keptTimes([time(3, 9, 5, 41), time(3, 9, 5, 2), time(3, 9, 6)])).toEqual(["3 Nov, 09:05:41", "3 Nov, 09:05:02", "3 Nov, 09:06"]);
  });

  it("names the user's version beside the original", () => {
    expect(myVersionPath("/work/notes.md")).toBe("/work/notes (my version).md");
    expect(myVersionPath("C:\\work\\README")).toBe("C:\\work\\README (my version).md");
  });

  it("lists file names", () => {
    expect(listFiles(["/a/x.md", "/a/y.md"])).toBe("x.md and y.md");
    expect(listFiles(["/x.md", "/y.md", "/z.md", "/w.md"])).toBe("x.md, y.md and 2 more");
  });
});
