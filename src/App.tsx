import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  File,
  FolderOpen,
  Menu,
  Minus,
  Moon,
  Plus,
  Printer,
  Save,
  Sun,
  X,
} from "lucide-react";
import type { Store } from "@/state/store";
import type { EditorLayout, Tab } from "@/state/types";
import { StoreProvider, useAppState } from "@/app/StoreProvider";
import { AppRuntime } from "@/app/AppRuntime";
import { AppRuntimeProvider, useAppRuntime } from "@/app/AppRuntimeContext";
import { useOwnedAppRuntime } from "@/app/useAppRuntime";
import { useDocumentTitle } from "@/app/useDocumentTitle";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { countWords } from "@/document/wordcount";
import { byteLength, formatKB } from "@/document/docSize";
import { dirName } from "@/home/recentFormat";
import { showContextMenu } from "@/shell/contextMenu";
import { EditorIsland } from "@/editor/EditorIsland";
import type { EditorHost } from "@/editor/EditorHost";

export interface AppProps {
  store: Store;
}

const TOOLBAR_BUTTON_CLASS = cn(
  "toolbar-btn cursor-pointer rounded-[6px] border border-[var(--chrome-border)]",
  "bg-[var(--editor-bg)] px-3 py-[5px] text-[13px] leading-normal font-normal",
  "text-[var(--chrome-fg)] [font-family:var(--font-ui)]",
  "hover:border-[var(--muted-fg)] hover:brightness-[.97] active:brightness-[.94]",
  "disabled:cursor-default disabled:text-[var(--muted-fg)] disabled:opacity-50",
  "disabled:hover:border-[var(--chrome-border)] disabled:hover:brightness-100",
);

const TAB_STRIP_CLASS = cn(
  "tabstrip row-start-2 flex items-end gap-[3px] overflow-x-auto",
  "border-b border-[var(--chrome-border)] bg-[var(--tabstrip-bg)] px-2 pt-1.5 pb-0",
  "[scrollbar-width:thin]",
);

const BANNER_CLASS = cn(
  "banner row-start-3 flex items-center gap-[10px] border-b border-[#e8d98a]",
  "bg-[#fff4ce] px-[14px] py-2 text-[13px] leading-normal text-[#3a3a00]",
);

const STATUS_BAR_CLASS = cn(
  "status-bar row-start-6 flex h-[26px] select-none items-center justify-between gap-3",
  "border-t border-[var(--chrome-border)] bg-[var(--chrome-bg)] px-3",
  "text-xs leading-[18px] text-[var(--muted-fg)]",
);

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
  useDocumentTitle(state.activeTabId, state.doc.filePath, state.doc.isDirty);

  const editorVisible = state.view !== "recent";
  const editorLayout = editorVisible ? state.editorLayout : "document";

  return (
    <AppRuntimeProvider runtime={runtime}>
      <div
        className="app grid h-screen grid-rows-[38px_45px_auto_auto_1fr_26px] overflow-hidden"
        data-testid="app-shell"
      >
        <Toolbar />
        <TabStrip />
        <Banner />
        <div ref={findHostRef} className="find-host row-start-4 min-w-0" />
        <main className="main-region relative row-start-5 min-h-0">
          <div
            ref={editorAreaRef}
            id="document-editor-panel"
            role="tabpanel"
            aria-labelledby={state.activeTabId ? `document-tab-${state.activeTabId}` : undefined}
            className={cn(
              "editor-area absolute inset-0 flex justify-center overflow-auto",
              "bg-[var(--editor-surface-bg)] text-[var(--editor-surface-fg)]",
              editorLayout === "split" && "split",
              editorLayout === "markdown" && "markdown-only",
            )}
            hidden={!editorVisible}
          >
            <div
              className={cn(
                "editor-column mx-auto w-full max-w-[var(--editor-width)]",
                "px-6 pt-4 pb-16",
              )}
            >
              <EditorIsland
                store={store}
                onHostReady={onEditorHostReady}
                onHostDisposed={onEditorHostDisposed}
              />
            </div>
          </div>
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
  const { view, activeTabId, editorLayout, settings } = useAppState((state) => state);
  const [menuOpen, setMenuOpen] = useState(false);
  const inEditor = view !== "recent" && activeTabId !== null;
  const documentIsDark =
    settings.editorTheme === "dark" ||
    (settings.editorTheme === "follow-ui" &&
      document.documentElement.dataset.editorTheme === "dark");
  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };
  const layouts: Array<{ value: EditorLayout; label: string; title: string }> = [
    { value: "document", label: "Document", title: "Show the document only" },
    { value: "split", label: "Split", title: "Show the document and Markdown source side by side" },
    { value: "markdown", label: "Markdown", title: "Show the Markdown source only" },
  ];

  return (
    <header
      className={cn(
        "toolbar row-start-1 flex items-center gap-2",
        "border-b border-[var(--chrome-border)] bg-[var(--chrome-bg)] px-2 py-1",
      )}
    >
      <div className="toolbar-group toolbar-left flex items-center gap-[3px]">
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="toolbar-menu size-[29px] rounded-[4px] border-0 bg-transparent p-0 text-[var(--muted-fg)] hover:bg-[var(--toolbar-hover)] hover:text-[var(--chrome-fg)]"
              aria-label="Application menu"
              title="Application menu"
            >
              <Menu aria-hidden="true" className="size-[19px]" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={5}
            className="app-menu z-[100] w-56 rounded-md border border-[var(--chrome-border)] bg-[var(--menu-bg)] p-1.5 text-[13px] text-[var(--chrome-fg)] shadow-xl"
          >
            <MenuAction label="Recent files" shortcut="" onClick={() => runMenuAction(() => runtime?.showRecentView())} />
            <MenuAction label="New document" shortcut="Ctrl+N" onClick={() => runMenuAction(() => runtime?.newDocument())} />
            <MenuAction label="Open document" shortcut="Ctrl+O" onClick={() => runMenuAction(() => runtime?.openDocument())} />
            <MenuAction label="Save" shortcut="Ctrl+S" disabled={!inEditor} onClick={() => runMenuAction(() => runtime?.saveDocument())} />
            <MenuAction label="Copy as Markdown" shortcut="" disabled={!inEditor} onClick={() => runMenuAction(() => runtime?.copyDocumentMarkdown())} />
            <MenuAction label="Print" shortcut="Ctrl+P" disabled={!inEditor} onClick={() => runMenuAction(() => runtime?.printDocument())} />
            <div className="my-1 h-px bg-[var(--chrome-border)]" />
            <MenuAction label="Settings" shortcut="" onClick={() => runMenuAction(() => runtime?.openSettings())} />
          </PopoverContent>
        </Popover>
        <Separator
          orientation="vertical"
          className="toolbar-sep mx-2 my-1 w-px self-stretch bg-[var(--chrome-border)]"
        />
        <Button type="button" variant="ghost" className={cn(TOOLBAR_BUTTON_CLASS, "toolbar-file border-0 bg-transparent px-1.5")} title="Open (Ctrl+O)" onClick={() => runtime?.openDocument()}>
          <FolderOpen aria-hidden="true" /><span className="toolbar-file-label">Open</span><ChevronDown aria-hidden="true" className="toolbar-caret" />
        </Button>
        <Button type="button" variant="ghost" className={cn(TOOLBAR_BUTTON_CLASS, "toolbar-file border-0 bg-transparent px-1.5")} title="Save (Ctrl+S)" disabled={!inEditor} onClick={() => runtime?.saveDocument()}>
          <Save aria-hidden="true" /><span className="toolbar-file-label">Save</span><ChevronDown aria-hidden="true" className="toolbar-caret" />
        </Button>
        <ToggleGroup
          type="single"
          value={inEditor ? editorLayout : ""}
          disabled={!inEditor}
          className="toolbar-view ml-[25px] inline-flex self-center"
          aria-label="Editor view"
          onValueChange={(value) => {
            if (value) runtime?.selectLayout(value as EditorLayout);
          }}
        >
          {layouts.map(({ value, label, title }) => {
            const active = inEditor && editorLayout === value;
            return (
              <ToggleGroupItem
                key={value}
                value={value}
                className={cn(
                  TOOLBAR_BUTTON_CLASS,
                  "toolbar-seg rounded-none border-l-0",
                  "first:rounded-l-[6px] first:border-l last:rounded-r-[6px]",
                  active &&
                    "active border-[var(--accent)] bg-[var(--accent)] font-semibold text-[var(--accent-fg)] hover:border-[var(--accent)] hover:brightness-[1.05]",
                )}
                title={title}
              >
                {label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </div>
      <div className="toolbar-group toolbar-right ml-[12px] flex items-center gap-[3px]">
        <Separator
          orientation="vertical"
          className="toolbar-sep mx-2 my-1 w-px self-stretch bg-[var(--chrome-border)]"
        />
        <IconButton label="Decrease text size" disabled={!inEditor} onClick={() => runtime?.zoomDocument(-0.1)}>
          <Minus aria-hidden="true" />
        </IconButton>
        <Button
          type="button"
          variant="outline"
          className="zoom-readout h-[29px] w-[96px] justify-center gap-5 rounded-[6px] border border-[var(--chrome-border)] bg-[var(--control-bg)] px-2 text-[12px] font-normal text-[var(--chrome-fg)]"
          title="Reset document text size"
          disabled={!inEditor}
          onClick={() => runtime?.zoomDocument(1 - settings.editorFontScale)}
        >
          {Math.round(settings.editorFontScale * 100)}%
          <ChevronDown aria-hidden="true" className="size-3" />
        </Button>
        <IconButton label="Increase text size" disabled={!inEditor} onClick={() => runtime?.zoomDocument(0.1)}>
          <Plus aria-hidden="true" />
        </IconButton>
        <Separator
          orientation="vertical"
          className="toolbar-sep mx-3 my-0.5 w-px self-stretch bg-[var(--chrome-border)]"
        />
        <IconButton label="Print" title="Print (Ctrl+P)" disabled={!inEditor} onClick={() => runtime?.printDocument()}>
          <Printer aria-hidden="true" />
        </IconButton>
        <Separator
          orientation="vertical"
          className="toolbar-sep mx-2 my-1 w-px self-stretch bg-[var(--chrome-border)]"
        />
        <IconButton
          label={
            documentIsDark
              ? "Switch to light document theme"
              : "Switch to dark document theme"
          }
          disabled={!inEditor}
          onClick={() => runtime?.toggleDocumentTheme()}
        >
          {documentIsDark ? (
            <Sun aria-hidden="true" className="document-theme-glyph" strokeWidth={2.2} />
          ) : (
            <Moon aria-hidden="true" className="document-theme-glyph" />
          )}
        </IconButton>
      </div>
    </header>
  );
}

function MenuAction({
  label,
  shortcut,
  disabled,
  onClick,
}: {
  label: string;
  shortcut: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center rounded px-2 text-left hover:bg-[var(--toolbar-hover)] disabled:opacity-45"
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && <span className="ml-auto text-[11px] text-[var(--muted-fg)]">{shortcut}</span>}
    </button>
  );
}

function IconButton({
  label,
  title = label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            TOOLBAR_BUTTON_CLASS,
            "toolbar-icon p-0 leading-none [&_svg]:block [&_svg]:shrink-0",
          )}
          title={title}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function TabStrip() {
  const runtime = useAppRuntime();
  const { tabs, activeTabId, view } = useAppState((state) => state);

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
    <nav className={TAB_STRIP_CLASS} aria-label="Document tabs">
      <Button
        type="button"
        variant="outline"
        className={cn(
          "toolbar-recent h-[29px] shrink-0 rounded-[6px] border border-[var(--chrome-border)] bg-transparent px-3 text-[12px] font-normal text-[var(--chrome-fg)]",
          "hover:bg-[var(--toolbar-hover)]",
          view === "recent" && "active bg-[var(--control-bg)] font-semibold",
        )}
        title="Recent files"
        onClick={() => runtime?.showRecentView()}
      >
        Recent
      </Button>
      <div className="contents" role="tablist" aria-label="Open documents" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <DocumentTab
            key={tab.id}
            tab={tab}
            active={view !== "recent" && tab.id === activeTabId}
            focusable={tab.id === activeTabId || (activeTabId === null && tab === tabs[0])}
            runtime={runtime}
          />
        ))}
      </div>
      <button
        type="button"
        className={cn(
          "tab-new ml-0.5 h-6 w-[26px] shrink-0 self-center cursor-pointer",
          "rounded-[6px] border-0 bg-transparent p-0 text-base leading-none text-[var(--muted-fg)]",
          "hover:bg-[rgba(0,0,0,0.06)] hover:text-[var(--chrome-fg)]",
        )}
        title="New tab (Ctrl+N)"
        aria-label="New tab"
        onClick={() => runtime?.newDocument()}
      >
        <Plus aria-hidden="true" className="mx-auto size-4" />
      </button>
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
      { label: "Open folder", disabled: !path, run: () => { if (path) runtime?.revealPath(path); } },
      { label: "Copy folder path", disabled: !folder, run: () => { if (folder) runtime?.copyText(folder); } },
      { label: "Copy file path", disabled: !path, run: () => { if (path) runtime?.copyText(path); } },
      { label: "Close all tabs", separatorBefore: true, run: () => runtime?.closeEveryTab() },
    ]);
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
        "tab group flex h-[31px] w-[258px] max-w-[258px] cursor-pointer select-none items-center gap-[7px]",
        "whitespace-nowrap rounded-t-[6px] border border-[var(--chrome-border)] bg-[var(--tab-bg)]",
        "py-[5px] pr-2 pl-3 text-[12px] leading-normal text-[var(--muted-fg)]",
        "hover:bg-[rgba(0,0,0,0.04)] hover:text-[var(--chrome-fg)]",
        active &&
          "active bg-[var(--active-tab-bg)] font-normal text-[var(--chrome-fg)] hover:bg-[var(--active-tab-bg)]",
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
      <File aria-hidden="true" className="size-4 shrink-0 text-[var(--accent)]" />
      <span className="tab-select flex min-w-0 flex-auto items-center gap-[6px]">
        {tab.doc.isDirty && (
          <span aria-hidden="true" className="tab-dot text-[10px] leading-none text-[var(--accent)]">●</span>
        )}
        <span className="tab-label overflow-hidden text-ellipsis">
          {fileLabel(tab.doc.filePath)}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "tab-close flex size-[18px] shrink-0 cursor-pointer items-center justify-center",
          "rounded-[4px] text-[11px] leading-none text-inherit opacity-0",
          "group-hover:opacity-75 hover:bg-[rgba(0,0,0,0.12)] hover:opacity-100",
          active && "opacity-75",
        )}
        title="Close tab"
      >
        <X aria-hidden="true" className="size-[13px]" />
      </span>
    </button>
  );
}

function Banner() {
  const runtime = useAppRuntime();
  const banner = useAppState((state) => state.banner);
  if (!banner) return <div className={BANNER_CLASS} hidden />;
  return (
    <Alert
      className={cn(
        BANNER_CLASS,
        "static w-auto rounded-none border-0 border-b",
        banner.kind === "error" &&
          "border-[#f1b0b6] bg-[#fde7e9] text-[#6e0811]",
      )}
      data-kind={banner.kind}
      role={banner.kind === "error" ? "alert" : "status"}
      aria-live={banner.kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <AlertDescription className="banner-message flex-1 text-[13px] text-inherit">
        {banner.message}
      </AlertDescription>
      {(banner.actions ?? []).map((action) => (
        <button
          key={action.id}
          type="button"
          className={cn(
            "banner-btn cursor-pointer rounded-[5px] border border-current bg-transparent",
            "px-3 py-1 text-[12.5px] leading-normal text-inherit [font-family:var(--font-ui)]",
          )}
          onClick={() => runtime?.handleBannerAction(action.id)}
        >
          {action.label}
        </button>
      ))}
      <button
        type="button"
        className="banner-dismiss cursor-pointer border-0 bg-transparent text-[13px] text-inherit opacity-70"
        title="Dismiss"
        aria-label="Dismiss notification"
        onClick={() => runtime?.dismissBanner()}
      >
        ✕
      </button>
    </Alert>
  );
}

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
      <span
        className="status-left min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        title={path}
      >
        {path}
      </span>
      <span className="status-right shrink-0 whitespace-nowrap">
        {words.toLocaleString()} {words === 1 ? "word" : "words"} · {formatKB(byteLength(doc.markdown))}
      </span>
    </footer>
  );
}

function fileLabel(filePath: string | null): string {
  if (!filePath) return "Untitled";
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}
