import { test, expect } from "@playwright/test";

// Verifies best-effort scroll-position sync between the two split panes (§5.3):
// scrolling either pane moves the other to the same fractional position. A short
// viewport forces the seeded document to overflow both panes so they can scroll.

const wysiwyg = ".milkdown .ProseMirror";
const docPane = ".editor-pane-wysiwyg";
const rawPane = ".editor-pane-raw";
// The split (both panes) is opened with the "Split" segment of the view control.
const splitSeg = ".toolbar-view button:has-text('Split')";

const scrollTopOf = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(selector).evaluate((el) => (el as HTMLElement).scrollTop);

test.beforeEach(async ({ page }) => {
  // A short window so the welcome document overflows both panes and is scrollable.
  await page.setViewportSize({ width: 1000, height: 360 });
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  await page.locator(splitSeg).click();
  await expect(page.locator(rawPane)).toBeVisible();
});

test("scrolling the Markdown source moves the document to the same position", async ({ page }) => {
  // Drive the raw pane to the bottom; the document follows to the SAME fractional
  // position — i.e. its own bottom, not merely "somewhere below the top".
  await page.locator(rawPane).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() =>
      page.locator(docPane).evaluate((el) => {
        const e = el as HTMLElement;
        return e.scrollHeight - e.clientHeight - e.scrollTop; // distance from its own bottom
      }),
    )
    .toBeLessThan(5);
});

test("scrolling the document moves the Markdown source to the same position", async ({ page }) => {
  // First push both panes down via the raw pane…
  await page.locator(rawPane).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => scrollTopOf(page, docPane)).toBeGreaterThan(0);

  // …then let the driver lock release and scroll the document back to the top;
  // the raw source follows back up.
  await page.waitForTimeout(300);
  await page.locator(docPane).evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => scrollTopOf(page, rawPane)).toBeLessThan(5);
});
