import type { KeyboardEvent, MouseEvent } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipLabel } from "@/components/ui/tooltip";
import type { SearchScope } from "./recentListing";

/** Placeholder and accessible name of the field for each scope. */
export const SCOPE_COPY: Record<SearchScope, { label: string; placeholder: string; ariaLabel: string }> = {
  names: { label: "Names", placeholder: "Search file names", ariaLabel: "Search recent file names" },
  contents: {
    label: "Contents",
    placeholder: "Search inside documents",
    ariaLabel: "Search inside recent documents",
  },
  all: {
    label: "All",
    placeholder: "Search names and contents",
    ariaLabel: "Search recent file names and documents",
  },
};

const SCOPES: SearchScope[] = ["names", "contents", "all"];

/** Mouse clicks on the field's buttons leave the caret in the field. */
const keepFieldFocus = (event: MouseEvent): void => event.preventDefault();

export interface RecentSearchFieldProps {
  scope: SearchScope;
  /** Initial text. The input is uncontrolled; the owner reads it through `inputRef`. */
  defaultValue: string;
  hasQuery: boolean;
  inputRef(element: HTMLInputElement | null): void;
  onScope(scope: SearchScope): void;
  onClear(): void;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
}

/**
 * The Recent search field, after Mervin's: a fixed 460x29 well with the search
 * icon at the left and, inside its right end, a quiet clear button, a rule and the
 * Names / Contents / All scope toggles. A 2px accent ring marks focus.
 */
export function RecentSearchField({
  scope,
  defaultValue,
  hasQuery,
  inputRef,
  onScope,
  onClear,
  onKeyDown,
}: RecentSearchFieldProps) {
  const copy = SCOPE_COPY[scope];
  return (
    <div
      className={cn(
        "recent-search-wrap flex h-[29px] w-[460px] shrink-0 items-center rounded-control border border-line bg-well",
        // The ring marks the text field's focus, not a Tab-focused toggle. It is
        // the border plus a 1px inset shadow, so nothing inside moves.
        "has-[input:focus]:border-accent has-[input:focus]:shadow-[inset_0_0_0_1px_var(--accent)]",
      )}
    >
      <Search
        className="recent-search-icon ml-[5px] shrink-0 text-ink-faint"
        aria-hidden="true"
        focusable="false"
        size={16}
        absoluteStrokeWidth
        strokeWidth={1}
      />
      <input
        ref={inputRef}
        type="text"
        className={cn(
          "recent-search-input ml-[15px] mr-[6px] h-full min-w-0 flex-1 border-0 bg-transparent p-0",
          "font-[inherit] text-[12px] text-ink-primary outline-none placeholder:text-ink-faint",
          "selection:bg-accent selection:text-accent-fg",
        )}
        aria-label={copy.ariaLabel}
        placeholder={copy.placeholder}
        defaultValue={defaultValue}
        spellCheck={false}
        onKeyDown={onKeyDown}
      />
      <TooltipLabel text="Clear">
      <button
        type="button"
        className="recent-search-clear grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent p-0 text-ink-soft outline-none hover:bg-hover"
        aria-label="Clear"
        tabIndex={-1}
        // Hidden while empty, but it keeps its slot so the toggles never move.
        style={{ visibility: hasQuery ? "visible" : "hidden" }}
        onMouseDown={keepFieldFocus}
        onClick={onClear}
      >
        <X aria-hidden="true" focusable="false" size={14} absoluteStrokeWidth strokeWidth={1} />
      </button>
      </TooltipLabel>
      <span className="ml-[2px] mr-1 h-4 w-px shrink-0 bg-line-strong" aria-hidden="true" />
      <div className="recent-scope mr-[5px] flex shrink-0" role="group" aria-label="Search scope">
        {SCOPES.map((value) => (
          <ScopeToggle key={value} label={SCOPE_COPY[value].label} on={value === scope} onClick={() => onScope(value)} />
        ))}
      </div>
    </div>
  );
}

/**
 * A plain text toggle: faint at rest, body ink on hover, accent and bold when
 * chosen. A hidden bold copy of the label fixes its width, so choosing a scope
 * never shifts its neighbours.
 */
function ScopeToggle({ label, on, onClick }: { label: string; on: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className={cn(
        "recent-scope-btn grid h-[22px] cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent px-[5px] py-0",
        "font-[inherit] text-[11px] leading-none outline-none focus-ring-inset",
        on ? "font-bold text-accent" : "text-ink-faint hover:text-ink",
      )}
      aria-pressed={on}
      onMouseDown={keepFieldFocus}
      onClick={onClick}
    >
      <span className="invisible col-start-1 row-start-1 font-bold" aria-hidden="true">
        {label}
      </span>
      <span className="recent-scope-label col-start-1 row-start-1">{label}</span>
    </button>
  );
}
