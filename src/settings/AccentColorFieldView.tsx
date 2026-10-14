import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { dialogButtonClassName } from "@/components/ui/dialog-layout";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { normalizeHex } from "@/shell/accent";

export interface AccentColorFieldViewProps {
  /** The accent the swatch shows now: the staged custom colour, the system
   *  accent, or the theme's default. The picker opens on it. */
  value: string;
  /** The current UI theme's default accent, which the picker's Default button
   *  restores. */
  defaultColor: string;
  /** Disabled while the system accent is in use. */
  disabled?: boolean;
  onCommit: (color: string) => void;
}

/**
 * Mervin's accent swatch: a 48x24 button filled with the accent that opens a
 * staged picker. Its OK button commits only to the surrounding Settings form;
 * the form's Save button is still what applies the setting.
 */
export function AccentColorFieldView({ value, defaultColor, disabled, onCommit }: AccentColorFieldViewProps) {
  const [draft, setDraft] = useState(value);
  const [hexText, setHexText] = useState(value);
  const [open, setOpen] = useState(false);
  const hexRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);

  const setCanonicalDraft = (next: string, syncHex = true): void => {
    const normalized = normalizeHex(next);
    if (!normalized) return;
    setDraft(normalized);
    if (syncHex) setHexText(normalized);
  };

  const setPopoverOpen = (next: boolean): void => {
    if (next) {
      setDraft(value);
      setHexText(value);
      restoreFocus.current = false;
    }
    setOpen(next);
  };

  const close = (focusSwatch: boolean): void => {
    restoreFocus.current = focusSwatch;
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="accent-swatch h-6 w-12 shrink-0 cursor-pointer rounded-[4px] border border-black/35 p-0 outline-none focus-ring disabled:cursor-default"
          aria-label="Choose custom accent color"
          title="Choose accent color"
          style={{ background: value }}
        />
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          className="accent-popover relative z-[1100] flex flex-col gap-2.5 rounded-[10px] border border-line-popover bg-popover p-3 font-[family-name:var(--font-ui)] text-[12px] text-ink outline-none dark:border-line-strong"
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            hexRef.current?.focus();
            hexRef.current?.select();
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreFocus.current) event.preventDefault();
            restoreFocus.current = false;
          }}
          onEscapeKeyDown={(event) => {
            // Escape dismisses this nested picker, not the Settings dialog.
            restoreFocus.current = true;
            event.stopPropagation();
          }}
          onPointerDownOutside={() => {
            // An outside click should focus what was clicked, not the swatch.
            restoreFocus.current = false;
          }}
          onFocusOutside={(event) => {
            // The legacy picker stayed open while tabbing; only an outside click,
            // Escape, the trigger, or an explicit footer action dismisses it.
            event.preventDefault();
          }}
        >
          <div className="accent-picker-row flex items-center gap-2">
            <input
              type="color"
              aria-label="Accent color"
              className="accent-picker-input h-[29px] w-12 cursor-pointer rounded-control border border-line-popover-control bg-well p-[3px] [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
              value={draft}
              onChange={(event) => setCanonicalDraft(event.currentTarget.value)}
            />
            <Input
              ref={hexRef}
              type="text"
              className="accent-hex w-24 min-w-0 border-line-popover-control"
              spellCheck={false}
              aria-label="Accent color hex"
              value={hexText}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setHexText(text);
                setCanonicalDraft(text, false);
              }}
              onBlur={() => setHexText(draft)}
            />
          </div>
          <div className="accent-popover-footer flex justify-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => setCanonicalDraft(defaultColor)}
            >
              Default
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => close(true)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className={cn("dialog-btn primary", dialogButtonClassName)}
              onClick={() => {
                onCommit(draft);
                close(true);
              }}
            >
              OK
            </Button>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
