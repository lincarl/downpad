import { expect, it, vi } from "vitest";
import { CloseRequests } from "./closeRequests";

/** A close that waits until its signal aborts, as one whose save never returns. */
function waitingClose(steps: string[], name: string) {
  return (signal: AbortSignal) => new Promise<void>((resolve) => {
    steps.push(`${name} waits`);
    signal.addEventListener("abort", () => {
      steps.push(`${name} stops`);
      resolve();
    }, { once: true });
  });
}

it("lets a newer close take over from one that waits, after that one ended", async () => {
  const closes = new CloseRequests();
  const steps: string[] = [];
  const first = closes.run(waitingClose(steps, "first"));
  const second = closes.run(async () => { steps.push("second runs"); });
  await Promise.all([first, second]);
  expect(steps).toEqual(["first waits", "first stops", "second runs"]);
});

it("runs only the first of the closes asked for while one waits", async () => {
  const closes = new CloseRequests();
  const later = vi.fn(async () => {});
  const first = closes.run(waitingClose([], "first"));
  const second = closes.run(later);
  const third = closes.run(later);
  await Promise.all([first, second, third]);
  expect(later).toHaveBeenCalledOnce();
});

it("runs a close after one that failed, and leaves the failure to the close that failed", async () => {
  const closes = new CloseRequests();
  let fail!: (error: Error) => void;
  const failing = closes.run(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const next = vi.fn(async () => {});
  const following = closes.run(next);
  fail(new Error("Disk full"));
  await expect(failing).rejects.toThrow("Disk full");
  await following;
  expect(next).toHaveBeenCalledOnce();

  // Once nothing runs, a close runs at once with a signal that has not aborted.
  let aborted: boolean | undefined;
  await closes.run(async (signal) => { aborted = signal.aborted; });
  expect(aborted).toBe(false);
});
