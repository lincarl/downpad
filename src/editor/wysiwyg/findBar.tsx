import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Search } from "lucide-react";
import type { FindCounts, FindOptions } from "./findEngine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  next(): void;
  prev(): void;
}

/** Permanent application search strip. Ctrl+F focuses the already-visible input;
 * Ctrl+H expands its replace row without replacing the shell chrome. */
export class FindBar {
  private readonly host = document.createElement("div");
  private readonly root: Root;
  private handle: FindBarHandle | null = null;

  constructor(parent: HTMLElement, controller: FindController) {
    this.host.dataset.reactFindBar = "";
    parent.append(this.host);
    this.root = createRoot(this.host);
    flushSync(() => {
      this.root.render(
        <FindBarView
          ref={(handle) => {
            this.handle = handle;
          }}
          controller={controller}
        />,
      );
    });
  }

  isOpen(): boolean {
    return true;
  }

  show(mode: "find" | "replace"): void {
    this.handle?.show(mode);
  }

  /** Clears transient search state but deliberately keeps the strip mounted. */
  close(): void {
    this.handle?.close();
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
}

const DEFAULT_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

const FIND_BUTTON_CLASS =
  "find-btn h-[28px] rounded-[4px] border border-transparent bg-transparent px-2 py-0 font-[var(--font-ui)] text-[12px] font-normal text-[var(--muted-fg)] hover:bg-[var(--toolbar-hover)] hover:text-[var(--chrome-fg)] focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-45";

const FindBarView = forwardRef<FindBarHandle, { controller: FindController }>(
  function FindBarView({ controller }, ref) {
    const [mode, setMode] = useState<"find" | "replace">("find");
    const [query, setQuery] = useState("");
    const [replacement, setReplacement] = useState("");
    const [options, setOptions] = useState(DEFAULT_OPTIONS);
    const [counts, setCounts] = useState<FindCounts>({ current: 0, total: 0 });
    const inputRef = useRef<HTMLInputElement>(null);

    const apply = (next: FindCounts) => setCounts(next);
    const close = () => {
      setMode("find");
      setQuery("");
      controller.clear();
      setCounts({ current: 0, total: 0 });
      controller.focusEditor();
    };
    const runSearch = (value = query, opts = options) => apply(controller.search(value, opts));

    useImperativeHandle(ref, () => ({
      show(nextMode) {
        flushSync(() => setMode(nextMode));
        inputRef.current?.focus();
        inputRef.current?.select();
        if (query) runSearch();
      },
      close,
      next: () => apply(controller.next()),
      prev: () => apply(controller.prev()),
    }));

    const countText = !query
      ? ""
      : counts.total
        ? `${counts.current} of ${counts.total}`
        : "No results";

    const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        apply(event.shiftKey ? controller.prev() : controller.next());
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };

    const toggle = (key: keyof FindOptions) => {
      const next = { ...options, [key]: !options[key] };
      setOptions(next);
      runSearch(query, next);
    };

    return (
      <div className="find-bar flex h-full min-w-0 flex-col border-b border-[var(--chrome-border)] bg-[var(--findbar-bg)]">
        <div className="find-row flex h-[38px] min-w-0 items-center gap-[6px] px-[6px] py-[5px]">
          <label className="find-field flex h-[28px] w-[199px] shrink-0 items-center gap-3 rounded-[6px] border border-[var(--input-border)] bg-[var(--control-bg)] px-2 text-[var(--muted-fg)]">
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <Input
              ref={inputRef}
              type="text"
              className="find-input h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-[var(--chrome-fg)] shadow-none outline-none focus-visible:ring-0"
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
          </label>
          <span
            className="find-count flex h-[28px] min-w-16 items-center justify-center text-center text-[12px] text-[var(--muted-fg)]"
            aria-live="polite"
          >
            {countText}
          </span>
          <Button
            type="button"
            variant="ghost"
            className={cn(FIND_BUTTON_CLASS, "find-prev")}
            disabled={!query || !counts.total}
            onClick={() => apply(controller.prev())}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={FIND_BUTTON_CLASS}
            disabled={!query || !counts.total}
            onClick={() => apply(controller.next())}
          >
            Next
          </Button>
          <FindToggle label="Match case" active={options.caseSensitive} onClick={() => toggle("caseSensitive")} />
          <FindToggle label="Whole word" active={options.wholeWord} onClick={() => toggle("wholeWord")} />
        </div>
        <div
          className="find-row find-replace-row flex min-h-[38px] items-center gap-2 border-t border-[var(--chrome-border)] px-[214px] py-[5px]"
          hidden={mode !== "replace"}
        >
          <Input
            type="text"
            className="find-input h-[28px] w-[200px] min-w-0 rounded-[6px] border border-[var(--input-border)] bg-[var(--control-bg)] px-2 text-[12px] text-[var(--chrome-fg)]"
            placeholder="Replace"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
          />
          <Button
            type="button"
            variant="ghost"
            className={cn(FIND_BUTTON_CLASS, "find-btn-text px-2.5")}
            onClick={() => apply(controller.replaceCurrent(replacement, query, options))}
          >
            Replace
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={cn(FIND_BUTTON_CLASS, "find-btn-text px-2.5")}
            onClick={() => apply(controller.replaceAll(replacement, query, options))}
          >
            All
          </Button>
        </div>
      </div>
    );
  },
);

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
    <label className="find-toggle flex h-[28px] cursor-pointer items-center gap-1.5 whitespace-nowrap text-[12px] text-[var(--chrome-fg)]">
      <input type="checkbox" checked={active} onChange={onClick} />
      <span>{label}</span>
    </label>
  );
}
