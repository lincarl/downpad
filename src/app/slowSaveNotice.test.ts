import { expect, it } from "vitest";
import { createAppStore } from "./createAppStore";
import { SlowSaveNotice } from "./slowSaveNotice";

const message = "Saving “notes.md” has not finished after 10 seconds. Its drive may not be answering. To close it without waiting, close it and choose Discard.";

it("names the document and goes when its write ends, but not when another tab's write ends", () => {
  const store = createAppStore();
  const notice = new SlowSaveNotice(store);
  notice.show("tab-1", "notes.md");
  expect(store.get().banner).toEqual({ kind: "info", message });
  notice.takeDown("tab-2");
  expect(store.get().banner?.message).toBe(message);
  notice.takeDown("tab-1");
  expect(store.get().banner).toBeNull();
});

it("never takes the place of another notice, and leaves a notice that replaced it", () => {
  const store = createAppStore();
  const notice = new SlowSaveNotice(store);
  const changed = { kind: "file-changed" as const, message: "This file changed on disk.", actions: [{ id: "reload", label: "Reload" }] };
  store.set({ banner: changed });
  notice.show("tab-1", "notes.md");
  expect(store.get().banner).toBe(changed);

  store.set({ banner: null });
  notice.show("tab-1", "notes.md");
  const failure = { kind: "error" as const, message: "Downpad could not save “notes.md”." };
  store.set({ banner: failure });
  notice.takeDown("tab-1");
  expect(store.get().banner).toBe(failure);
});

it("replaces its own notice for another document", () => {
  const store = createAppStore();
  const notice = new SlowSaveNotice(store);
  notice.show("tab-1", "notes.md");
  notice.show("tab-2", "other.md");
  expect(store.get().banner?.message).toContain("“other.md”");
  notice.takeDown("tab-1");
  expect(store.get().banner?.message).toContain("“other.md”");
  notice.takeDown("tab-2");
  expect(store.get().banner).toBeNull();
});
