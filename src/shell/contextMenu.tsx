import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";

export interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface ActiveMenu {
  host: HTMLDivElement;
  root: Root;
  menu: HTMLElement;
  restoreFocus: HTMLElement | null;
}

let active: ActiveMenu | null = null;
let listenerTimer: ReturnType<typeof setTimeout> | null = null;

export function closeContextMenu(): void {
  closeActiveMenu(true);
}

function closeActiveMenu(restoreFocus: boolean): void {
  if (listenerTimer) clearTimeout(listenerTimer);
  listenerTimer = null;
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("blur", closeContextMenu);
  const current = active;
  active = null;
  if (!current) return;
  disposeReactRoot(current.root, current.host);
  if (restoreFocus && current.restoreFocus?.isConnected) current.restoreFocus.focus();
}

export function isContextMenuOpen(): boolean {
  return active !== null;
}

function onPointerDown(event: Event): void {
  if (active && !active.menu.contains(event.target as Node)) closeContextMenu();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    return;
  }
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  const rows = Array.from(
    active.menu.querySelectorAll<HTMLButtonElement>(".md-context-menu-item:not(.disabled)"),
  );
  if (!rows.length) return;
  event.preventDefault();
  event.stopPropagation();
  const current = rows.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = rows.length - 1;
  else if (current < 0) next = step > 0 ? 0 : rows.length - 1;
  else next = (current + step + rows.length) % rows.length;
  rows[next].focus();
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeActiveMenu(false);
  const host = document.createElement("div");
  host.dataset.reactContextMenu = "";
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<ContextMenu x={x} y={y} items={items} />);
  });
  const menu = host.querySelector<HTMLElement>(".md-context-menu");
  if (!menu) {
    disposeReactRoot(root, host);
    return;
  }
  active = { host, root, menu, restoreFocus };
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth)
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight)
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  // Escape/keyboard navigation should work as soon as the menu is visible. Only
  // the outside-pointer listener is delayed so the opening right-click cannot
  // immediately close its own menu.
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", closeContextMenu);
  menu.querySelector<HTMLButtonElement>(".md-context-menu-item:not(.disabled)")?.focus();
  listenerTimer = setTimeout(() => {
    listenerTimer = null;
    if (active?.menu !== menu) return;
    document.addEventListener("pointerdown", onPointerDown, true);
  }, 0);
}

function ContextMenu({ x, y, items }: { x: number; y: number; items: MenuItem[] }) {
  const withIcons = items.some((item) => item.icon);
  const style: CSSProperties = { left: x, top: y };
  return (
    <div
      className="md-context-menu fixed z-[1100] min-w-[180px] rounded-lg border border-border bg-background p-1 font-[var(--font-ui)] text-[13px] text-foreground shadow-[0_8px_28px_rgba(0,0,0,0.25)] [&_.md-context-menu-sep]:mx-1.5 [&_.md-context-menu-sep]:my-1 [&_.md-context-menu-sep]:h-px [&_.md-context-menu-sep]:bg-border"
      role="menu"
      style={style}
    >
      {items.map((item, index) => (
        <MenuRow key={`${item.label}-${index}`} item={item} withIcons={withIcons} />
      ))}
    </div>
  );
}

function MenuRow({ item, withIcons }: { item: MenuItem; withIcons: boolean }) {
  const Icon = item.icon;
  return (
    <>
      {item.separatorBefore && <div className="md-context-menu-sep" role="separator" />}
      <button
        type="button"
        className={cn(
          "md-context-menu-item group flex w-full cursor-pointer items-center gap-2.5 rounded-[5px] border-0 bg-transparent px-2.5 py-1.5 text-left font-[inherit] text-[inherit] outline-none hover:bg-primary hover:text-primary-foreground focus-visible:bg-primary focus-visible:text-primary-foreground",
          item.danger &&
            "danger text-[#b00020] hover:text-primary-foreground focus-visible:text-primary-foreground",
          item.disabled && "disabled cursor-default text-muted-foreground opacity-[.55]",
        )}
        role="menuitem"
        disabled={item.disabled}
        onClick={
          item.disabled
            ? undefined
            : () => {
                closeContextMenu();
                void item.run();
              }
        }
      >
        {withIcons && (
          <span className="md-context-menu-icon size-4 shrink-0 opacity-[.85] [&_svg]:block [&_svg]:size-4">
            {Icon && <Icon aria-hidden="true" focusable="false" />}
          </span>
        )}
        <span className="md-context-menu-label flex-1 whitespace-nowrap">{item.label}</span>
        {item.shortcut && (
          <span className="md-context-menu-key whitespace-nowrap text-xs text-muted-foreground group-hover:text-primary-foreground group-hover:opacity-[.78] group-focus-visible:text-primary-foreground group-focus-visible:opacity-[.78]">
            {item.shortcut}
          </span>
        )}
      </button>
    </>
  );
}
