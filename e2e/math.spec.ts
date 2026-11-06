import { expect, test, type Page } from "@playwright/test";

const inlineMath = '.editor-pane-wysiwyg [data-type="math_inline"]';
const rawEditor = ".editor-pane-raw .cm-content";
let pageErrors: string[] = [];

/** Enter Markdown through the source editor and keep both views visible. */
async function setSource(page: Page, markdown: string): Promise<void> {
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await page.locator(rawEditor).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(markdown);
  await page.getByRole("radio", { name: "Split", exact: true }).click();
}

/** Read these short documents from CodeMirror's visible lines. */
function markdown(page: Page): Promise<string> {
  return page.locator(`${rawEditor} .cm-line`).evaluateAll((lines) => lines.map((line) => line.textContent).join("\n"));
}

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-started", "true");
  await expect(page.locator(".ProseMirror h1")).toContainText("Welcome to Downpad");
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

test("typing a visual fraction applies to both views as one document undo step", async ({ page }) => {
  const original = "Before $a$ after.\n";
  await setSource(page, original);
  const formula = page.locator(inlineMath);
  await formula.click();
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  const field = dialog.locator("math-field");
  const source = dialog.getByRole("textbox", { name: "LaTeX source", exact: true });
  await expect(field).toBeVisible();
  await field.click();
  // MathLive delays focus after a click, so wait for its actual keyboard input.
  await expect(field.locator('[part="keyboard-sink"]')).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  // Real keystrokes exercise MathLive's structured editing, not its setValue API.
  await page.keyboard.type("x/y");
  await expect(source).toHaveValue("\\frac{x}{y}");
  await expect(field.locator(".ML__frac-line")).toBeVisible();
  await expect.poll(() => markdown(page)).toBe(original);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(formula).toHaveAttribute("data-value", "\\frac{x}{y}");
  await expect(formula.locator(".katex .mfrac")).toBeVisible();
  await expect.poll(() => markdown(page)).toBe("Before $\\frac{x}{y}$ after.\n");

  await page.getByRole("textbox", { name: "Document editor", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(formula).toHaveAttribute("data-value", "a");
  await expect.poll(() => markdown(page)).toBe(original);
  await page.keyboard.press("Enter");
  await expect(source).toHaveValue("a");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("cancel and unchanged apply preserve unfamiliar LaTeX without normalization", async ({ page }) => {
  const latex = "\\custommacro{  x  } + \\frac{1}{2}";
  const original = `Keep $${latex}$ exactly.\n`;
  await setSource(page, original);
  const formula = page.locator(inlineMath);
  await formula.click();
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  const source = dialog.getByRole("textbox", { name: "LaTeX source", exact: true });
  await expect(source).toHaveValue(latex);
  await source.fill("x+1");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => markdown(page)).toBe(original);
  await expect(formula).toHaveAttribute("data-value", latex);

  await formula.click();
  await expect(source).toHaveValue(latex);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => markdown(page)).toBe(original);

  await formula.click();
  await source.fill("changed");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => markdown(page)).toBe(original);
});

test("a display equation edits a matrix while a fenced latex example stays code", async ({ page }) => {
  const fenced = "```latex\n\\frac{a}{b}\n```";
  await setSource(page, `$$\na+b\n$$\n\n${fenced}\n`);
  const blocks = page.locator(".editor-pane-wysiwyg .milkdown-code-block");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(1).getByRole("button", { name: "Edit equation", exact: true })).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  await blocks.first().getByRole("textbox", { name: "Code block editor" }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.type("+c");
  await expect.poll(() => markdown(page)).toContain("$$\na+b+c\n$$");

  await blocks.first().getByRole("button", { name: "Edit equation", exact: true }).click();
  const matrix = "\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}";
  const source = dialog.getByRole("textbox", { name: "LaTeX source", exact: true });
  await source.fill(matrix);
  await expect(dialog.locator("math-field .ML__mtable")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(blocks.first().locator(".preview .katex .mtable")).toBeVisible();
  await expect.poll(() => markdown(page)).toContain(`$$\n${matrix}\n$$`);
  await expect.poll(() => markdown(page)).toContain(fenced);

  await blocks.first().locator(".preview").click();
  await expect(source).toHaveValue(matrix);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await blocks.first().getByRole("textbox", { name: "Code block editor", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(source).toHaveValue(matrix);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const printed = page.locator(".print-workspace .print-flow");
  await expect(printed.locator(".katex .mtable")).toBeVisible();
  await expect(printed.locator(".math-edit-button, math-field, .MLK__keyboard")).toHaveCount(0);
});

test("keyboard editing in a table keeps literal pipes inside the original cell", async ({ page }) => {
  await setSource(page, "| Formula | Note |\n| --- | --- |\n| $x$ | Keep me |\n");
  const formula = page.locator(inlineMath);
  await formula.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "LaTeX source", exact: true }).fill("|x|+|y|");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => markdown(page)).toContain("$\\|x\\|+\\|y\\|$");

  // Reparse the saved Markdown, so escaping must preserve the table structure.
  const saved = await markdown(page);
  await setSource(page, saved);
  const table = page.locator(".editor-pane-wysiwyg table.children");
  await expect(table.locator("th, td")).toHaveCount(4);
  await expect(table.locator("td").last()).toHaveText("Keep me");
  await expect(formula).toHaveAttribute("data-value", "|x|+|y|");
  await formula.focus();
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("textbox", { name: "LaTeX source", exact: true })).toHaveValue("|x|+|y|");
  await page.keyboard.press("Escape");
});

test("the symbols keyboard inserts a symbol into the visual equation", async ({ page }) => {
  await setSource(page, "Let $x$ be given.\n");
  await page.locator(inlineMath).click();
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  await dialog.getByRole("button", { name: "Show symbols", exact: true }).click();
  const exists = dialog.locator(String.raw`.MLK__layer.is-visible [data-keycap-value="\\exists"]`);
  await expect(exists).toBeVisible();
  await exists.click();
  await expect(dialog.getByRole("textbox", { name: "LaTeX source", exact: true })).toHaveValue(/\\exists/);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => markdown(page)).toContain("\\exists");
  await expect(page.locator(".MLK__keyboard.is-visible")).toHaveCount(0);
});
