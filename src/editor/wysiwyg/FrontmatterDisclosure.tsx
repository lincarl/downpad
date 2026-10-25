import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { parseFrontmatterTable } from "../../document/frontmatterTable";

export interface FrontmatterDisclosureProps {
  block: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

/** Keep the disclosure mounted outside the keyed table so edits preserve its toggle and content ID. */
export function FrontmatterDisclosure({
  block,
  expanded,
  onExpandedChange,
  children,
}: FrontmatterDisclosureProps) {
  const contentId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const table = parseFrontmatterTable(block);
  // Named raw fields still represent one top-level key. Unnamed raw blocks and
  // comments-only YAML do not provide a reliable field count.
  const fieldCount = table.raw.trim() === ""
    ? 0
    : table.fields.length > 0 && table.fields.every((field) => field.key !== "")
      ? table.fields.length
      : null;

  /** Close only for Escape inside the content, leaving external find controls alone. */
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expanded || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onExpandedChange(false);
    toggle.current?.focus();
  };

  return (
    <div className="frontmatter-disclosure">
      <button
        ref={toggle}
        type="button"
        className="frontmatter-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => onExpandedChange(!expanded)}
      >
        <ChevronRight
          className="frontmatter-chevron"
          aria-hidden="true"
          focusable="false"
          size={14}
          absoluteStrokeWidth
          strokeWidth={1}
        />
        <span>Frontmatter</span>
        {fieldCount !== null && (
          <>
            {" "}
            <span className="frontmatter-count">{fieldCount} {fieldCount === 1 ? "field" : "fields"}</span>
          </>
        )}
      </button>
      <div id={contentId} className="frontmatter-content" hidden={!expanded} onKeyDown={closeOnEscape}>
        {children}
      </div>
    </div>
  );
}
