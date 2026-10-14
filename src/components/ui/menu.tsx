import type { KeyboardEvent, ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** One row of a popup menu: the application menu, toolbar dropdowns and context menus. */
export interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
  icon?: LucideIcon;
  /** Shortcut hint shown at the row's right end. */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Marks an active toggle or choice with an accent check at the row's right end. */
  checked?: boolean;
  separatorBefore?: boolean;
  /** Caption printed above this row, after its separator, to name a group of rows. */
  section?: string;
}

/** The floating surface every menu shares: popover fill, hairline rim, 10px corners. */
export const menuSurfaceClassName = cn(
  "min-w-[180px] rounded-[10px] border border-line-menu bg-popover p-1.5",
  "font-[var(--font-ui)] text-[13px] leading-[18px] text-ink",
  "shadow-[0_10px_28px_rgb(0_0_0/0.22)]",
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
            "md-menu-section select-none px-2 pb-[3px] text-[11px] font-semibold tracking-[0.02em] text-ink-menu-header",
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
          "md-context-menu-item group my-px flex h-[29px] w-full cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 text-left font-[inherit] text-[inherit] outline-none",
          "hover:bg-row-hover focus-visible:bg-row-hover",
          item.danger && "danger text-ink-danger",
          item.disabled && "disabled cursor-default text-ink-disabled hover:bg-transparent",
        )}
        role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={item.checked}
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
            {Icon && <Icon aria-hidden="true" focusable="false" absoluteStrokeWidth strokeWidth={1} />}
          </span>
        )}
        <span className="md-context-menu-label flex-1 whitespace-nowrap pr-2">{item.label}</span>
        {item.shortcut && (
          <span className="md-context-menu-key whitespace-nowrap pl-3 text-[12px] text-ink-faint">
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
