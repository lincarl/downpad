import type { KeyboardEvent, ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** One row of a popup menu: the application menu, toolbar dropdowns and context menus. */
export interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
  icon?: LucideIcon;
  /** Shortcut hint shown at the row's right end, such as "Ctrl+Shift+V". Screen
   *  readers get it as the row's `aria-keyshortcuts`, not as part of its name. */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Marks an active toggle or choice with an accent check at the row's right end. */
  checked?: boolean;
  /** The row is one of a set of exclusive choices (with `checked`), not a toggle. */
  radio?: boolean;
  separatorBefore?: boolean;
  /** Caption printed above this row, after its separator, to name a group of rows. */
  section?: string;
}

/** The floating surface every menu shares: popover fill, hairline rim, 10px corners. */
export const menuSurfaceClassName = cn(
  "min-w-[180px] rounded-[10px] border border-line-menu bg-popover p-1.5",
  // Mervin's popups carry no shadow: the 1px rim separates them from the page.
  "font-[family-name:var(--font-ui)] text-[12px] leading-4 text-ink",
  // Separators carry no classes of their own so their markup stays minimal.
  "[&_.md-context-menu-sep]:mx-1 [&_.md-context-menu-sep]:my-1.5 [&_.md-context-menu-sep]:h-px [&_.md-context-menu-sep]:bg-separator",
);

/** The rows of a menu, with Mervin's icon column, section captions and right-side checks.
 * `onActivate` runs before the item so the owner can close the menu first. */
export function MenuRows({
  items,
  onActivate,
}: {
  items: MenuItem[];
  onActivate(item: MenuItem): void;
}): ReactNode {
  const withIcons = items.some((item) => item.icon);
  const withChecks = items.some((item) => item.checked !== undefined);
  return items.map((item, index) => (
    <MenuRow
      key={`${item.label}-${index}`}
      item={item}
      first={index === 0}
      withIcons={withIcons}
      withChecks={withChecks}
      onActivate={onActivate}
    />
  ));
}

/** One menu row, with the separator and section caption that come before it.
 *  The row gives its shortcut to screen readers as `aria-keyshortcuts` and hides
 *  the visible hint from them, so the hint is not read as part of its name. */
function MenuRow({
  item,
  first,
  withIcons,
  withChecks,
  onActivate,
}: {
  item: MenuItem;
  first: boolean;
  withIcons: boolean;
  withChecks: boolean;
  onActivate(item: MenuItem): void;
}) {
  const Icon = item.icon;
  return (
    <>
      {item.separatorBefore && <div className="md-context-menu-sep" role="separator" />}
      {item.section && (
        <div
          className={cn(
            "md-menu-section select-none pr-2.5 pb-[3px] pl-0.5 text-[10px] font-semibold tracking-[0.02em] text-ink-menu-header",
            first || item.separatorBefore ? "pt-1" : "pt-[7px]",
          )}
          role="presentation"
        >
          {item.section}
        </div>
      )}
      <button
        type="button"
        className={cn(
          "md-context-menu-item group my-px flex h-[29px] w-full cursor-pointer items-center rounded-[6px] border-0 bg-transparent text-left font-[inherit] text-[inherit] outline-none",
          // Mervin sets the 16px icon at the row's edge and starts labels 30px in.
          withIcons ? "gap-3.5 pr-2.5 pl-0.5" : "gap-2 px-2.5",
          "hover:bg-row-hover focus-visible:bg-row-hover",
          item.danger && "danger text-ink-danger",
          item.disabled && "disabled cursor-default text-ink-disabled hover:bg-transparent",
        )}
        role={item.checked === undefined ? "menuitem" : item.radio ? "menuitemradio" : "menuitemcheckbox"}
        aria-checked={item.checked}
        aria-keyshortcuts={item.shortcut?.replace(/\bCtrl\b/g, "Control")}
        disabled={item.disabled}
        onClick={item.disabled ? undefined : () => onActivate(item)}
      >
        {withIcons && (
          <span
            className={cn(
              "md-context-menu-icon size-4 shrink-0 text-ink-body [&_svg]:block [&_svg]:size-4",
              item.disabled && "text-ink-disabled",
            )}
          >
            {Icon && <Icon aria-hidden="true" focusable="false" size={16} absoluteStrokeWidth strokeWidth={1} />}
          </span>
        )}
        <span className="md-context-menu-label flex-1 whitespace-nowrap pr-2">{item.label}</span>
        {item.shortcut && (
          <span className="md-context-menu-key whitespace-nowrap pl-3 text-[11px] text-ink-faint" aria-hidden="true">
            {item.shortcut}
          </span>
        )}
        {withChecks && (
          <span className="md-context-menu-check ml-1 size-[15px] shrink-0 text-accent [&_svg]:block [&_svg]:size-[15px]">
            {item.checked && <Check aria-hidden="true" focusable="false" strokeWidth={2.6} />}
          </span>
        )}
      </button>
    </>
  );
}

/** Arrow, Home and End navigation between the enabled rows of a menu element. */
export function moveMenuFocus(menu: HTMLElement, key: string): boolean {
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (!step && key !== "Home" && key !== "End") return false;
  const rows = Array.from(
    menu.querySelectorAll<HTMLButtonElement>(".md-context-menu-item:not(.disabled)"),
  );
  if (!rows.length) return false;
  const current = rows.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (key === "Home") next = 0;
  else if (key === "End") next = rows.length - 1;
  else if (current < 0) next = step > 0 ? 0 : rows.length - 1;
  else next = (current + step + rows.length) % rows.length;
  rows[next].focus();
  return true;
}

/** A menu's keyboard handler for menus hosted in a Radix popover. */
export function onMenuKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
}

const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex], [contenteditable="true"]';

/** Whether Tab can reach `el`, which must be in the tab order and not hidden or inert. */
function isTabbable(el: HTMLElement): boolean {
  return el.tabIndex >= 0 && !el.closest("[hidden], [inert]") && (el.checkVisibility?.() ?? true);
}

/**
 * Focus the control after `from` in the page's tab order, or the one before it
 * when `backward`. Focus stays on `from` at either end. Used when Tab closes a
 * menu: focus moves on from the menu's button, as the WAI-ARIA menu button
 * pattern describes.
 */
export function focusBeside(from: HTMLElement, backward: boolean): void {
  const order = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el === from || isTabbable(el),
  );
  const at = order.indexOf(from);
  (order[at + (backward ? -1 : 1)] ?? from).focus();
}

/**
 * Focus the first control after `container` in the page's tab order, or the
 * last one before it when `backward`, skipping every control inside it. Wraps
 * around at the ends of the page, as Tab does in the app window. Used when Tab
 * leaves the document editor.
 */
export function focusPast(container: HTMLElement, backward: boolean): void {
  const order = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => !container.contains(el) && isTabbable(el),
  );
  const after = order.findIndex((el) => container.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const next = after < 0 ? order.length : after;
  order[(backward ? next - 1 + order.length : next) % order.length]?.focus();
}
