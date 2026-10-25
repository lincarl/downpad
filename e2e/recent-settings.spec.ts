import { test, expect, type Page } from "@playwright/test";

/** Open the actual Settings dialog through the application menu. */
async function settings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Application menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
}

test("General saves Recent preferences and reapplies the default search when Recent opens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-started", "true");
  await settings(page);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const search = dialog.getByRole("combobox", { name: "Default search:" });
  const removed = dialog.getByRole("checkbox", { name: "Keep removed files in list" });
  await expect(search).toHaveValue("names");
  await expect(removed).not.toBeChecked();
  for (const width of [700, 699, 480]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await dialog.getByRole("tabpanel", { name: "General" }).evaluate((panel) => {
      const right = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll("input, select")].every((control) => control.getBoundingClientRect().right <= right);
    });
    expect(bounds).toBe(true);
  }
  await search.selectOption("all");
  await removed.check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  const scope = page.getByRole("group", { name: "Search scope" });
  await expect(scope.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");

  await scope.getByRole("button", { name: "Names", exact: true }).click();
  await page.getByRole("tab", { name: "Untitled", exact: true }).click();
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect(scope.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");

  await settings(page);
  await expect(search).toHaveValue("all");
  await expect(removed).toBeChecked();
  await search.selectOption("contents");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(scope.getByRole("button", { name: "Contents", exact: true })).toHaveAttribute("aria-pressed", "true");
});
