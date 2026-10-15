import { useId, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  dialogBodyClassName,
  dialogContentClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
} from "@/components/ui/dialog-layout";
import { cn } from "@/lib/utils";

export interface TextPromptOptions {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  description?: string;
}

/**
 * Programmatic React prompt for imperative editor actions.
 *
 * Editor plugins cannot render in the application component tree, but their UI
 * should still use the same accessible Radix/shadcn dialog as the rest of the
 * app. `null` means the user cancelled; an empty string is a valid submission.
 */
export function openTextPrompt(options: TextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.dataset.reactTextPrompt = "";
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      disposeReactRoot(root, host);
      resolve(value);
    };

    flushSync(() => root.render(<TextPromptDialog options={options} finish={finish} />));
  });
}

/** The prompt itself: title, optional description, a labelled field, then
 *  Cancel and the confirm button. */
function TextPromptDialog({
  options,
  finish,
}: {
  options: TextPromptOptions;
  finish(value: string | null): void;
}) {
  const [value, setValue] = useState(options.initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    finish(value);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish(null); }}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn("text-prompt-dialog", dialogContentClassName, "w-[min(440px,92vw)]")}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
          <DialogTitle className={dialogTitleClassName}>{options.title}</DialogTitle>
          <DialogDescription
            className={options.description ? "m-0 px-[22px] pb-2 text-ink-soft" : "sr-only"}
          >
            {options.description ?? options.label}
          </DialogDescription>
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <div className={cn(dialogBodyClassName, "pt-1")}>
              <label htmlFor={inputId} className="mb-1.5 block text-ink">
                {options.label}
              </label>
              <Input
                ref={inputRef}
                id={inputId}
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                className="w-full min-w-0"
              />
            </div>
            <div className={dialogFooterClassName}>
              <Button type="button" variant="outline" onClick={() => finish(null)}>
                Cancel
              </Button>
              <Button type="submit">{options.confirmLabel ?? "OK"}</Button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
