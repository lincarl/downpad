import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MathfieldElement, validateLatex } from "mathlive";
import "mathlive/fonts.css";
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
import {
  dialogBodyClassName,
  dialogContentClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
} from "@/components/ui/dialog-layout";
import { cn } from "@/lib/utils";
import "./mathEditor.css";

// Vite bundles the imported fonts. MathLive must not fetch fonts, sounds or an
// optional compute engine from a CDN when the desktop app is offline.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

export interface MathEditorOptions {
  latex: string;
  display: boolean;
  /** Return false when the original equation can no longer accept this draft. */
  onSave(latex: string): boolean;
  /** Restore editor focus here. Also called when the owner closes the dialog. */
  onClose(): void;
}

export interface MathEditorHandle {
  close(): void;
}

/** Open an isolated draft. Only Apply calls onSave; close and Cancel discard it. */
export function openMathEditor(options: MathEditorOptions): MathEditorHandle {
  const host = document.createElement("div");
  host.dataset.reactMathEditor = "";
  document.body.append(host);
  const root = createRoot(host);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    disposeReactRoot(root, host);
    options.onClose();
  };

  flushSync(() => root.render(
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <MathEditorContent options={options} close={close} />
      </DialogPortal>
    </Dialog>,
  ));
  return { close };
}

/** Check the actual source, since MathLive's parsed value can omit unknown input. */
function syntaxWarning(latex: string): string | null {
  try {
    const errors = validateLatex(latex);
    if (errors.length === 0) return null;
    const unsupported = errors.find((error) =>
      error.code === "unknown-command" || error.code === "unknown-environment",
    );
    return unsupported
      ? "The visual editor does not support some commands. Use LaTeX source to preserve them. You can still apply this source."
      : "The visual editor cannot fully read this LaTeX. Check the source for missing arguments or delimiters. You can still apply it.";
  } catch {
    return "The visual editor cannot read this LaTeX. You can still edit and apply the source.";
  }
}

const keyboardIconNames: Record<string, string> = {
  "#svg-shift": "Shift",
  "#svg-arrow-left": "Move left",
  "#svg-arrow-right": "Move right",
  "#svg-angle-double-left": "Extend selection left",
  "#svg-angle-double-right": "Extend selection right",
  "#svg-delete-backward": "Backspace",
  "#svg-trash": "Delete all",
  "#svg-commit": "Return",
  "#circle-plus": "Add row",
  "#svg-keyboard-down": "Hide keyboard",
};

/** Name MathLive's action icons without announcing drawings inside named keys. */
function labelKeyboardImages(host: HTMLElement): void {
  for (const svg of host.querySelectorAll("svg")) {
    if (svg.hasAttribute("aria-label") || svg.hasAttribute("aria-labelledby") || svg.hasAttribute("aria-hidden")) continue;
    const key = svg.closest(".MLK__keycap, .action, .shift");
    if (key?.getAttribute("aria-label")) {
      svg.setAttribute("aria-hidden", "true");
      continue;
    }
    const label = key?.getAttribute("data-tooltip") ||
      keyboardIconNames[svg.querySelector("use")?.getAttribute("xlink:href") ?? ""];
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    }
  }
}

/** Keep the raw draft until a visual input event explicitly replaces it. */
function MathEditorContent({ options, close }: { options: MathEditorOptions; close(): void }) {
  const [draft, setDraft] = useState(options.latex);
  const [warning, setWarning] = useState(() => syntaxWarning(options.latex));
  const [saveError, setSaveError] = useState(false);
  const [visualUnavailable, setVisualUnavailable] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const draftRef = useRef(options.latex);
  const visualHostRef = useRef<HTMLDivElement>(null);
  const keyboardHostRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const mathfieldRef = useRef<MathfieldElement | null>(null);
  const sourceId = useId();
  const warningId = useId();
  const helpId = useId();
  const keyboardId = useId();

  useLayoutEffect(() => {
    const visualHost = visualHostRef.current;
    const keyboardHost = keyboardHostRef.current;
    if (!visualHost || !keyboardHost) return;

    const field = new MathfieldElement();
    field.setAttribute("aria-label", "Equation");
    field.setAttribute("aria-describedby", helpId);
    field.mathVirtualKeyboardPolicy = "manual";
    field.defaultMode = options.display ? "math" : "inline-math";
    // MathLive's command popover attaches to document.body, outside Radix's
    // focus trap. Commands remain available through the embedded keyboard.
    field.popoverPolicy = "off";
    mathfieldRef.current = field;
    visualHost.append(field);
    field.menuItems = [];

    const keyboard = window.mathVirtualKeyboard;
    const previousLayouts = keyboard.layouts;
    keyboard.hide({ animate: false });
    keyboard.container = keyboardHost;
    keyboard.layouts = ["symbols", "numeric", "greek", "alphabetic"];

    /** Programmatic setValue is silent, so focus and keyboard toggles never rewrite source. */
    const onVisualInput = (): void => {
      const value = field.value;
      draftRef.current = value;
      setDraft(value);
      setWarning(syntaxWarning(value));
    };
    /** MathLive positions keys absolutely, so its custom container needs a height. */
    const onKeyboardGeometry = (): void => {
      keyboardHost.style.height = keyboard.visible ? `${keyboard.boundingRect.height + 10}px` : "";
      setKeyboardVisible(keyboard.visible);
    };
    field.addEventListener("input", onVisualInput);
    keyboard.addEventListener("geometrychange", onKeyboardGeometry);
    keyboard.addEventListener("virtual-keyboard-toggle", onKeyboardGeometry);
    // MathLive rebuilds its keyboard and editing toolbar as the draft changes.
    const keyboardObserver = new MutationObserver(() => labelKeyboardImages(keyboardHost));
    keyboardObserver.observe(keyboardHost, { childList: true, subtree: true });

    try {
      field.setValue(draftRef.current, { silenceNotifications: true });
    } catch {
      field.readOnly = true;
      setVisualUnavailable(true);
      setWarning("The visual editor cannot read this LaTeX. You can still edit and apply the source.");
    }
    // Radix autofocus can run before the custom element mounts in this effect.
    const focusFrame = requestAnimationFrame(() => {
      if (field.readOnly) sourceRef.current?.focus();
      else {
        field.focus();
        keyboard.show({ animate: false });
      }
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      field.removeEventListener("input", onVisualInput);
      keyboard.removeEventListener("geometrychange", onKeyboardGeometry);
      keyboard.removeEventListener("virtual-keyboard-toggle", onKeyboardGeometry);
      keyboardObserver.disconnect();
      keyboard.hide({ animate: false });
      field.remove();
      mathfieldRef.current = null;
      keyboard.container = document.body;
      keyboard.layouts = previousLayouts;
    };
  }, [helpId, options.display]);

  /** Update the visual draft without accepting MathLive's normalization as source. */
  const changeSource = (value: string): void => {
    draftRef.current = value;
    setDraft(value);
    setWarning(syntaxWarning(value));
    const field = mathfieldRef.current;
    if (!field) return;
    try {
      field.setValue(value, { silenceNotifications: true });
      field.readOnly = false;
      setVisualUnavailable(false);
    } catch {
      field.readOnly = true;
      setVisualUnavailable(true);
      setWarning("The visual editor cannot read this LaTeX. You can still edit and apply the source.");
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (options.onSave(draftRef.current)) close();
    else setSaveError(true);
  };

  const toggleKeyboard = (): void => {
    const keyboard = window.mathVirtualKeyboard;
    if (keyboard.visible) keyboard.hide({ animate: false });
    else {
      mathfieldRef.current?.focus();
      keyboard.show({ animate: false });
    }
  };

  return (
    <DialogContent
      className={cn(dialogContentClassName, "math-editor-dialog")}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (mathfieldRef.current?.readOnly) sourceRef.current?.focus();
        else mathfieldRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <DialogTitle className={dialogTitleClassName}>Edit equation</DialogTitle>
      <DialogDescription className="math-editor-description">
        Edit the equation visually or change its LaTeX source.
      </DialogDescription>
      <form className="math-editor-form" onSubmit={submit}>
        <div className={cn(dialogBodyClassName, "math-editor-body")}>
          <div className="math-editor-field-heading">
            <span>Equation</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={keyboardVisible}
              aria-controls={keyboardId}
              disabled={visualUnavailable}
              onClick={toggleKeyboard}
            >
              {keyboardVisible ? "Hide symbols" : "Show symbols"}
            </Button>
          </div>
          <div ref={visualHostRef} className="math-editor-visual" />
          <div
            ref={keyboardHostRef}
            id={keyboardId}
            className="math-editor-keyboard"
            aria-label="Equation symbols"
          />
          <label htmlFor={sourceId} className="math-editor-source-label">LaTeX source</label>
          <textarea
            ref={sourceRef}
            id={sourceId}
            className="math-editor-source"
            value={draft}
            onChange={(event) => changeSource(event.currentTarget.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby={`${helpId}${warning ? ` ${warningId}` : ""}`}
            rows={3}
          />
          <p id={helpId} className="math-editor-help">
            The document uses KaTeX, whose supported commands can differ from this visual editor.
          </p>
          {warning && <p id={warningId} className="math-editor-warning" role="status">{warning}</p>}
          {saveError && (
            <p className="math-editor-error" role="alert">
              This equation changed or was removed. Copy your draft before closing.
            </p>
          )}
        </div>
        <div className={dialogFooterClassName}>
          <Button type="button" variant="outline" onClick={close}>Cancel</Button>
          <Button type="submit">Apply</Button>
        </div>
      </form>
    </DialogContent>
  );
}
