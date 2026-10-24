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
  // Serve an empty host so no App runtime owns the DOM used by this fixture.
  // Vite's TSX modules still need its React refresh preamble.
  await page.route("/", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html>
      <html lang="en" data-theme="dark">
        <head>
          <meta charset="utf-8">
          <link rel="stylesheet" href="/src/styles/app.css">
          <script type="module">
            import { injectIntoGlobalHook } from "/@react-refresh";
            injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {};
            window.$RefreshSig$ = () => (type) => type;
          </script>
        </head>
        <body><div id="app"></div></body>
      </html>`,
  }));
  await page.goto("/");
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
    app.style.height = "100vh";
    const view = new RecentView(data, () => 100, {
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

test("favorites keep their position while toggling, then regroup on a new query", async ({ page }) => {
  await mount(page);
  const names = page.locator(".recent-name");
  const initial = ["plan.md", "guide.md", "report.md", "plan-archive.md", "missing.md"];
  await expect(names).toHaveText(initial);
  await expect(page.locator(".recent-caption")).toHaveText(["Favorites", "Recent"]);

  const plan = row(page, "plan.md");
  await plan.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(plan.getByRole("button", { name: "Add to favorites" })).toBeFocused();
  await expect(names).toHaveText(initial);
  await plan.getByRole("button", { name: "Add to favorites" }).click();
  await expect(plan.getByRole("button", { name: "Remove from favorites" })).toBeFocused();
  await expect(names).toHaveText(initial);

  await plan.getByRole("button", { name: "Remove from favorites" }).click();
  await row(page, "guide.md").getByRole("button", { name: "Remove from favorites" }).click();
  await expect(names).toHaveText(initial);
  await expect.poll(() => page.evaluate(() => window.__recentCalls)).toEqual({
    opened: [], removed: [], favorites: [
      { path: "C:/samples/plan.md", favorite: false },
      { path: "C:/samples/plan.md", favorite: true },
      { path: "C:/samples/plan.md", favorite: false },
      { path: "C:/samples/plan/guide.md", favorite: false },
    ],
  });

  await page.getByRole("textbox").fill(".md");
  await expect(names).toHaveText(["report.md", "plan.md", "plan-archive.md", "guide.md", "missing.md"]);
  await expect(page.locator(".recent-caption")).toHaveCount(0);
});

test("Names search highlights filenames and clearing restores the list and focus", async ({ page }) => {
  await mount(page);
  const search = page.getByRole("textbox", { name: "Search recent file names", exact: true });
  await expect(page.getByRole("button", { name: "Names", exact: true })).toHaveAttribute("aria-pressed", "true");
  await search.fill("PLAN");
  await expect(page.locator(".recent-name")).toHaveText(["plan.md", "plan-archive.md"]);
  await expect(page.locator(".recent-name .recent-match")).toHaveText(["plan", "plan"]);
  await expect(page.locator(".recent-snippet")).toHaveCount(0);
  await row(page, "plan-archive.md").getByRole("button", { name: "Open plan-archive.md", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__recentCalls.opened)).toEqual(["C:/samples/plan-archive.md"]);

  await search.focus();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.locator(".recent-name")).toHaveCount(5);
  await expect(page.locator(".recent-match")).toHaveCount(0);
});

test("Contents search maps each hit's snippet, highlight and line to the opened path", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Contents", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Search inside recent documents" }).fill("PLAN");
  await expect(page.locator(".recent-progress")).toHaveText("2 files found");
  await expect(page.locator(".recent-name")).toHaveText(["plan.md", "report.md"]);
  await expect(page.locator(".recent-name .recent-match")).toHaveCount(0);
  await expect(page.locator(".recent-snippet")).toHaveText(["a plan for release", "weekly plan overview"]);
  await expect(page.locator(".recent-snippet .recent-match")).toHaveText(["plan", "plan"]);

  for (const [name, path, line] of [
    ["plan.md", "C:/samples/plan.md", 7],
    ["report.md", "C:/samples/report.md", 19],
  ] as const) {
    await expect(row(page, name)).toHaveAttribute("title", `${path}\nMatch on line ${line}`);
    await row(page, name).getByRole("button", { name: `Open ${name}`, exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => window.__recentCalls.opened)).toEqual([
    "C:/samples/plan.md", "C:/samples/report.md",
  ]);
});

test("All search lists name matches before content-only hits without duplicate rows", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Search recent file names and documents" }).fill("PLAN");
  await expect(page.locator(".recent-progress")).toHaveText("3 files found");
  await expect(page.locator(".recent-name")).toHaveText(["plan.md", "plan-archive.md", "report.md"]);
  await expect(page.locator(".recent-name .recent-match")).toHaveText(["plan", "plan"]);
  await expect(row(page, "plan.md").locator(".recent-snippet")).toHaveCount(0);
  await expect(row(page, "plan-archive.md").locator(".recent-snippet")).toHaveCount(0);
  await expect(page.locator(".recent-snippet")).toHaveText(["weekly plan overview"]);
  await expect(row(page, "report.md").locator(".recent-match")).toHaveText("plan");
  await expect(row(page, "report.md")).toHaveAttribute("title", "C:/samples/report.md\nMatch on line 19");
});

test("keyboard navigation opens files with Enter and Space and activates stars independently", async ({ page }) => {
  await mount(page);
  const search = page.getByRole("textbox");
  const first = page.getByRole("button", { name: "Open plan.md", exact: true });
  const second = page.getByRole("button", { name: "Open guide.md", exact: true });
  await page.keyboard.press("ArrowDown");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__recentCalls.opened)).toEqual(["C:/samples/plan.md"]);
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await expect(page.locator(".recent-row-open[tabindex='0']")).toHaveAccessibleName("Open guide.md");
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => window.__recentCalls.opened)).toEqual([
    "C:/samples/plan.md", "C:/samples/plan/guide.md",
  ]);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "guide.md").getByRole("button", { name: "Remove from favorites" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(row(page, "guide.md").getByRole("button", { name: "Add to favorites" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__recentCalls.favorites)).toEqual([
    { path: "C:/samples/plan/guide.md", favorite: false },
  ]);
  await page.keyboard.press("ArrowLeft");
  await expect(second).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__recentCalls.opened)).toEqual([
    "C:/samples/plan.md", "C:/samples/plan/guide.md",
  ]);
});

test("missing-file actions restore focus on cancel and refresh to an empty history on removal", async ({ page }) => {
  await mount(page, ENTRIES.filter((entry) => !entry.exists));
  const open = page.getByRole("button", { name: "Open missing.md", exact: true });
  await expect(row(page, "missing.md")).toHaveClass(/\bmissing\b/);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "File not found" });
  await expect(dialog).toContainText('"missing.md" could not be found.');
  await expect(dialog.getByRole("button", { name: "Locate", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__recentCalls)).toEqual({ opened: [], favorites: [], removed: [] });

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove from history" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".recent-row")).toHaveCount(0);
  await expect(page.locator(".recent-empty")).toHaveText("No recent files yet");
  await expect.poll(() => page.evaluate(() => window.__recentCalls)).toEqual({
    opened: [], favorites: [], removed: ["C:/samples/missing.md"],
  });
});

test("the real app's Recent button switches views without replacing the existing document", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator(".ProseMirror h1");
  await expect(heading).toHaveText("Welcome to Downpad");
  const recent = page.getByRole("button", { name: "Recent", exact: true });
  await expect(recent).not.toHaveClass(/\bactive\b/);
  await recent.click();
  await expect(recent).toHaveClass(/\bactive\b/);
  await expect(page.locator(".recent-host")).toBeVisible();
  await expect(heading).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Search recent file names", exact: true })).toBeFocused();
  await expect(page.locator(".recent-empty")).toHaveText("No recent files yet");
  await page.getByRole("tab").click();
  await expect(recent).not.toHaveClass(/\bactive\b/);
  await expect(page.locator(".recent-host")).toBeHidden();
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText("Welcome to Downpad");
  await expect(page.locator(".tab")).toHaveCount(1);
});
