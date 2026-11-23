import { test, expect, type Page } from "@playwright/test";

// This file checks the view control (§6.1) in a real browser, where real undo
// must survive a trip through the split. The layouts, the split mirror, the
// narrow split's padding and the find card's focus are unit tests in src/ or
// run in e2e-electron.

const wysiwyg = ".milkdown .ProseMirror";
// In the split, BOTH panes are visible, and the document pane's embedded code
// blocks are also `.cm-content`, so scope the raw source to its own pane.
const rawContent = ".editor-pane-raw .cm-content";
const documentSeg = ".toolbar-view button:has-text('Document')";
const splitSeg = ".toolbar-view button:has-text('Split')";

async function useWheelPlatform(page: Page, platform: string) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setNavigatorOverrides", { platform });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // WYSIWYG mounts asynchronously; wait for the seeded heading to render.
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
});

test("Ctrl+wheel changes the toolbar text size in Document view", async ({ page }) => {
  const heading = page.getByRole("heading", { name: "Welcome to Downpad" });
  const fontSize = () => heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const readout = page.getByRole("button", { name: /^Document text size,/ });
  await page.getByRole("button", { name: "Increase text size" }).click();
  await expect(readout).toHaveText("110%");
  const initialSize = await fontSize();

  await heading.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await expect(readout).toHaveText("120%");
  await expect.poll(fontSize).toBeGreaterThan(initialSize);
  await page.mouse.wheel(0, 120);
  await expect(readout).toHaveText("110%");
  await expect.poll(fontSize).toBe(initialSize);
  await page.keyboard.up("Control");

  const panel = page.getByRole("tabpanel");
  const scrollTop = () => panel.evaluate((element) => element.scrollTop);
  const beforeScroll = await scrollTop();
  await page.mouse.wheel(0, 120);
  await expect.poll(scrollTop).toBeGreaterThan(beforeScroll);
  await expect(readout).toHaveText("110%");

  await page.locator(splitSeg).click();
  await expect(page.locator(rawContent)).toBeVisible();
  await heading.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.locator(documentSeg).click();
  await expect(readout).toHaveText("110%");
});

for (const sample of [
  { name: "fractional touchpad scrolling", platform: "Linux x86_64", count: 16, deltaY: -7.5, wheelDeltaY: 7 },
  { name: "a pinch with combined updates", platform: "Win32", count: 3, deltaY: -40, wheelDeltaY: 120 },
]) {
  test(`${sample.name} adds up to the same zoom as a full notch`, async ({ page }) => {
    await useWheelPlatform(page, sample.platform);
    const heading = page.getByRole("heading", { name: "Welcome to Downpad" });
    const readout = page.getByRole("button", { name: /^Document text size,/ });
    await heading.evaluate((element, { count, deltaY, wheelDeltaY }) => {
      const movement = { ctrlKey: true, deltaY, wheelDeltaY, bubbles: true, cancelable: true };
      for (let i = 0; i < count; i++) element.dispatchEvent(new WheelEvent("wheel", movement));
    }, sample);
    await expect(readout).toHaveText("110%");
    await heading.dispatchEvent("wheel", { ctrlKey: true, deltaY: 240 });
    await expect(readout).toHaveText("90%");
  });
}

test("one wheel notch zooms one step with different system scrolling speeds", async ({ page }) => {
  await useWheelPlatform(page, "Win32");
  const heading = page.getByRole("heading", { name: "Welcome to Downpad" });
  const readout = page.getByRole("button", { name: /^Document text size,/ });
  await heading.dispatchEvent("wheel", { ctrlKey: true, deltaY: -100 / 3, wheelDeltaY: 120 });
  await expect(readout).toHaveText("110%");
  await heading.dispatchEvent("wheel", { ctrlKey: true, deltaY: 300, wheelDeltaY: -120 });
  await expect(readout).toHaveText("100%");
});

test("Mac wheel notches and fine pinch movements zoom at their own pace", async ({ page }) => {
  await useWheelPlatform(page, "MacIntel");
  await page.reload();
  const heading = page.getByRole("heading", { name: "Welcome to Downpad" });
  const readout = page.getByRole("button", { name: /^Document text size,/ });
  await heading.hover();
  await page.keyboard.down("Control");
  await heading.dispatchEvent("wheel", { ctrlKey: true, deltaY: -40, wheelDeltaY: 120 });
  await expect(readout).toHaveText("110%");
  await heading.dispatchEvent("wheel", { ctrlKey: true, deltaY: 200, wheelDeltaY: -120 });
  await expect(readout).toHaveText("100%");
  await page.keyboard.up("Control");
  await heading.evaluate((element) => {
    const pinch = { ctrlKey: true, deltaY: -5, wheelDeltaY: 120, bubbles: true, cancelable: true };
    for (let i = 0; i < 8; i++) element.dispatchEvent(new WheelEvent("wheel", pinch));
  });
  await expect(readout).toHaveText("110%");
});

test.describe("at 200% display scaling", () => {
  test.use({ deviceScaleFactor: 2 });

  test("a page-scroll wheel notch zooms one step", async ({ page }) => {
    const heading = page.getByRole("heading", { name: "Welcome to Downpad" });
    await heading.dispatchEvent("wheel", { ctrlKey: true, deltaMode: 2, deltaY: -0.5, wheelDeltaY: 60 });
    await expect(page.getByRole("button", { name: /^Document text size,/ })).toHaveText("110%");
  });
});

test("opening then closing the split preserves the document's undo history", async ({ page }) => {
  const doc = page.locator(wysiwyg);
  // The text of every block but code blocks, whose fold markers CodeMirror
  // draws once their language loads, which can be after this test starts.
  const text = () => doc.evaluate((element) =>
    Array.from(element.children, (block) => (block.matches(".milkdown-code-block") ? "" : block.textContent)).join("\n"));
  const before = await text();
  await doc.click();
  await page.keyboard.press("ControlOrMeta+End");
  // One key, which one undo takes back. A pause of half a second between keys
  // starts a new undo step, and a busy machine can make one.
  await page.keyboard.type("!");
  await expect.poll(text).toBe(`${before}!`);

  // The split keeps the same document editor, so its undo history survives.
  await page.locator(splitSeg).click();
  await expect(page.locator(rawContent)).toBeVisible();
  await page.locator(documentSeg).click();
  await expect(page.locator(rawContent)).toBeHidden();

  await doc.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(text).toBe(before);
});
