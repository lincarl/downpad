import type { ReactNode } from "react";
import { Star } from "lucide-react";
import type { FileStat } from "@/ipc/contracts";
import { cn } from "@/lib/utils";
import { DocumentArtwork } from "@/components/icons";
import { fileName, formatDate, formatSize, plainSnippet } from "./recentFormat";
import type { RecentRowModel } from "./recentListing";

// Mervin's brand colours, the same in both themes.
const STAR_FILL = "#f5c400";
const STAR_EDGE = "#d4a500";
/** The empty star's grey edge (#b8b8b8), or the selection ink on a selected row. */
const STAR_EMPTY_CLASS = "text-[#b8b8b8] group-has-[:focus-visible]/row:text-accent-fg/80";

/** A row is selected while it, or its star, has keyboard focus. Selected text uses
 * the accent's own ink for contrast, where Mervin keeps the rest inks. */
const SELECTED_INK = "group-has-[:focus-visible]/row:text-accent-fg";
const SELECTED_SOFT_INK = "group-has-[:focus-visible]/row:text-accent-fg/80";
const SMALL_TEXT = "block truncate text-[10px] text-ink-soft";

export interface RecentRowProps {
  row: RecentRowModel;
  /** Live file facts; undefined until the stat answers. */
  stat: FileStat | undefined;
  /** Text to highlight in the file name. */
  nameQuery: string;
  /** Text to highlight in the content snippet. */
  snippetQuery: string;
  now: number;
  /** This row holds the list's single tab stop. */
  tabStop: boolean;
  onOpen(): void;
  onMenu(x: number, y: number): void;
  onToggleStar(): void;
  onFocus(): void;
}

/**
 * One file in the Recent list, after Mervin's row: 64px (88px with a content
 * snippet), edge to edge, with the document artwork, name over path, date over
 * size and the star at the far right. Clicking anywhere but the star opens it.
 */
export function RecentRow({
  row,
  stat,
  nameQuery,
  snippetQuery,
  now,
  tabStop,
  onOpen,
  onMenu,
  onToggleStar,
  onFocus,
}: RecentRowProps) {
  const { entry, hit } = row;
  const missing = stat ? !stat.exists : false;
  const name = fileName(entry.path);
  const strongInk = missing ? "text-ink-disabled" : "text-ink-primary";
  const title = missing
    ? `${entry.path}\nThis file is no longer on disk.`
    : hit
      ? `${entry.path}\nMatch on line ${hit.line}`
      : entry.path;
  return (
    <div
      className={cn(
        "recent-row group/row flex shrink-0 cursor-pointer items-center hover:bg-row-hover has-[:focus-visible]:bg-accent",
        hit ? "h-[88px]" : "h-16",
        missing && "missing",
      )}
      title={title}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        className="recent-row-open flex h-full min-w-0 flex-1 cursor-pointer items-center border-0 bg-transparent py-0 pr-0 pl-4 text-left font-[inherit] outline-none"
        aria-label={`Open ${name}`}
        tabIndex={tabStop ? 0 : -1}
        onFocus={onFocus}
      >
        <DocumentArtwork size={34} className="recent-icon shrink-0" />
        <span className="recent-mid mr-3 ml-[11px] flex min-w-0 flex-1 flex-col self-stretch pt-[9px]">
          <span className={cn("recent-name block truncate text-[12px] leading-[23px] font-semibold", strongInk, SELECTED_INK)}>
            <Highlighted text={name} query={nameQuery} />
          </span>
          {hit && (
            <span className={cn("recent-snippet leading-[23px]", SMALL_TEXT, strongInk, SELECTED_INK)}>
              <Highlighted text={snippetText(hit.snippet, snippetQuery)} query={snippetQuery} />
            </span>
          )}
          {/* Right-to-left with a leading LRM puts the ellipsis on the left, so the
              file end of a long path stays visible. */}
          <span
            className={cn(
              "recent-path text-left [direction:rtl]",
              SMALL_TEXT,
              hit ? "leading-[24px]" : "leading-[22px]",
              SELECTED_SOFT_INK,
            )}
          >
            {String.fromCharCode(0x200e) + entry.path}
          </span>
        </span>
        <span className="recent-right flex max-w-[40%] min-w-[180px] shrink-0 flex-col self-stretch pt-[9px] text-right">
          <span
            className={cn(
              "recent-date block truncate text-[12px]",
              hit ? "leading-[35px]" : "leading-[23px]",
              strongInk,
              SELECTED_INK,
            )}
          >
            {formatDate(entry.lastOpenedMs, now)}
          </span>
          <span className={cn("recent-size", SMALL_TEXT, hit ? "leading-[35px]" : "leading-[22px]", SELECTED_SOFT_INK)}>
            {stat?.exists ? formatSize(stat.sizeBytes) : ""}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={cn(
          "recent-star mr-4 ml-[9px] grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent p-0",
          "outline-none focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-accent-fg",
          entry.favorite && "on",
        )}
        aria-label={entry.favorite ? "Remove from favorites" : "Add to favorites"}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar();
        }}
      >
        {/* On a selected row the empty star takes the selection ink, since its grey
            outline vanishes on the accent fill. */}
        <Star
          aria-hidden="true"
          focusable="false"
          size={20}
          strokeWidth={2}
          className={entry.favorite ? undefined : STAR_EMPTY_CLASS}
          color={entry.favorite ? STAR_EDGE : "currentColor"}
          fill={entry.favorite ? STAR_FILL : "none"}
        />
      </button>
    </div>
  );
}

/** The snippet as plain text, unless the query itself contains Markdown markup
 *  (the match would then vanish with it) or nothing readable would remain. */
function snippetText(snippet: string, query: string): string {
  if (/[|#*_`>[\]]/.test(query)) return snippet;
  return plainSnippet(snippet) || snippet;
}

/** A section caption: "Favorites" on top, "Recent" between the sections. */
export function RecentCaption({ first, children }: { first: boolean; children: string }) {
  return (
    <div
      className={cn(
        "recent-caption flex shrink-0 items-end px-4 pb-[5px] text-[10px] leading-[15px] font-semibold text-ink-soft select-none",
        first ? "h-[26px]" : "h-9",
      )}
    >
      {children}
    </div>
  );
}

/**
 * `text` with every case-insensitive occurrence of `query` on Mervin's yellow
 * search-match wash. The text keeps its colour, except on a selected row, where the
 * accent ink would sit poorly on the yellow.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <span
        key={`${start}-${end}`}
        className="recent-match -mx-px rounded-[3px] bg-[rgb(255_230_0/0.588)] px-px py-px text-[#1a1f24]"
      >
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** Case-insensitive match ranges in `text`, as UTF-16 offsets into `text` itself,
 * even where lowercasing changes a character's length (for example "İ"). */
function highlightRanges(text: string, query: string): Array<[number, number]> {
  const q = query.trim();
  if (!q) return [];
  let lowered = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index)!;
    const length = point > 0xffff ? 2 : 1;
    const low = text.slice(index, index + length).toLowerCase();
    for (let unit = 0; unit < low.length; unit++) origin.push(index);
    lowered += low;
    index += length;
  }
  const needle = q.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  let from = 0;
  while (from <= lowered.length) {
    const at = lowered.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    const start = origin[at];
    const endStart = origin[at + needle.length - 1];
    const end = endStart + (text.codePointAt(endStart)! > 0xffff ? 2 : 1);
    if (start < cursor) continue;
    ranges.push([start, end]);
    cursor = end;
  }
  return ranges;
}
