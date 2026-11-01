import { test, expect, type Page } from "@playwright/test";
import type { RecentDataSource } from "../src/home/recentData";
import type { RecentEntry } from "../src/state/types";

interface FixtureEntry extends RecentEntry {
  exists: boolean;
  content: string;
  line: number;
}

declare global {
  interface Window {
    __recentCalls: {
      opened: string[];
      favorites: Array<Pick<RecentEntry, "path" | "favorite">>;
      removed: string[];
    };
  }
}

// Newest first, with name-only, content-only and overlapping search matches.
const ENTRIES: FixtureEntry[] = [
  { path: "C:/samples/report.md", lastOpenedMs: 5000, favorite: false, exists: true, content: "weekly plan overview", line: 19 },
  { path: "C:/samples/plan.md", lastOpenedMs: 4000, favorite: true, exists: true, content: "a plan for release", line: 7 },
  { path: "C:/samples/plan-archive.md", lastOpenedMs: 3000, favorite: false, exists: true, content: "archived milestones", line: 3 },
  { path: "C:/samples/plan/guide.md", lastOpenedMs: 2000, favorite: true, exists: true, content: "reference material", line: 1 },
  { path: "C:/samples/missing.md", lastOpenedMs: 1000, favorite: false, exists: false, content: "", line: 1 },
];

/** Mount the production view with synthetic data and record its external effects. */
async function mount(page: Page, entries = ENTRIES): Promise<void> {
  await page.goto("/e2e/recent-view.html");
  await page.evaluate(async (fixtures) => {
    window.__recentCalls = { opened: [], favorites: [], removed: [] };
    const byPath = new Map(fixtures.map((entry) => [entry.path, entry]));
    const data: RecentDataSource = {
      async list() {
        return Array.from(byPath.values(), ({ path, lastOpenedMs, favorite }) => ({ path, lastOpenedMs, favorite }));
      },
      async stat(paths) {
        return paths.map((path) => ({
          path,
          exists: byPath.get(path)?.exists ?? false,
          sizeBytes: 4096,
          folderExists: true,
        }));
      },
      async setFavorite(path, favorite) {
        window.__recentCalls.favorites.push({ path, favorite });
        const entry = byPath.get(path);
        if (entry) entry.favorite = favorite;
        return entry ?? null;
      },
      async remove(path) {
        window.__recentCalls.removed.push(path);
        byPath.delete(path);
      },
      async searchContents(_id, query, callbacks) {
        let matched = 0;
        for (const entry of byPath.values()) {
          if (entry.exists && entry.content.toLowerCase().includes(query.toLowerCase())) {
            matched++;
            callbacks.onHit(entry.path, entry.line, entry.content);
          }
        }
        callbacks.onProgress(byPath.size);
        return { matched, scanned: byPath.size, cancelled: false };
      },
      cancelContentSearch() {},
    };
    // The browser imports the same source module through Vite's URL.
    const moduleUrl = "/src/home/RecentView.tsx";
    const { RecentView }: typeof import("../src/home/RecentView") = await import(moduleUrl);
    const app = document.querySelector<HTMLElement>("#app");
    if (!app) throw new Error("Application host is missing");
    const view = new RecentView(data, () => ({
      recentFilesVisibleCount: 100,
      recentFilesDefaultSearch: "names",
      recentFilesKeepRemoved: true,
    }), {
      onOpenFile(path) { window.__recentCalls.opened.push(path); },
      onSummaryChange() {},
      async pickFile() { return null; },
      reveal() {},
      copy() {},
    });
    app.append(view.element);
    await view.refresh();
  }, entries);
  await expect(page.getByRole("textbox", { name: "Search recent file names", exact: true })).toBeFocused();
}

/** Find a file row through its exact accessible open action. */
function row(page: Page, name: string) {
  return page.locator(".recent-row").filter({
    has: page.getByRole("button", { name: `Open ${name}`, exact: true }),
  });
}

/** The paths the view asked the app to open, in order. */
const opened = (page: Page) => page.evaluate(() => window.__recentCalls.opened);

// The listing, search scopes, highlights and arrow keys are unit tests in
// src/home/RecentView.test.ts. These cases need a real browser's buttons and focus.

test("rows open with Enter and Space, and a star keeps focus when pressed or clicked", async ({ page }) => {
  await mount(page);
  const names = page.locator(".recent-name");
  const initial = ["plan.md", "guide.md", "report.md", "plan-archive.md", "missing.md"];
  await expect(names).toHaveText(initial);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Open plan.md", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Open guide.md", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect.poll(() => opened(page)).toEqual(["C:/samples/plan.md", "C:/samples/plan/guide.md"]);

  const guide = row(page, "guide.md");
  await page.keyboard.press("ArrowRight");
  await expect(guide.getByRole("button", { name: "Remove from favorites" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(guide.getByRole("button", { name: "Add to favorites" })).toBeFocused();
  const plan = row(page, "plan.md");
  await plan.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(plan.getByRole("button", { name: "Add to favorites" })).toBeFocused();
  await expect(names).toHaveText(initial);
  await expect.poll(() => page.evaluate(() => window.__recentCalls)).toEqual({
    opened: ["C:/samples/plan.md", "C:/samples/plan/guide.md"],
    removed: [],
    favorites: [
      { path: "C:/samples/plan/guide.md", favorite: false },
      { path: "C:/samples/plan.md", favorite: false },
    ],
  });
});

test("a Contents search gives each hit its own line, and Clear empties the field and keeps focus in it", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search inside recent documents" });
  await search.fill("PLAN");
  await expect(page.locator(".recent-progress")).toHaveText("2 files found");
  await expect(row(page, "plan.md")).toHaveAttribute("title", "C:/samples/plan.md\nMatch on line 7");
  await expect(row(page, "report.md")).toHaveAttribute("title", "C:/samples/report.md\nMatch on line 19");
  await row(page, "report.md").getByRole("button", { name: "Open report.md", exact: true }).click();
  await expect.poll(() => opened(page)).toEqual(["C:/samples/report.md"]);

  await search.focus();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.locator(".recent-name")).toHaveCount(5);
});

test("Escape in the missing-file dialog returns focus to the file's row", async ({ page }) => {
  await mount(page, ENTRIES.filter((entry) => !entry.exists));
  const open = page.getByRole("button", { name: "Open missing.md", exact: true });
  await expect(row(page, "missing.md")).toHaveClass(/\bmissing\b/);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "File not found" });
  await expect(dialog).toContainText('"missing.md" could not be found.');
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__recentCalls)).toEqual({ opened: [], favorites: [], removed: [] });
});
