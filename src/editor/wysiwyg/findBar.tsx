import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { FindCounts, FindOptions } from "./findEngine";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fieldClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";

export interface FindController {
  search(query: string, opts: FindOptions): FindCounts;
  next(): FindCounts;
  prev(): FindCounts;
  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts;
  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts;
  clear(): void;
  focusEditor(): void;
}

interface FindBarHandle {
  show(mode: "find" | "replace"): void;
  close(): void;
  refresh(): void;
  next(): void;
  prev(): void;
}

/**
 * The find card: Mervin's floating search panel over the top right of the
 * document. Ctrl+F (or the toolbar's Find button) opens it with the field
 * focused, Ctrl+H adds the replace row, and Escape or Close hides it, clears
 * the highlights and returns focus to the document. The query and options
 * survive closing, so reopening searches again.
 */
export class FindBar {
  private readonly host = document.createElement("div");
  private readonly root: Root;
  private handle: FindBarHandle | null = null;
  private open = false;

  constructor(
    parent: HTMLElement,
    controller: FindController,
    private readonly onOpenChange: (open: boolean) => void = () => {},
  ) {
    this.host.dataset.reactFindBar = "";
    this.host.className = "contents";
    parent.append(this.host);
    this.root = createRoot(this.host);
    flushSync(() => {
      this.root.render(
        <FindBarView
          ref={(handle) => {
            this.handle = handle;
          }}
          controller={controller}
          onOpenChange={(open) => this.setOpen(open)}
        />,
      );
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Open the card in find or replace mode and focus its field. */
  show(mode: "find" | "replace"): void {
    this.handle?.show(mode);
  }

  /** Open the card, or close it when it is already open (the toolbar button). */
  toggle(): void {
    if (this.open) this.close();
    else this.show("find");
  }

  /** Hide the card, clear the highlights and return focus to the document. */
  close(): void {
    this.handle?.close();
  }

  /** Search again in the editor that is now visible, keeping the card open. */
  refresh(): void {
    this.handle?.refresh();
  }

  next(): void {
    this.handle?.next();
  }

  prev(): void {
    this.handle?.prev();
  }

  destroy(): void {
    this.handle?.close();
    this.handle = null;
    disposeReactRoot(this.root, this.host);
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.onOpenChange(open);
  }
}

const DEFAULT_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/** The card's 28px icon buttons: transparent until hovered, glyph in the toolbar ink. */
const ICON_BUTTON_CLASS = cn(
  "find-btn size-7 border-transparent p-0 text-ink-body",
  "focus-visible:outline-1 focus-visible:outline-solid focus-visible:-outline-offset-1 [&_svg]:size-4",
);

/** The card's text buttons in the replace row. */
const TEXT_BUTTON_CLASS = "find-btn find-btn-text h-[29px] px-3";

const FindBarView = forwardRef<
  FindBarHandle,
  { controller: FindController; onOpenChange(open: boolean): void }
>(function FindBarView({ controller, onOpenChange }, ref) {
  const [open, setOpenState] = useState(false);
  const [mode, setMode] = useState<"find" | "replace">("find");
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [counts, setCounts] = useState<FindCounts>({ current: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange(next);
  };
  const apply = (next: FindCounts) => setCounts(next);
  const runSearch = (value = query, opts = options) => apply(controller.search(value, opts));
  const close = () => {
    setMode("find");
    controller.clear();
    setCounts({ current: 0, total: 0 });
    setOpen(false);
    controller.focusEditor();
  };

  useImperativeHandle(ref, () => ({
    show(nextMode) {
      flushSync(() => {
        setMode(nextMode);
        setOpen(true);
      });
      inputRef.current?.focus();
      inputRef.current?.select();
      if (query) runSearch();
    },
    close: () => flushSync(close),
    refresh() {
      controller.clear();
      setCounts({ current: 0, total: 0 });
      if (open && query) runSearch();
    },
    next: () => apply(controller.next()),
    prev: () => apply(controller.prev()),
  }));

  const countText = !query
    ? ""
    : counts.total
      ? `${counts.current} of ${counts.total}`
      : "No results";
  const noMatches = !query || !counts.total;

  // Escape closes the card from any of its controls; the editor never sees the
  // keys the card handles.
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    apply(event.shiftKey ? controller.prev() : controller.next());
  };
  const toggle = (key: keyof FindOptions) => {
    const next = { ...options, [key]: !options[key] };
    setOptions(next);
    runSearch(query, next);
    // Clicking an option keeps the caret in the field, as in Mervin.
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn(
        "find-bar pointer-events-auto flex flex-col gap-1.5 rounded-[10px] border bg-popover py-[7px] pr-[5px] pl-[7px] text-[12px] text-ink",
        "border-line-popover dark:border-line-strong",
      )}
      role="search"
      aria-label="Find in document"
      hidden={!open}
      onKeyDown={onCardKey}
    >
      <div className="find-row flex items-center gap-0.5">
        <label
          className={cn(
            fieldClassName,
            "find-field relative flex w-[236px] min-w-0 shrink-0 cursor-text items-center gap-0 border-line-popover-control px-0",
            // A 2px accent ring while focused, drawn outside so the text never moves.
            "focus-within:border-accent focus-within:outline-1 focus-within:outline-solid focus-within:outline-accent",
          )}
        >
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-1.5 size-4 text-ink-faint"
            absoluteStrokeWidth
            strokeWidth={1}
          />
          <input
            ref={inputRef}
            type="text"
            className="find-input h-full min-w-0 flex-1 border-0 bg-transparent pr-2 pl-[30px] text-[12px] text-ink-primary outline-none placeholder:text-ink-faint"
            placeholder="Find in document"
            aria-label="Find in document"
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              runSearch(value);
            }}
            onKeyDown={onFindKey}
          />
          <span
            className="find-count shrink-0 pr-2 whitespace-nowrap text-ink-soft empty:hidden"
            aria-live="polite"
          >
            {countText}
          </span>
        </label>
        <span className="w-1" />
        <Button
          type="button"
          variant="ghost"
          className={cn(ICON_BUTTON_CLASS, "find-prev")}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={noMatches}
          onClick={() => apply(controller.prev())}
        >
          <ChevronUp aria-hidden="true" absoluteStrokeWidth strokeWidth={1} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(ICON_BUTTON_CLASS, "find-next")}
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={noMatches}
          onClick={() => apply(controller.next())}
        >
          <ChevronDown aria-hidden="true" absoluteStrokeWidth strokeWidth={1} />
        </Button>
        <CardSeparator />
        <FindToggle label="Match case" active={options.caseSensitive} onClick={() => toggle("caseSensitive")} />
        <span className="w-2.5" />
        <FindToggle label="Whole word" active={options.wholeWord} onClick={() => toggle("wholeWord")} />
        <CardSeparator />
        <Button
          type="button"
          variant="ghost"
          className="find-close size-7 border-transparent p-0 text-ink-soft [&_svg]:size-4"
          title="Close (Esc)"
          aria-label="Close find"
          onClick={close}
        >
          <X aria-hidden="true" absoluteStrokeWidth strokeWidth={1} />
        </Button>
      </div>
      <div className="find-row find-replace-row flex items-center gap-1.5" hidden={mode !== "replace"}>
        <input
          type="text"
          className={cn(fieldClassName, "find-input w-[236px] min-w-0 border-line-popover-control")}
          placeholder="Replace with"
          aria-label="Replace with"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            apply(controller.replaceCurrent(replacement, query, options));
          }}
        />
        <span className="w-0.5" />
        <Button
          type="button"
          variant="outline"
          className={TEXT_BUTTON_CLASS}
          disabled={noMatches}
          onClick={() => apply(controller.replaceCurrent(replacement, query, options))}
        >
          Replace
        </Button>
        <Button
          type="button"
          variant="outline"
          className={TEXT_BUTTON_CLASS}
          disabled={noMatches}
          onClick={() => apply(controller.replaceAll(replacement, query, options))}
        >
          Replace all
        </Button>
      </div>
    </div>
  );
});

/** A 1x18px divider between the card's control groups. */
function CardSeparator(): ReactNode {
  return <span aria-hidden="true" className="mx-2 h-[18px] w-px shrink-0 bg-line" />;
}

function FindToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <label className="find-toggle flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap text-ink dark:text-ink-soft">
      <Checkbox
        checked={active}
        onChange={onClick}
        onMouseDown={(event) => event.preventDefault()}
      />
      <span>{label}</span>
    </label>
  );
}
