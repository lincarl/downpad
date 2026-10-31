import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { MenuRows, menuSurfaceClassName, moveMenuFocus, type MenuItem } from "@/components/ui/menu";

export type { MenuItem };

interface ActiveMenu {
  host: HTMLDivElement;
  root: Root;
  menu: HTMLElement;
  restoreFocus: HTMLElement | null;
  onDismiss?: () => void;
}

let active: ActiveMenu | null = null;
let listenerTimer: ReturnType<typeof setTimeout> | null = null;

export function closeContextMenu(): void {
  closeActiveMenu(true);
}

function closeActiveMenu(restoreFocus: boolean, activated = false): void {
  if (listenerTimer) clearTimeout(listenerTimer);
  listenerTimer = null;
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("focusin", onFocusIn);
  window.removeEventListener("blur", closeContextMenu);
  const current = active;
  active = null;
  if (!current) return;
  disposeReactRoot(current.root, current.host);
  if (restoreFocus && current.restoreFocus?.isConnected) current.restoreFocus.focus();
  if (!activated) current.onDismiss?.();
}

export function isContextMenuOpen(): boolean {
  return active !== null;
}

function onPointerDown(event: Event): void {
  if (active && !active.menu.contains(event.target as Node)) closeContextMenu();
}

/** A shortcut can move to another editor without an outside pointer click. */
function onFocusIn(event: FocusEvent): void {
  if (active && !active.menu.contains(event.target as Node)) closeActiveMenu(false);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active) return;
  // Escape closes the menu. So does Tab: a context menu has no button in the
  // tab order, so focus returns to where the menu was opened.
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    return;
  }
  if (!moveMenuFocus(active.menu, event.key)) return;
  event.preventDefault();
  event.stopPropagation();
}

/** Open a menu of `items` at the pointer position, named `label` for screen
 *  readers, such as "Tab". It replaces any menu that is already open. */
export function showContextMenu(x: number, y: number, items: MenuItem[], label: string, onDismiss?: () => void): void {
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeActiveMenu(false);
  const host = document.createElement("div");
  host.dataset.reactContextMenu = "";
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<ContextMenu x={x} y={y} items={items} label={label} />);
  });
  const menu = host.querySelector<HTMLElement>(".md-context-menu");
  if (!menu) {
    disposeReactRoot(root, host);
    return;
  }
  active = { host, root, menu, restoreFocus, onDismiss };
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth)
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight)
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  // Escape/keyboard navigation should work as soon as the menu is visible. Only
  // the outside-pointer listener is delayed so the opening right-click cannot
  // immediately close its own menu.
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn);
  window.addEventListener("blur", closeContextMenu);
  menu.querySelector<HTMLButtonElement>(".md-context-menu-item:not(.disabled)")?.focus();
  listenerTimer = setTimeout(() => {
    listenerTimer = null;
    if (active?.menu !== menu) return;
    document.addEventListener("pointerdown", onPointerDown, true);
  }, 0);
}

/** The menu element at `x`, `y`, named `label` for screen readers. Choosing a
 *  row closes the menu before the row's command runs. */
function ContextMenu({ x, y, items, label }: { x: number; y: number; items: MenuItem[]; label: string }) {
  const style: CSSProperties = { left: x, top: y };
  return (
    <div
      className={cn("md-context-menu fixed z-[1100]", menuSurfaceClassName)}
      role="menu"
      aria-label={label}
      style={style}
    >
      <MenuRows
        items={items}
        onActivate={(item) => {
          closeActiveMenu(true, true);
          void item.run();
        }}
      />
    </div>
  );
}
