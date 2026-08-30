import { useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";

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

function TextPromptDialog({
  options,
  finish,
}: {
  options: TextPromptOptions;
  finish(value: string | null): void;
}) {
  const [value, setValue] = useState(options.initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    finish(value);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish(null); }}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-1000 bg-black/35" />
        <DialogContent
          className="fixed left-1/2 top-1/2 z-1001 flex w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-[var(--chrome-border)] bg-[var(--editor-bg)] text-[var(--chrome-fg)] shadow-[0_12px_48px_rgba(0,0,0,0.3)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
          <DialogTitle className="m-0 px-5 pb-2 pt-4 text-lg font-semibold">
            {options.title}
          </DialogTitle>
          <DialogDescription
            className={options.description
              ? "px-5 pb-2 text-[13px] text-[var(--muted-fg)]"
              : "sr-only"}
          >
            {options.description ?? options.label}
          </DialogDescription>
          <form onSubmit={submit}>
            <div className="px-5 py-2">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span>{options.label}</span>
                <input
                  ref={inputRef}
                  value={value}
                  onChange={(event) => setValue(event.currentTarget.value)}
                  className="w-full rounded-[5px] border border-[var(--chrome-border)] bg-[var(--editor-bg)] px-2 py-1.5 font-[inherit] text-[var(--chrome-fg)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
                />
              </label>
            </div>
            <div className="mt-2 flex justify-end gap-2 border-t border-[var(--chrome-border)] px-5 pb-4 pt-3">
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
