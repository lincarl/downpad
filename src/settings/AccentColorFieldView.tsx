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
import { DEFAULT_ACCENT, normalizeHex } from "@/shell/accent";
import { cn } from "@/lib/utils";

export interface AccentColorFieldViewProps {
  initial: string;
  onCommit: (color: string) => void;
}

/**
 * A staged custom-accent picker. Its OK button commits only to the surrounding
 * Settings form; the form's Save button is still what applies the setting.
 */
export function AccentColorFieldView({ initial, onCommit }: AccentColorFieldViewProps) {
  const [committed, setCommitted] = useState(() => normalizeHex(initial) ?? DEFAULT_ACCENT);
  const [draft, setDraft] = useState(committed);
  const [hexText, setHexText] = useState(committed);
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
      setDraft(committed);
      setHexText(committed);
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
          className="accent-swatch h-7 w-12 cursor-pointer rounded-[5px] border border-border p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Choose custom accent color"
          title="Choose accent color"
          style={{ background: committed }}
        />
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          className="accent-popover relative z-[1100] flex flex-col gap-2.5 rounded-lg border border-border bg-background p-3 text-foreground shadow-[0_8px_32px_rgba(0,0,0,0.3)] outline-none"
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
              className="accent-picker-input h-[30px] w-11 cursor-pointer rounded-[5px] border border-border bg-background p-0.5"
              value={draft}
              onChange={(event) => setCanonicalDraft(event.currentTarget.value)}
            />
            <Input
              ref={hexRef}
              type="text"
              className="accent-hex w-24 min-w-0"
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
          <div className="accent-popover-footer flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => setCanonicalDraft(DEFAULT_ACCENT)}
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
                setCommitted(draft);
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
