import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Plus, X, type LucideIcon } from "lucide-react";

import {
  addTopLevelField,
  deleteField,
  insertFieldAt,
  isValidEditableKey,
  parseFrontmatterTable,
  rewriteGroupKey,
  rewriteScalar,
  type FmField,
  type FmGroup,
  type FmRaw,
  type FmScalar,
} from "../../document/frontmatterTable";

type FrontmatterTableModel = ReturnType<typeof parseFrontmatterTable>;

export type FrontmatterFocus =
  | { kind: "line"; lineIndex: number }
  | { kind: "add" }
  | null;

export interface FrontmatterPanelProps {
  block: string;
  focus: FrontmatterFocus;
  /**
   * Publishes the losslessly rewritten YAML block. A focus target marks a
   * structural edit, so the host re-renders this component with fresh line
   * indices. Scalar edits deliberately omit it to keep the active
   * contenteditable cell and caret untouched.
   */
  onBlockChange: (block: string, focus?: Exclude<FrontmatterFocus, null>) => void;
}

/**
 * React-owned editable view of the leading YAML frontmatter block. The YAML
 * remains the source of truth; this component only projects the table model and
 * reports the minimally rewritten block to WysiwygEditor for serialization.
 * Each cell that shows text carries data-line and data-part, so find can
 * highlight its matches there (frontmatterFind.ts).
 */
export function FrontmatterPanel({ block, focus, onBlockChange }: FrontmatterPanelProps) {
  const table = parseFrontmatterTable(block);
  const keyCells = useRef(new Map<number, HTMLTableCellElement>());
  const addButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (focus?.kind === "line") {
      const cell = keyCells.current.get(focus.lineIndex);
      if (cell) {
        cell.focus();
        selectAllText(cell);
      }
    } else if (focus?.kind === "add") {
      addButton.current?.focus();
    }
  }, [block, focus]);

  const rememberKeyCell =
    (lineIndex: number) =>
    (cell: HTMLTableCellElement | null): void => {
      if (cell) keyCells.current.set(lineIndex, cell);
      else keyCells.current.delete(lineIndex);
    };

  // Read-only fallback: YAML with no editable fields (for example comments only
  // or an unsupported deep shape). It remains visibly tagged as frontmatter and
  // cannot accidentally be treated as document content.
  if (table.fields.length === 0 && table.raw.trim() !== "") {
    return (
      <div className="frontmatter-raw">
        <FrontmatterTab />
        <pre className="frontmatter-code" data-line={0} data-part="value">{table.raw.replace(/\n+$/, "")}</pre>
      </div>
    );
  }

  const existingKeys = allFrontmatterKeys(table);
  const rows: ReactNode[] = [];
  const before = (key: string) => (key ? `Insert field before "${key}"` : "Insert field here");
  let firstInserter = true;
  let rowKey = 0;
  const pushInserter = (atLineIndex: number, indent: string, label: string): void => {
    rows.push(
      <InserterRow
        key={`insert-${rowKey++}`}
        table={table}
        atLineIndex={atLineIndex}
        indent={indent}
        existingKeys={existingKeys}
        label={label}
        first={firstInserter}
        onBlockChange={onBlockChange}
      />,
    );
    firstInserter = false;
  };

  for (const field of table.fields) {
    if (field.kind === "scalar") {
      pushInserter(field.lineIndex, "", before(field.key));
      rows.push(
        <ScalarRow
          key={`scalar-${rowKey++}`}
          table={table}
          field={field}
          rememberKeyCell={rememberKeyCell}
          onBlockChange={onBlockChange}
        />,
      );
    } else if (field.kind === "group") {
      pushInserter(field.headerIndex, "", before(field.key));
      rows.push(
        <GroupRow
          key={`group-${rowKey++}`}
          table={table}
          group={field}
          rememberKeyCell={rememberKeyCell}
          onBlockChange={onBlockChange}
        />,
      );
      for (const child of field.children) {
        pushInserter(child.lineIndex, field.childIndent, before(child.key));
        rows.push(
          <ScalarRow
            key={`child-${rowKey++}`}
            table={table}
            field={child}
            parent={field}
            rememberKeyCell={rememberKeyCell}
            onBlockChange={onBlockChange}
          />,
        );
      }
    } else {
      pushInserter(field.blockStart, "", before(field.key));
      rows.push(
        <RawRow
          key={`raw-${rowKey++}`}
          table={table}
          field={field}
          onBlockChange={onBlockChange}
        />,
      );
    }
  }
  pushInserter(table.lines.length, "", "Insert field at the end");

  const addTopLevel = (): void => {
    const { block: nextBlock, lineIndex } = addTopLevelField(
      table,
      uniquePlaceholder(existingKeys),
      "",
    );
    onBlockChange(nextBlock, { kind: "line", lineIndex });
  };

  return (
    <>
      {table.fields.length > 0 && (
        <table className="frontmatter-table">
          <caption className="frontmatter-caption">
            <FrontmatterTab />
          </caption>
          <tbody>{rows}</tbody>
        </table>
      )}
      <button ref={addButton} type="button" className="frontmatter-add" onClick={addTopLevel}>
        <ControlIcon icon={Plus} />
        Add field
      </button>
    </>
  );
}

interface RowProps {
  table: FrontmatterTableModel;
  onBlockChange: FrontmatterPanelProps["onBlockChange"];
}

interface InserterRowProps extends RowProps {
  atLineIndex: number;
  indent: string;
  existingKeys: Set<string>;
  label: string;
  first: boolean;
}

function InserterRow({
  table,
  atLineIndex,
  indent,
  existingKeys,
  label,
  first,
  onBlockChange,
}: InserterRowProps) {
  const insert = (): void => {
    const { block, lineIndex } = insertFieldAt(
      table,
      atLineIndex,
      indent,
      uniquePlaceholder(existingKeys),
      "",
    );
    onBlockChange(block, { kind: "line", lineIndex });
  };

  return (
    <tr className={first ? "frontmatter-inserter frontmatter-inserter-first" : "frontmatter-inserter"}>
      {/* Spans the key and value columns only, so the line stops at the grid's
          edge instead of running under the actions gutter. */}
      <td colSpan={2} className="frontmatter-inserter-cell">
        <div className="frontmatter-inserter-line" />
        <button
          type="button"
          className="frontmatter-inserter-btn"
          title={label}
          aria-label={label}
          onClick={insert}
        >
          <ControlIcon icon={Plus} />
        </button>
      </td>
    </tr>
  );
}

interface ScalarRowProps extends RowProps {
  field: FmScalar;
  parent?: FmGroup;
  rememberKeyCell: (lineIndex: number) => (cell: HTMLTableCellElement | null) => void;
}

function ScalarRow({
  table,
  field,
  parent,
  rememberKeyCell,
  onBlockChange,
}: ScalarRowProps) {
  const rename = (key: string): void => {
    field.key = key;
    onBlockChange(rewriteScalar(table, field));
  };
  const changeValue = (value: string): void => {
    field.value = value;
    onBlockChange(rewriteScalar(table, field));
  };

  return (
    <tr className={field.depth > 0 ? "frontmatter-row frontmatter-row-nested" : "frontmatter-row"}>
      <EditableKey
        cellRef={rememberKeyCell(field.lineIndex)}
        lineIndex={field.lineIndex}
        className="frontmatter-key"
        value={field.key}
        onChange={rename}
      />
      <EditableValue lineIndex={field.lineIndex} value={field.value} onChange={changeValue} />
      <Actions>
        {parent && <AddToGroupButton table={table} group={parent} onBlockChange={onBlockChange} />}
        <DeleteButton table={table} field={field} onBlockChange={onBlockChange} />
      </Actions>
    </tr>
  );
}

interface GroupRowProps extends RowProps {
  group: FmGroup;
  rememberKeyCell: (lineIndex: number) => (cell: HTMLTableCellElement | null) => void;
}

function GroupRow({ table, group, rememberKeyCell, onBlockChange }: GroupRowProps) {
  const rename = (key: string): void => {
    group.key = key;
    onBlockChange(rewriteGroupKey(table, group));
  };

  return (
    <tr className="frontmatter-row frontmatter-row-group">
      <EditableKey
        cellRef={rememberKeyCell(group.headerIndex)}
        lineIndex={group.headerIndex}
        className="frontmatter-key frontmatter-key-group"
        value={group.key}
        onChange={rename}
      />
      <td className="frontmatter-value frontmatter-value-group" />
      <Actions>
        <AddToGroupButton table={table} group={group} onBlockChange={onBlockChange} />
        <DeleteButton table={table} field={group} onBlockChange={onBlockChange} />
      </Actions>
    </tr>
  );
}

interface RawRowProps extends RowProps {
  field: FmRaw;
}

function RawRow({ table, field, onBlockChange }: RawRowProps) {
  return (
    <tr className="frontmatter-row">
      <th scope="row" className="frontmatter-key" data-line={field.blockStart} data-part="key">
        {field.key}
      </th>
      <td className="frontmatter-value" data-line={field.blockStart} data-part="value">
        <pre className="frontmatter-code">{field.display}</pre>
      </td>
      <Actions>
        <DeleteButton table={table} field={field} onBlockChange={onBlockChange} />
      </Actions>
    </tr>
  );
}

interface EditableKeyProps {
  cellRef: (cell: HTMLTableCellElement | null) => void;
  lineIndex: number;
  className: string;
  value: string;
  onChange: (value: string) => void;
}

function EditableKey({ cellRef, lineIndex, className, value, onChange }: EditableKeyProps) {
  let lastValid = value;
  const input = (event: FormEvent<HTMLTableCellElement>): void => {
    const cell = event.currentTarget;
    const text = (cell.textContent ?? "").replace(/\r?\n/g, " ");
    if (isValidEditableKey(text)) {
      lastValid = text.trim();
      if (cell.textContent !== lastValid) {
        cell.textContent = lastValid;
        placeCaretAtEnd(cell);
      }
      onChange(lastValid);
    } else {
      cell.textContent = lastValid;
      placeCaretAtEnd(cell);
    }
  };

  return (
    <th
      ref={cellRef}
      scope="row"
      className={`${className} frontmatter-edit`}
      data-line={lineIndex}
      data-part="key"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={preventEnter}
      onInput={input}
    >
      {value}
    </th>
  );
}

interface EditableValueProps {
  lineIndex: number;
  value: string;
  onChange: (value: string) => void;
}

function EditableValue({ lineIndex, value, onChange }: EditableValueProps) {
  const input = (event: FormEvent<HTMLTableCellElement>): void => {
    const cell = event.currentTarget;
    let text = cell.textContent ?? "";
    if (/\r?\n/.test(text)) {
      text = text.replace(/\r?\n/g, " ");
      cell.textContent = text;
      placeCaretAtEnd(cell);
    }
    onChange(text);
  };

  return (
    <td
      className="frontmatter-value frontmatter-value-edit frontmatter-edit"
      data-line={lineIndex}
      data-part="value"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={preventEnter}
      onInput={input}
    >
      {value}
    </td>
  );
}

interface GroupButtonProps extends RowProps {
  group: FmGroup;
}

function AddToGroupButton({ table, group, onBlockChange }: GroupButtonProps) {
  const add = (): void => {
    const { block, lineIndex } = insertFieldAt(
      table,
      group.blockEnd,
      group.childIndent,
      uniquePlaceholder(allFrontmatterKeys(table)),
      "",
    );
    onBlockChange(block, { kind: "line", lineIndex });
  };
  return <IconButton icon={Plus} label="Add field to this group" onClick={add} />;
}

interface DeleteButtonProps extends RowProps {
  field: FmField;
}

function DeleteButton({ table, field, onBlockChange }: DeleteButtonProps) {
  return (
    <IconButton
      icon={X}
      label="Delete"
      onClick={() => onBlockChange(deleteField(table, field), { kind: "add" })}
    />
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <td className="frontmatter-actions">{children}</td>;
}

function IconButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="frontmatter-icon-btn"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <ControlIcon icon={icon} />
    </button>
  );
}

/** A 14px glyph for the panel's controls, in Mervin's 1px line weight. The
 *  button owns the accessible name, so the glyph is hidden from assistive tech. */
function ControlIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" focusable="false" size={14} absoluteStrokeWidth strokeWidth={1} />;
}

function FrontmatterTab() {
  return <span className="frontmatter-tab">Frontmatter</span>;
}

function preventEnter(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === "Enter") event.preventDefault();
}

/** Move the caret to the end after normalizing an editable cell. */
function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Select a newly inserted placeholder so the next keystroke replaces it. */
function selectAllText(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** All keys across top-level fields and mapping children. */
function allFrontmatterKeys(table: FrontmatterTableModel): Set<string> {
  const keys = new Set<string>();
  for (const field of table.fields) {
    keys.add(field.key);
    if (field.kind === "group") {
      for (const child of field.children) keys.add(child.key);
    }
  }
  return keys;
}

/** A collision-free placeholder key: key, key-2, key-3, ... */
function uniquePlaceholder(existing: Set<string>): string {
  if (!existing.has("key")) return "key";
  let suffix = 2;
  while (existing.has(`key-${suffix}`)) suffix += 1;
  return `key-${suffix}`;
}
