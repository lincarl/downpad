import { test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Visual verification of the Recent view (spec §5.8). Mounts the real RecentView
// component (served by Vite in dev) against an in-page mock data source so we can
// screenshot fully-populated states without a Tauri backend. Screenshots land in
// e2e/__screens__/ for manual comparison to the spec; this is a screenshot
// harness, not an assertion test.

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "__screens__");

const DAY = 86_400_000;

// Entries carry extra fields (exists/size/content/line) the mock reads; the
// RecentView itself only uses path/lastOpenedMs/favorite.
const ENTRIES = [
  { path: "C:\\Users\\me\\notes\\draft.md", days: 0, favorite: true, exists: true, size: 12_288, content: "the pasted graph below shows growth", line: 2 },
  { path: "C:\\Users\\me\\notes\\meeting-notes.md", days: 1, favorite: false, exists: true, size: 4096, content: "agenda and action items", line: 5 },
  { path: "C:\\Users\\me\\projects\\md-easy\\docs\\spec.md", days: 5, favorite: true, exists: true, size: 49_152, content: "the recent view lists recently opened files", line: 144 },
  { path: "C:\\Users\\me\\notes\\old-todo.md", days: 23, favorite: false, exists: false, size: 0, content: "", line: 1 },
  { path: "C:\\Users\\me\\very\\deeply\\nested\\folder\\structure\\that\\overflows\\README.md", days: 64, favorite: true, exists: true, size: 2048, content: "readme overview section", line: 1 },
  { path: "C:\\Users\\me\\notes\\budget-2026.md", days: 370, favorite: false, exists: true, size: 800, content: "quarterly budget totals", line: 9 },
];

async function mount(page: import("@playwright/test").Page, opts: { entries?: typeof ENTRIES; dark?: boolean } = {}): Promise<void> {
  await page.goto("/");
  await page.waitForSelector("#app");
  await page.evaluate(
    async ([entries, dark, now]) => {
      if (dark) document.documentElement.setAttribute("data-theme", "dark");
      const byPath: Record<string, any> = {};
      const list = (entries as any[]).map((e) => {
        const entry = { path: e.path, lastOpenedMs: now - e.days * 86_400_000, favorite: e.favorite };
        byPath[e.path] = { ...e, ...entry };
        return entry;
      });
      const data = {
        async list() {
          return list;
        },
        async stat(paths: string[]) {
          return paths.map((p) => {
            const e = byPath[p];
            return {
              path: p,
              exists: e ? e.exists : true,
              sizeBytes: e ? e.size : 0,
              folderExists: true,
            };
          });
        },
        async setFavorite(p: string, fav: boolean) {
          if (byPath[p]) byPath[p].favorite = fav;
          return byPath[p] ?? null;
        },
        async remove() {},
        async searchContents(_id: string, q: string, cb: any) {
          cb.onProgress(entries.length);
          let matched = 0;
          for (const e of entries as any[]) {
            if (e.content && e.content.toLowerCase().includes(q.toLowerCase())) {
              matched++;
              cb.onHit(e.path, e.line, e.content);
            }
          }
          return { matched, scanned: (entries as any[]).length, cancelled: false };
        },
        cancelContentSearch() {},
      };
      const mod = await import("/src/home/RecentView.tsx");
      const app = document.querySelector("#app") as HTMLElement;
      app.innerHTML = "";
      app.style.height = "100vh";
      app.style.overflow = "auto";
      app.style.background = "var(--editor-bg)";
      const rv = new mod.RecentView(data, () => 100, {
        onOpenFile() {},
        onSummaryChange(t: string) {
          (window as any).__summary = t;
        },
        async pickFile() {
          return null;
        },
        reveal() {},
        copy() {},
      });
      app.appendChild(rv.element);
      (window as any).__rv = rv;
      await rv.refresh();
    },
    [opts.entries ?? ENTRIES, !!opts.dark, Date.now()] as const,
  );
  // Let ensureStats() resolve and re-render with sizes / missing state.
  await page.waitForTimeout(250);
}

test("recent — All (light)", async ({ page }) => {
  await mount(page);
  await page.screenshot({ path: path.join(OUT, "recent-all-light.png"), fullPage: true });
});

test("recent — Favorites (light)", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "recent-favorites-light.png"), fullPage: true });
});

test("recent — All (dark)", async ({ page }) => {
  await mount(page, { dark: true });
  await page.screenshot({ path: path.join(OUT, "recent-all-dark.png"), fullPage: true });
});

test("recent — Name search highlights the match", async ({ page }) => {
  await mount(page);
  // Name scope is the default; the matched run of each filename is emboldened.
  await page.locator(".recent-search-input").fill("note");
  await page.waitForTimeout(300); // 200ms name debounce + render
  await page.screenshot({ path: path.join(OUT, "recent-name-search.png"), fullPage: true });
});

test("recent — Inside search results", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "Inside docs", exact: true }).click();
  await page.locator(".recent-search-input").fill("the");
  await page.waitForTimeout(700); // 400ms debounce + render
  // "the" matches the content of several entries, so each result row shows its
  // own snippet between the filename and the path, with "the" emboldened.
  await page.screenshot({ path: path.join(OUT, "recent-inside-search.png"), fullPage: true });
});

test("recent — Inside search results (dark)", async ({ page }) => {
  await mount(page, { dark: true });
  await page.getByRole("button", { name: "Inside docs", exact: true }).click();
  await page.locator(".recent-search-input").fill("the");
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, "recent-inside-search-dark.png"), fullPage: true });
});

test("recent — empty state", async ({ page }) => {
  await mount(page, { entries: [] });
  await page.screenshot({ path: path.join(OUT, "recent-empty.png"), fullPage: true });
});

test("recent — missing-file dialog", async ({ page }) => {
  await mount(page);
  await page.locator(".recent-row", { hasText: "old-todo.md" }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "recent-missing-dialog.png"), fullPage: true });
});

test("toolbar — Recent pill active vs editor", async ({ page }) => {
  // The real app shell in browser mode: editor first, then the Recent view.
  await page.goto("/");
  await page.waitForSelector(".toolbar-recent");
  await page.screenshot({ path: path.join(OUT, "toolbar-editor.png") });
  await page.locator(".toolbar-recent").click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "toolbar-recent-active.png") });
});
