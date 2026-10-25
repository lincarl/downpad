import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  Code,
  Columns2,
  File,
  FileCode2,
  FilePlus2,
  FileText,
  FolderOpen,
  History,
  Menu,
  Minus,
  Moon,
  Plus,
  Printer,
  Save,
  SaveAll,
  Search,
  Settings,
  Sun,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Store } from "@/state/store";
import { hasUnsavedChanges, shownLayout, type BannerState, type EditorLayout, type Tab } from "@/state/types";
import { StoreProvider, useAppState } from "@/app/StoreProvider";
import { AppRuntime, RETRY_DOCUMENT_VIEW } from "@/app/AppRuntime";
import { AppRuntimeProvider, useAppRuntime } from "@/app/AppRuntimeContext";
import { useOwnedAppRuntime } from "@/app/useAppRuntime";
import { useDocumentTitle } from "@/app/useDocumentTitle";
import { captureFocus } from "@/app/restoreFocus";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MenuRows, focusBeside, menuSurfaceClassName, onMenuKeyDown, type MenuItem } from "@/components/ui/menu";
import { FileCopyIcon, FolderCopyIcon } from "@/components/icons";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipLabel, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { countWords } from "@/document/wordcount";
import { byteLength, formatSize } from "@/document/docSize";
import { dirName } from "@/home/recentFormat";
import { showContextMenu } from "@/shell/contextMenu";
import { EditorIsland } from "@/editor/EditorIsland";
import { middleTruncate } from "@/editor/wysiwyg/linkView";
import type { EditorHost } from "@/editor/EditorHost";

export interface AppProps {
  store: Store;
}

/** Mervin draws chrome icons with a 1px line at any size. lucide's absolute stroke
 *  scales by the `size` prop, so each icon passes the size it renders at. */
const TOOL_ICON = { size: 20, absoluteStrokeWidth: true, strokeWidth: 1 } as const;
const SMALL_ICON = { size: 16, absoluteStrokeWidth: true, strokeWidth: 1 } as const;

/** Text-size presets offered by the toolbar's size control. */
const TEXT_SIZES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export function App({ store }: AppProps) {
  return (
    <StoreProvider store={store}>
      <TooltipProvider delayDuration={600}>
        <AppContent store={store} />
      </TooltipProvider>
    </StoreProvider>
  );
}

function AppContent({ store }: { store: Store }) {
  const state = useAppState((snapshot) => snapshot);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const recentHostRef = useRef<HTMLDivElement>(null);
  const findHostRef = useRef<HTMLDivElement>(null);
  const [editorHost, setEditorHost] = useState<EditorHost | null>(null);
  const [recentSummary, setRecentSummary] = useState("");
  const runtimeRefs = {
    editorArea: editorAreaRef,
    recentHost: recentHostRef,
    findHost: findHostRef,
  };
  const onEditorHostReady = useCallback((host: EditorHost) => {
    setEditorHost(host);
  }, []);
  const onEditorHostDisposed = useCallback((host: EditorHost) => {
    // A delayed cleanup from Strict Mode's first setup must never clear the
    // replacement host published by the replayed setup.
    setEditorHost((current) => (current === host ? null : current));
  }, []);
  const runtime = useOwnedAppRuntime(store, editorHost, runtimeRefs, setRecentSummary);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  useDocumentTitle(state.activeTabId, state.doc.filePath, activeTab ? hasUnsavedChanges(activeTab) : false);

  const editorVisible = state.view !== "recent";
  const editorLayout = editorVisible ? shownLayout(state) : "document";

  return (
    <AppRuntimeProvider runtime={runtime}>
      {/* The single column is exactly as wide as the window. A row that needs
          more room, such as the status bar with a long path, fits its own
          content to it instead of making every row wider than the window.
          `data-started` turns "true" once startup has finished, which the
          Electron tests wait for before they act. */}
      <div
        className="app grid h-screen grid-cols-[minmax(0,1fr)] grid-rows-[39px_46px_auto_minmax(0,1fr)_22px] overflow-hidden bg-window text-ink"
        data-testid="app-shell"
        data-started={state.started}
      >
        <Toolbar />
        <TabStrip />
        <Banner />
        <main className="main-region relative row-start-4 min-h-0">
          <div
            ref={editorAreaRef}
            id="document-editor-panel"
            role="tabpanel"
            aria-labelledby={state.activeTabId ? `document-tab-${state.activeTabId}` : undefined}
            className={cn(
              "editor-area absolute inset-0 flex justify-center overflow-auto",
              "bg-canvas text-[var(--editor-surface-fg)]",
              editorLayout === "document" && "[scrollbar-gutter:stable]",
              editorLayout === "split" && "split",
              editorLayout === "markdown" && "markdown-only",
            )}
            hidden={!editorVisible}
          >
            {/* Find can give the page more room above its first line, to keep a
                match there clear of the find card (findReveal.ts). */}
            <div
              className={cn(
                "editor-column mx-auto w-full max-w-[var(--editor-width)]",
                "px-6 pt-[max(1rem,var(--find-room,0px))] pb-16",
              )}
            >
              <EditorIsland
                store={store}
                onHostReady={onEditorHostReady}
                onHostDisposed={onEditorHostDisposed}
              />
            </div>
          </div>
          {/* The find card floats over the top right of the document, 12px
              below the tabs and clear of the 12px scroll bar.
              It grows downward when the replace row opens.
              Its left end stays at least 12px from the left edge, and a narrower card
              moves its options under the find field (findBar.tsx). Find
              scrolls each match clear of it (findReveal.ts). */}
          <div
            ref={findHostRef}
            className="find-host pointer-events-none absolute top-3 right-6 z-20 flex max-w-[calc(100%-36px)] justify-end"
            hidden={!editorVisible}
          />
          <div
            ref={recentHostRef}
            className="recent-host absolute inset-0"
            hidden={editorVisible}
          />
        </main>
        <StatusBar recentSummary={recentSummary} />
      </div>
    </AppRuntimeProvider>
  );
}

function Toolbar() {
  const runtime = useAppRuntime();
  const { view, activeTabId, settings, find } = useAppState((state) => state);
  const editorLayout = useAppState(shownLayout);
  const inEditor = view !== "recent" && activeTabId !== null;
  const documentIsDark =
    settings.editorTheme === "dark" ||
    (settings.editorTheme === "follow-ui" &&
      document.documentElement.dataset.editorTheme === "dark");
  const layouts: Array<{ value: EditorLayout; label: string; title: string }> = [
    { value: "document", label: "Document", title: "Show the document only" },
    { value: "split", label: "Split", title: "Show the document and Markdown source side by side" },
    { value: "markdown", label: "Markdown", title: "Show the Markdown source only" },
  ];

  return (
    <header className="toolbar row-start-1 flex min-w-0 items-center gap-1 border-b border-line-toolbar bg-window px-[3px]">
      <AppMenu inEditor={inEditor} documentIsDark={documentIsDark} />
      <ToolSeparator />
      <SplitButton
        className="toolbar-open"
        icon={FolderOpen}
        label="Open"
        tooltip="Open (Ctrl+O)"
        menuLabel="Open options"
        onClick={() => runtime?.openDocument()}
        items={[
          { label: "Open…", icon: FolderOpen, run: () => runtime?.openDocument() },
          { label: "New document", icon: FilePlus2, run: () => runtime?.newDocument() },
          { label: "Recent files", icon: History, run: () => runtime?.showRecentView(), separatorBefore: true },
        ]}
      />
      <SplitButton
        className="toolbar-save"
        icon={Save}
        label="Save"
        tooltip="Save (Ctrl+S)"
        menuLabel="Save options"
        disabled={!inEditor}
        onClick={() => runtime?.saveDocument()}
        items={[
          { label: "Save", icon: Save, run: () => runtime?.saveDocument() },
          { label: "Save as…", icon: SaveAll, run: () => runtime?.saveDocumentAs() },
          { label: "Copy as Markdown", icon: FileCode2, run: () => runtime?.copyDocumentMarkdown(), separatorBefore: true },
        ]}
      />
      <ToolSeparator className="max-[574px]:hidden" />
      <ToggleGroup
        type="single"
        value={inEditor ? editorLayout : ""}
        disabled={!inEditor}
        className="toolbar-view inline-flex max-[574px]:hidden"
        aria-label="Editor view"
        onValueChange={(value) => {
          if (value) runtime?.selectLayout(value as EditorLayout);
        }}
      >
        {layouts.map(({ value, label, title }) => {
          const active = inEditor && editorLayout === value;
          return (
            <TooltipLabel key={value} text={title}>
            <ToggleGroupItem
              value={value}
              className={cn(
                "toolbar-seg h-[29px] cursor-pointer border border-l-0 border-line bg-fill px-3.5 text-[12px] font-normal leading-4 text-ink",
                "first:rounded-l-control first:border-l last:rounded-r-control",
                "hover:bg-[color-mix(in_srgb,var(--fill),var(--ink)_8%)] focus-ring",
                "disabled:cursor-default disabled:bg-transparent disabled:text-ink-disabled disabled:opacity-100",
                active && "active border-accent bg-accent text-accent-fg hover:bg-accent-hover",
              )}
            >
              {label}
            </ToggleGroupItem>
            </TooltipLabel>
          );
        })}
      </ToggleGroup>
      <ToolSeparator className="max-[683px]:hidden" />
      <ToolButton
        className="max-[773px]:hidden"
        label="Decrease text size"
        disabled={!inEditor}
        onClick={() => runtime?.zoomDocument(-0.1)}
      >
        <Minus aria-hidden="true" {...TOOL_ICON} />
      </ToolButton>
      <TextSizeControl className="max-[683px]:hidden" disabled={!inEditor} scale={settings.editorFontScale} />
      <ToolButton
        className="max-[773px]:hidden"
        label="Increase text size"
        disabled={!inEditor}
        onClick={() => runtime?.zoomDocument(0.1)}
      >
        <Plus aria-hidden="true" {...TOOL_ICON} />
      </ToolButton>
      <ToolSeparator />
      <ToolButton label="Print" tooltip="Print (Ctrl+P)" disabled={!inEditor} onClick={() => runtime?.printDocument()}>
        <Printer aria-hidden="true" {...TOOL_ICON} />
      </ToolButton>
      <ToolButton
        label="Find"
        tooltip="Find (Ctrl+F)"
        disabled={!inEditor}
        pressed={inEditor && find.open}
        onClick={() => runtime?.toggleFind()}
      >
        <Search aria-hidden="true" {...TOOL_ICON} />
      </ToolButton>
      <ToolSeparator />
      <ToolButton
        label={documentIsDark ? "Switch to light document theme" : "Switch to dark document theme"}
        disabled={!inEditor}
        onClick={() => runtime?.toggleDocumentTheme()}
      >
        {documentIsDark ? (
          <Sun aria-hidden="true" className="document-theme-glyph" {...TOOL_ICON} />
        ) : (
          <Moon aria-hidden="true" className="document-theme-glyph" {...TOOL_ICON} />
        )}
      </ToolButton>
    </header>
  );
}

/** A Mervin toolbar divider: a 1px hairline, 20px tall, centred in a 5px slot. */
function ToolSeparator({ className }: { className?: string }) {
  return (
    <Separator orientation="vertical" className={cn("toolbar-sep mx-0.5 h-5 w-px shrink-0 bg-hairline", className)} />
  );
}

/** Focus the first enabled row when a command menu opens, instead of the popover itself. */
function focusFirstMenuRow(event: Event): void {
  event.preventDefault();
  const menu = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  menu?.querySelector<HTMLButtonElement>(".md-context-menu-item:not(.disabled)")?.focus();
}

/** Focus the current choice when a list of choices opens, like a combo box. */
function focusCheckedMenuRow(event: Event): void {
  event.preventDefault();
  const menu = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  menu?.querySelector<HTMLButtonElement>(".md-context-menu-item[aria-checked='true']")?.focus();
}

/**
 * Open state for a toolbar popover menu and the activation that closes it,
 * returns focus to its button and then runs the item. Radix returns focus on
 * Escape but not when an item closes the menu, and a dialog the item opens
 * needs that focus to know where to return.
 *
 * `menuProps` go on the menu's PopoverContent: arrow keys move between rows,
 * and Tab or Shift+Tab closes the menu and moves focus to the control after or
 * before its button, instead of cycling through the rows.
 */
function useToolbarMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tabbing = useRef<"forward" | "backward" | null>(null);
  const activate = (item: MenuItem): void => {
    setOpen(false);
    triggerRef.current?.focus();
    setTimeout(() => void item.run(), 0);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") {
      onMenuKeyDown(event);
      return;
    }
    event.preventDefault();
    tabbing.current = event.shiftKey ? "backward" : "forward";
    setOpen(false);
  };
  // Radix focuses the button after the menu closes; a Tab moves on from it.
  const onCloseAutoFocus = (event: Event): void => {
    const direction = tabbing.current;
    tabbing.current = null;
    if (!direction || !triggerRef.current) return;
    event.preventDefault();
    focusBeside(triggerRef.current, direction === "backward");
  };
  return { open, setOpen, triggerRef, activate, menuProps: { onKeyDown, onCloseAutoFocus } };
}

/** The hamburger menu: file actions, document actions, view choices and Settings. */
function AppMenu({ inEditor, documentIsDark }: { inEditor: boolean; documentIsDark: boolean }) {
  const runtime = useAppRuntime();
  const editorLayout = useAppState(shownLayout);
  const { open, setOpen, triggerRef, activate, menuProps } = useToolbarMenu();
  const layout = (value: EditorLayout, label: string, icon: LucideIcon): MenuItem => ({
    label,
    icon,
    disabled: !inEditor,
    checked: inEditor && editorLayout === value,
    radio: true,
    run: () => runtime?.selectLayout(value),
  });
  const items: MenuItem[] = [
    { label: "New document", icon: FilePlus2, run: () => runtime?.newDocument() },
    { label: "Open…", icon: FolderOpen, run: () => runtime?.openDocument() },
    { label: "Recent files", icon: History, run: () => runtime?.showRecentView() },
    { label: "Save", icon: Save, disabled: !inEditor, separatorBefore: true, run: () => runtime?.saveDocument() },
    { label: "Save as…", icon: SaveAll, disabled: !inEditor, run: () => runtime?.saveDocumentAs() },
    { label: "Copy as Markdown", icon: FileCode2, disabled: !inEditor, run: () => runtime?.copyDocumentMarkdown() },
    { label: "Print", icon: Printer, disabled: !inEditor, run: () => runtime?.printDocument() },
    { ...layout("document", "Document", FileText), separatorBefore: true, section: "View" },
    layout("split", "Split", Columns2),
    layout("markdown", "Markdown", Code),
    {
      label: "Dark document",
      icon: Moon,
      disabled: !inEditor,
      checked: inEditor && documentIsDark,
      run: () => runtime?.toggleDocumentTheme(),
    },
    { label: "Settings", icon: Settings, separatorBefore: true, run: () => runtime?.openSettings() },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipLabel text="Menu">
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="tool"
            size="tool-icon"
            className="toolbar-menu"
            aria-label="Application menu"
            aria-haspopup="menu"
          >
            <Menu aria-hidden="true" {...TOOL_ICON} />
          </Button>
        </PopoverTrigger>
      </TooltipLabel>
      <PopoverContent
        align="start"
        sideOffset={0}
        className={cn("app-menu z-[100] min-w-[210px]", menuSurfaceClassName)}
        role="menu"
        aria-label="Application menu"
        {...menuProps}
        onOpenAutoFocus={focusFirstMenuRow}
      >
        <MenuRows
          items={items}
          onActivate={activate}
        />
      </PopoverContent>
    </Popover>
  );
}

/** An icon-only toolbar button with a tooltip. `pressed` marks a toggle that is on. */
function ToolButton({
  className,
  label,
  tooltip = label,
  disabled,
  pressed,
  onClick,
  children,
}: {
  className?: string;
  label: string;
  tooltip?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <TooltipLabel text={tooltip}>
      <Button
        type="button"
        variant="tool"
        size="tool-icon"
        className={cn("toolbar-icon", className)}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </TooltipLabel>
  );
}

/**
 * Mervin's split toolbar button: one outlined box holding the main action (icon
 * and label) and an 18px chevron strip that opens a menu of related actions.
 */
function SplitButton({
  className,
  icon: Icon,
  label,
  tooltip,
  menuLabel,
  disabled,
  onClick,
  items,
}: {
  className: string;
  icon: LucideIcon;
  label: string;
  tooltip: string;
  menuLabel: string;
  disabled?: boolean;
  onClick(): void;
  items: MenuItem[];
}) {
  const { open, setOpen, triggerRef, activate, menuProps } = useToolbarMenu();
  // Hover, pressed and open washes belong to the whole box, as in Mervin; the
  // two parts only carry their own keyboard focus outline.
  const part = cn(
    "flex h-full cursor-pointer items-center bg-transparent text-ink-body outline-none",
    "disabled:cursor-default disabled:text-ink-disabled",
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            "toolbar-split inline-flex h-[33px] shrink-0 rounded-control border",
            // The main part's keyboard focus rings the whole box, clear of its label.
            "has-[.toolbar-file:focus-visible]:outline-2 has-[.toolbar-file:focus-visible]:outline-offset-1",
            "has-[.toolbar-file:focus-visible]:outline-solid has-[.toolbar-file:focus-visible]:outline-accent",
            disabled
              ? "pointer-events-none border-line-tool-disabled"
              : cn(
                  "border-line-tool hover:border-line-tool-strong hover:bg-hover",
                  "has-[:active]:bg-pressed has-[[data-state=open]]:border-line-tool-strong has-[[data-state=open]]:bg-pressed",
                ),
            className,
          )}
        >
          <TooltipLabel text={tooltip}>
            <button
              type="button"
              className={cn(
                part,
                "toolbar-file gap-0.5 rounded-l-control pl-2.5 text-[12px] leading-4 max-[849px]:pr-1",
              )}
              disabled={disabled}
              onClick={onClick}
            >
              <Icon aria-hidden="true" {...TOOL_ICON} />
              {/* Narrow windows keep the icon and drop the label before anything clips. */}
              <span className="toolbar-file-label max-[849px]:hidden">{label}</span>
            </button>
          </TooltipLabel>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              className={cn(part, "toolbar-caret focus-ring-inset w-[17px] justify-center rounded-r-control")}
              aria-label={menuLabel}
              aria-haspopup="menu"
              disabled={disabled}
            >
              <ChevronDown aria-hidden="true" size={13} absoluteStrokeWidth strokeWidth={1.1} />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      {/* Toolbar menus drop from the button's left edge, directly below it. */}
      <PopoverContent
        align="start"
        sideOffset={0}
        className={cn("z-[100]", menuSurfaceClassName)}
        role="menu"
        aria-label={menuLabel}
        {...menuProps}
        onOpenAutoFocus={focusFirstMenuRow}
      >
        <MenuRows
          items={items}
          onActivate={activate}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The document text size readout, which opens a list of size presets like Mervin's zoom combo. */
function TextSizeControl({
  className,
  disabled,
  scale,
}: {
  className?: string;
  disabled: boolean;
  scale: number;
}) {
  const runtime = useAppRuntime();
  const { open, setOpen, triggerRef, activate, menuProps } = useToolbarMenu();
  const current = Math.round(scale * 100);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipLabel text="Document text size">
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className={cn(
              "zoom-readout relative flex h-[29px] w-24 shrink-0 cursor-pointer items-center justify-center rounded-control border border-line bg-well pr-5 pl-2 text-[12px] text-ink-primary outline-none",
              "hover:border-line-strong focus-visible:border-accent aria-expanded:border-accent",
              "disabled:cursor-default disabled:border-line-disabled disabled:text-ink-disabled",
              className,
            )}
            aria-label={`Document text size, ${current}%`}
            aria-haspopup="menu"
            disabled={disabled}
          >
            {current}%
            <ChevronDown
              aria-hidden="true"
              className="absolute right-2 text-ink-body [button:disabled_&]:text-ink-disabled"
              size={12}
              absoluteStrokeWidth
              strokeWidth={1.1}
            />
          </button>
        </PopoverTrigger>
      </TooltipLabel>
      <PopoverContent
        align="start"
        sideOffset={0}
        className={cn(menuSurfaceClassName, "z-[100] w-[var(--radix-popover-trigger-width)] min-w-0")}
        role="menu"
        aria-label="Document text size"
        {...menuProps}
        onOpenAutoFocus={focusCheckedMenuRow}
      >
        <MenuRows
          items={TEXT_SIZES.map((size) => ({
            label: `${Math.round(size * 100)}%`,
            checked: Math.round(size * 100) === current,
            radio: true,
            run: () => runtime?.zoomDocument(size - scale),
          }))}
          onActivate={activate}
        />
      </PopoverContent>
    </Popover>
  );
}

function TabStrip() {
  const runtime = useAppRuntime();
  const { tabs, activeTabId, view } = useAppState((state) => state);
  const recentActive = view === "recent";
  const tablistRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when tabs overflow the strip.
  useEffect(() => {
    if (!activeTabId) return;
    // Optional call: test DOMs (jsdom) have no scrollIntoView.
    document.getElementById(`document-tab-${activeTabId}`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return;
    const tabElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='tab']"),
    );
    const current = tabElements.indexOf(target);
    if (current < 0) return;

    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabElements.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabElements.length) % tabElements.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabElements.length - 1;
    else return;

    event.preventDefault();
    tabElements[next].focus();
    const tabId = tabElements[next].dataset.tabId;
    if (tabId) {
      runtime?.activateDocumentTab(tabId);
      requestAnimationFrame(() => tabElements[next]?.focus());
    }
  };

  return (
    <nav
      className="tabstrip row-start-2 flex min-w-0 items-center gap-2 border-b border-line-chrome-row bg-bar px-2"
      aria-label="Document tabs"
    >
      <button
        type="button"
        className={cn(
          "toolbar-recent grid h-[29px] shrink-0 cursor-pointer place-items-center rounded-[6px] border border-line-push bg-transparent px-3 text-[12px] leading-4 text-ink-body outline-none",
          "hover:border-line-strong hover:bg-hover focus-ring",
          recentActive &&
            "active border-accent bg-fill font-semibold text-accent hover:border-accent hover:bg-fill dark:font-normal dark:text-ink-primary",
        )}
        onClick={() => runtime?.showRecentView()}
      >
        {/* The bold copy reserves the active width so the pill never changes size. */}
        <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-semibold">
          Recent
        </span>
        <span className="col-start-1 row-start-1">Recent</span>
      </button>
      {/* Tabs shrink to a floor, then the strip scrolls. Its scroll bar stays
          hidden as in Mervin, so the mouse wheel scrolls it sideways. */}
      <div
        ref={tablistRef}
        className="tab-list flex h-full min-w-0 items-end gap-1 overflow-x-auto overflow-y-hidden pb-[5px]"
        role="tablist"
        aria-label="Open documents"
        onKeyDown={onKeyDown}
        onWheel={(event) => {
          const strip = tablistRef.current;
          if (!strip || event.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) return;
          strip.scrollLeft += event.deltaY;
        }}
      >
        {tabs.map((tab) => (
          <DocumentTab
            key={tab.id}
            tab={tab}
            active={!recentActive && tab.id === activeTabId}
            focusable={tab.id === activeTabId || (activeTabId === null && tab === tabs[0])}
            runtime={runtime}
          />
        ))}
      </div>
      <TooltipLabel text="New document (Ctrl+N)">
        <button
          type="button"
          className={cn(
            "tab-new mb-[5px] flex size-7 shrink-0 cursor-pointer items-center justify-center self-end rounded-control border-0 bg-transparent p-0 text-ink-body outline-none",
            "hover:bg-hover focus-ring",
          )}
          aria-label="New document"
          onClick={() => runtime?.newDocument()}
        >
          <Plus aria-hidden="true" {...SMALL_ICON} />
        </button>
      </TooltipLabel>
    </nav>
  );
}

function DocumentTab({
  tab,
  active,
  focusable,
  runtime,
}: {
  tab: Tab;
  active: boolean;
  focusable: boolean;
  runtime: AppRuntime | null;
}) {
  const showMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const path = tab.doc.filePath;
    const folder = path ? dirName(path) : "";
    showContextMenu(event.clientX, event.clientY, [
      { label: "Open folder", icon: FolderOpen, disabled: !path, run: () => { if (path) runtime?.revealPath(path); } },
      { label: "Copy file path", icon: FileCopyIcon, disabled: !path, separatorBefore: true, run: () => { if (path) runtime?.copyText(path); } },
      { label: "Copy folder path", icon: FolderCopyIcon, disabled: !folder, run: () => { if (folder) runtime?.copyText(folder); } },
      { label: "Close all tabs", icon: X, separatorBefore: true, run: () => runtime?.closeEveryTab() },
    ], "Tab");
  };
  return (
    <button
      id={`document-tab-${tab.id}`}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls="document-editor-panel"
      aria-keyshortcuts="Delete"
      tabIndex={focusable ? 0 : -1}
      data-tab-id={tab.id}
      className={cn(
        "tab group flex h-7 min-w-[96px] max-w-[260px] cursor-pointer select-none items-center gap-2.5",
        "whitespace-nowrap rounded-t-control border border-b-0 border-transparent bg-transparent",
        "pr-[3px] pl-3 text-[12px] leading-4 text-ink-body outline-none",
        "hover:bg-hover focus-ring-inset",
        active &&
          "active border-line bg-fill font-semibold text-accent hover:bg-fill dark:border-line-disabled dark:font-normal dark:text-ink-primary",
      )}
      title={tab.doc.filePath ?? "Untitled"}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest(".tab-close")) {
          runtime?.closeDocumentTab(tab.id);
          return;
        }
        runtime?.activateDocumentTab(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        event.preventDefault();
        event.stopPropagation();
        const tablist = event.currentTarget.closest("[role='tablist']") as HTMLElement | null;
        const tabElements = tablist
          ? Array.from(tablist.querySelectorAll<HTMLElement>("[role='tab']"))
          : [];
        const current = tabElements.indexOf(event.currentTarget);
        runtime?.closeDocumentTab(tab.id);
        requestAnimationFrame(() => {
          if (!tablist) return;
          const remaining = Array.from(
            tablist.querySelectorAll<HTMLElement>("[role='tab']"),
          );
          remaining[Math.min(Math.max(current, 0), remaining.length - 1)]?.focus();
        });
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          runtime?.closeDocumentTab(tab.id);
        }
      }}
      onContextMenu={showMenu}
    >
      <File
        aria-hidden="true"
        className={cn("shrink-0", active ? "text-accent" : "text-ink-body")}
        {...SMALL_ICON}
      />
      <span className="tab-select flex min-w-0 flex-auto items-center gap-1.5">
        {hasUnsavedChanges(tab) && (
          <span aria-hidden="true" className="tab-dot size-[7px] shrink-0 rounded-full bg-accent" />
        )}
        <span className="tab-label overflow-hidden text-ellipsis">
          {fileLabel(tab.doc.filePath)}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "tab-close ml-3 flex size-4 shrink-0 cursor-pointer items-center justify-center",
          "rounded-[4px] text-ink-faint hover:bg-pressed hover:text-ink-body",
        )}
      >
        <X aria-hidden="true" className="size-3.5" strokeWidth={2} />
      </span>
    </button>
  );
}

/**
 * The notice bar under the tab row, in the look of Mervin's wait bar: a notice
 * band with a line along its bottom edge, the message, push buttons and a close.
 * It shows the app's banner, or else the notice that the active tab's Document
 * view failed.
 */
function Banner() {
  const runtime = useAppRuntime();
  const appBanner = useAppState((state) => state.banner);
  const failure = useAppState((state) =>
    state.view === "recent" ? undefined : state.tabs.find((tab) => tab.id === state.activeTabId)?.documentViewFailure,
  );
  const filePath = useAppState((state) => state.doc.filePath);
  const notice = !appBanner && failure && !failure.dismissed ? documentViewNotice(filePath, failure.message) : null;
  const banner = appBanner ?? notice;
  const shown = appBanner ? "banner" : notice ? "notice" : null;
  // Answering or dismissing the bar removes the focused button; focus then goes
  // back to where it was when the bar appeared instead of the page body. The
  // failure notice that shows again after the app's banner counts as a new bar.
  useEffect(() => (shown ? captureFocus() : undefined), [shown]);
  if (!banner) return <div className="banner row-start-3" hidden />;
  const error = banner.kind === "error";
  return (
    <Alert
      className={cn(
        "banner row-start-3 flex min-h-[43px] w-auto items-center gap-3.5 rounded-none border-0 border-b border-line-notice bg-notice px-4 py-1.5 text-[12px] text-ink-primary",
        error && "border-ink-danger/60 bg-[color-mix(in_srgb,var(--ink-danger)_14%,var(--window))]",
      )}
      data-kind={banner.kind}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {error && <TriangleAlert aria-hidden="true" className="shrink-0 text-ink-danger" {...SMALL_ICON} />}
      <AlertDescription
        className={cn(
          "banner-message flex-1 text-[12px] leading-4 text-inherit",
          // Two lines at most in a narrow window, breaking an over-long token
          // such as a file URL. The tooltip has the uncut text.
          notice && "line-clamp-2 [overflow-wrap:anywhere]",
        )}
        title={notice?.fullMessage}
      >
        {banner.message}
      </AlertDescription>
      <div className="flex shrink-0 items-center gap-1.5">
        {(banner.actions ?? []).map((action) => (
          <Button
            key={action.id}
            type="button"
            variant="outline"
            className="banner-btn"
            onClick={() => runtime?.handleBannerAction(action.id)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      <TooltipLabel text="Dismiss">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="banner-dismiss text-ink-soft"
          aria-label="Dismiss notification"
          onClick={() => runtime?.dismissBanner()}
        >
          <X aria-hidden="true" {...SMALL_ICON} />
        </Button>
      </TooltipLabel>
    </Alert>
  );
}

/** The notice for a tab shown in Markdown because its Document view failed,
 *  with its uncut text for the tooltip. */
function documentViewNotice(filePath: string | null, error: string): BannerState & { fullMessage: string } {
  const text = (name: string, detail: string): string =>
    `Downpad can't show ${name} in the Document view${detail ? ` (${detail})` : ""}, so it is open in the Markdown view.`;
  // The error's first line and the file name, cut short so the notice stays
  // two lines in a window about 800 px wide or wider.
  const name = fileLabel(filePath);
  const line = error.split("\n", 1)[0].trim();
  const chars = Array.from(line);
  const detail = chars.length > 60 ? `${chars.slice(0, 59).join("").trimEnd()}…` : line;
  return {
    kind: "error",
    message: text(middleTruncate(name, 40), detail),
    fullMessage: text(name, line),
    actions: [{ id: RETRY_DOCUMENT_VIEW, label: "Try again" }],
  };
}

const STATUS_BAR_CLASS = cn(
  "status-bar row-start-5 flex select-none items-center justify-between gap-3",
  "border-t border-line-chrome-row bg-status px-2 text-[12px] leading-4 text-ink",
  "dark:text-[11px] dark:text-ink-faint",
);

function StatusBar({ recentSummary }: { recentSummary: string }) {
  const { view, doc } = useAppState((state) => state);
  if (view === "recent") {
    return (
      <footer className={STATUS_BAR_CLASS}>
        <span className="status-left min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {recentSummary}
        </span>
        <span className="status-right shrink-0 whitespace-nowrap" />
      </footer>
    );
  }
  const path = doc.filePath ?? "Untitled";
  const words = countWords(doc.markdown);
  return (
    <footer className={STATUS_BAR_CLASS}>
      {/* A path too long for the room left of the word count ends in an
          ellipsis. Its tooltip has the whole path. */}
      <span
        className="status-left min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        title={path}
      >
        {path}
      </span>
      <span className="status-right shrink-0 whitespace-nowrap">
        {words.toLocaleString()} {words === 1 ? "word" : "words"} · {formatSize(byteLength(doc.markdown))}
      </span>
    </footer>
  );
}

function fileLabel(filePath: string | null): string {
  if (!filePath) return "Untitled";
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}
