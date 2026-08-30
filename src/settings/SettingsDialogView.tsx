import { forwardRef, useRef, useState } from "react";
import type { FormEvent, ForwardedRef, ReactElement, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  dialogButtonClassName,
  dialogContentClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
} from "@/components/ui/dialog-layout";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { openDefaultAppsSettings } from "@/ipc/commands";
import { isTauri } from "@/ipc/env";
import { DEFAULT_ACCENT, normalizeHex } from "@/shell/accent";
import { checkForUpdates } from "@/shell/updater";
import type { Settings } from "@/state/types";
import { layoutFromDefaultView } from "@/state/types";
import { cn } from "@/lib/utils";
import { AccentColorFieldView } from "./AccentColorFieldView";

export interface SettingsDialogViewProps {
  initial: Settings;
  onSave: (next: Settings) => void;
  onRequestClose: () => void;
}

export function SettingsDialogView({ initial, onSave, onRequestClose }: SettingsDialogViewProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const accentModeRef = useRef<HTMLSelectElement>(null);
  const [accentColor, setAccentColor] = useState(
    () => normalizeHex(initial.accentColor) ?? DEFAULT_ACCENT,
  );
  const [updateStatus, setUpdateStatus] = useState("");

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = formRef.current;
    if (!form) return;

    const input = (name: string): HTMLInputElement =>
      form.elements.namedItem(name) as HTMLInputElement;
    const select = (name: string): HTMLSelectElement =>
      form.elements.namedItem(name) as HTMLSelectElement;

    const editorWidthPx = input("editorWidthPx");
    const editorFontScalePct = input("editorFontScalePct");
    const maxEmbedSizeKB = input("maxEmbedSizeKB");
    const maxRetainedTabEditors = input("maxRetainedTabEditors");
    const hardWrapCol = input("hardWrapCol");
    const autosaveIntervalSeconds = input("autosaveIntervalSeconds");
    const recentFilesMaxRetained = input("recentFilesMaxRetained");
    const recentFilesVisibleCount = input("recentFilesVisibleCount");
    const fontFamily = input("fontFamily");
    const attachmentsFolderName = input("attachmentsFolderName");

    const next: Settings = {
      ...initial,
      theme: select("theme").value as Settings["theme"],
      accentMode: select("accentMode").value as Settings["accentMode"],
      accentColor,
      editorTheme: select("editorTheme").value as Settings["editorTheme"],
      editorWidthMode: select("editorWidthMode").value as Settings["editorWidthMode"],
      editorWidthPx: numVal(editorWidthPx, initial.editorWidthPx),
      fontFamily: fontFamily.value || initial.fontFamily,
      editorFontScale:
        numVal(editorFontScalePct, Math.round(initial.editorFontScale * 100)) / 100,
      linkDisplay: select("linkDisplay").value as Settings["linkDisplay"],
      embedImagesAsBase64: input("embedImagesAsBase64").checked,
      maxEmbedSizeKB: numVal(maxEmbedSizeKB, initial.maxEmbedSizeKB),
      attachmentsFolderName: attachmentsFolderName.value || initial.attachmentsFolderName,
      defaultView: select("defaultView").value as Settings["defaultView"],
      collapseBase64InRawView: input("collapseBase64InRawView").checked,
      spellCheckEnabled: input("spellCheckEnabled").checked,
      showFrontmatterPanel: input("showFrontmatterPanel").checked,
      maxRetainedTabEditors: numVal(maxRetainedTabEditors, initial.maxRetainedTabEditors),
      mdBulletChar: select("mdBulletChar").value as Settings["mdBulletChar"],
      mdEmphasisChar: select("mdEmphasisChar").value as Settings["mdEmphasisChar"],
      mdStrongChar: select("mdStrongChar").value as Settings["mdStrongChar"],
      mdHeadingStyle: select("mdHeadingStyle").value as Settings["mdHeadingStyle"],
      mdHardWrap: input("hardWrapOn").checked ? numVal(hardWrapCol, 80) : false,
      autosaveEnabled: input("autosaveEnabled").checked,
      autosaveIntervalSeconds: numVal(
        autosaveIntervalSeconds,
        initial.autosaveIntervalSeconds,
      ),
      recentFilesMaxRetained: numVal(
        recentFilesMaxRetained,
        initial.recentFilesMaxRetained,
      ),
      recentFilesVisibleCount: numVal(
        recentFilesVisibleCount,
        initial.recentFilesVisibleCount,
      ),
    };

    onSave(next);
    onRequestClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onRequestClose()}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn("dialog settings-dialog", dialogContentClassName)}
        >
          <DialogTitle asChild>
            <h2 className={cn("dialog-title", dialogTitleClassName)}>Settings</h2>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure the editor appearance, editing behavior, files, autosave, and updates.
          </DialogDescription>
          <form ref={formRef} className="settings-form contents" onSubmit={save}>
            <div className={cn("dialog-body", dialogBodyClassName)}>
              <DialogSection heading="Appearance">
                <DialogRow label="UI theme">
                  <NativeSelect name="theme" values={["system", "light", "dark"]} value={initial.theme} />
                </DialogRow>
                <DialogRow label="Document color">
                  <LabeledSelect
                    name="editorTheme"
                    options={[
                      ["light", "light"],
                      ["dark", "dark"],
                      ["follow-ui", "UI theme"],
                    ]}
                    value={initial.editorTheme}
                  />
                </DialogRow>
                <DialogRow label="Accent color">
                  <NativeSelect
                    ref={accentModeRef}
                    name="accentMode"
                    values={["default", "system", "custom"]}
                    value={initial.accentMode}
                  />
                </DialogRow>
                <DialogRow label="Custom accent" asLabel={false}>
                  <AccentColorFieldView
                    initial={accentColor}
                    onCommit={(color) => {
                      setAccentColor(color);
                      if (accentModeRef.current) accentModeRef.current.value = "custom";
                    }}
                  />
                </DialogRow>
                <DialogRow label="Document text size (%)">
                  <NumberInput
                    name="editorFontScalePct"
                    value={Math.round(initial.editorFontScale * 100)}
                    min={60}
                    max={250}
                  />
                </DialogRow>
                <DialogRow label="Page width">
                  <NativeSelect
                    name="editorWidthMode"
                    values={["fill", "fixed"]}
                    value={initial.editorWidthMode}
                  />
                </DialogRow>
                <DialogRow label="Fixed width (px)">
                  <NumberInput name="editorWidthPx" value={initial.editorWidthPx} min={320} max={2000} />
                </DialogRow>
                <DialogRow label="Body font">
                  <Input name="fontFamily" type="text" defaultValue={initial.fontFamily} />
                </DialogRow>
              </DialogSection>

              <DialogSection heading="Editor">
                <DialogRow label="Default view">
                  <LabeledSelect
                    name="defaultView"
                    options={[
                      ["document", "Document"],
                      ["split", "Split"],
                      ["markdown", "Markdown"],
                    ]}
                    value={layoutFromDefaultView(initial)}
                  />
                </DialogRow>
                <DialogRow label="Spell check">
                  <CheckInput name="spellCheckEnabled" checked={initial.spellCheckEnabled} />
                </DialogRow>
                <DialogRow label="Collapse base64 in raw view">
                  <CheckInput
                    name="collapseBase64InRawView"
                    checked={initial.collapseBase64InRawView}
                  />
                </DialogRow>
                <DialogRow label="Show frontmatter table">
                  <CheckInput name="showFrontmatterPanel" checked={initial.showFrontmatterPanel} />
                </DialogRow>
                <DialogRow label="Link display">
                  <NativeSelect
                    name="linkDisplay"
                    values={["text-and-url", "text-only"]}
                    value={initial.linkDisplay}
                  />
                </DialogRow>
                <DialogRow label="Tabs that keep undo history">
                  <NumberInput
                    name="maxRetainedTabEditors"
                    value={initial.maxRetainedTabEditors}
                    min={1}
                    max={20}
                  />
                </DialogRow>
              </DialogSection>

              <DialogSection heading="Images">
                <DialogRow label="Embed images as base64">
                  <CheckInput name="embedImagesAsBase64" checked={initial.embedImagesAsBase64} />
                </DialogRow>
                <DialogRow label="Max embed size (KB)">
                  <NumberInput
                    name="maxEmbedSizeKB"
                    value={initial.maxEmbedSizeKB}
                    min={0}
                    max={1_000_000}
                  />
                </DialogRow>
                <DialogRow label="Attachments folder">
                  <Input
                    name="attachmentsFolderName"
                    type="text"
                    defaultValue={initial.attachmentsFolderName}
                  />
                </DialogRow>
              </DialogSection>

              <DialogSection heading="Markdown serialization">
                <DialogRow label="Bullet">
                  <NativeSelect
                    name="mdBulletChar"
                    values={["-", "*", "+"]}
                    value={initial.mdBulletChar}
                  />
                </DialogRow>
                <DialogRow label="Italic">
                  <NativeSelect
                    name="mdEmphasisChar"
                    values={["*", "_"]}
                    value={initial.mdEmphasisChar}
                  />
                </DialogRow>
                <DialogRow label="Bold">
                  <NativeSelect
                    name="mdStrongChar"
                    values={["**", "__"]}
                    value={initial.mdStrongChar}
                  />
                </DialogRow>
                <DialogRow label="Heading style">
                  <NativeSelect
                    name="mdHeadingStyle"
                    values={["atx", "setext"]}
                    value={initial.mdHeadingStyle}
                  />
                </DialogRow>
                <DialogRow label="Hard wrap">
                  <CheckInput name="hardWrapOn" checked={initial.mdHardWrap !== false} />
                </DialogRow>
                <DialogRow label="Wrap column">
                  <NumberInput
                    name="hardWrapCol"
                    value={typeof initial.mdHardWrap === "number" ? initial.mdHardWrap : 80}
                    min={20}
                    max={400}
                  />
                </DialogRow>
              </DialogSection>

              <DialogSection heading="Autosave & history">
                <DialogRow label="Autosave to file">
                  <CheckInput name="autosaveEnabled" checked={initial.autosaveEnabled} />
                </DialogRow>
                <DialogRow label="Autosave interval (s)">
                  <NumberInput
                    name="autosaveIntervalSeconds"
                    value={initial.autosaveIntervalSeconds}
                    min={5}
                    max={3600}
                  />
                </DialogRow>
                <DialogRow label="Recent files retained">
                  <NumberInput
                    name="recentFilesMaxRetained"
                    value={initial.recentFilesMaxRetained}
                    min={10}
                    max={100_000}
                  />
                </DialogRow>
                <DialogRow label="Recent files shown">
                  <NumberInput
                    name="recentFilesVisibleCount"
                    value={initial.recentFilesVisibleCount}
                    min={1}
                    max={100_000}
                  />
                </DialogRow>
              </DialogSection>

              {isTauri() && (
                <>
                  <DialogSection heading="Default app for .md">
                    <div className="dialog-row flex items-center justify-between gap-3 py-1 text-[13px]">
                      <span className="settings-status flex-1 text-[13px] text-muted-foreground">
                        Set md-easy as the default app for .md files.
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn("dialog-btn", dialogButtonClassName)}
                        onClick={() => void openDefaultAppsSettings()}
                      >
                        Set as default…
                      </Button>
                    </div>
                  </DialogSection>
                  <DialogSection heading="Updates">
                    <div className="dialog-row flex items-center justify-between gap-3 py-1 text-[13px]">
                      <span className="settings-status flex-1 text-[13px] text-muted-foreground">
                        Current version: {__APP_VERSION__}
                      </span>
                    </div>
                    <div className="dialog-row flex items-center justify-between gap-3 py-1 text-[13px]">
                      <span className="settings-status flex-1 text-[13px] text-muted-foreground">
                        {updateStatus}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn("dialog-btn", dialogButtonClassName)}
                        onClick={() => {
                          setUpdateStatus("Checking…");
                          void checkForUpdates().then(setUpdateStatus);
                        }}
                      >
                        Check for updates
                      </Button>
                    </div>
                  </DialogSection>
                </>
              )}
            </div>

            <div className={cn("dialog-footer", dialogFooterClassName)}>
              <Button
                type="button"
                variant="outline"
                className={cn("dialog-btn", dialogButtonClassName)}
                onClick={onRequestClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className={cn("dialog-btn primary", dialogButtonClassName)}
              >
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function DialogSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="dialog-section border-t border-border py-2.5 first:border-t-0">
      <h3 className="dialog-section-title mb-2 mt-1 text-xs uppercase tracking-[.04em] text-muted-foreground">
        {heading}
      </h3>
      {children}
    </section>
  );
}

function DialogRow({
  label,
  children,
  asLabel = true,
}: {
  label: string;
  children: ReactNode;
  asLabel?: boolean;
}) {
  const content = (
    <>
      <span>{label}</span>
      {children}
    </>
  );
  return asLabel ? (
    <label className="dialog-row flex items-center justify-between gap-3 py-1 text-[13px]">
      {content}
    </label>
  ) : (
    <div className="dialog-row flex items-center justify-between gap-3 py-1 text-[13px]">
      {content}
    </div>
  );
}

interface NativeSelectProps<T extends string> {
  name: string;
  values: readonly T[];
  value: T;
}

function NativeSelectInner<T extends string>(
  { name, values, value }: NativeSelectProps<T>,
  ref: ForwardedRef<HTMLSelectElement>,
) {
  return (
    <Select ref={ref} name={name} defaultValue={value}>
      {values.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </Select>
  );
}

const NativeSelect = forwardRef(NativeSelectInner) as <T extends string>(
  props: NativeSelectProps<T> & { ref?: ForwardedRef<HTMLSelectElement> },
) => ReactElement;

function LabeledSelect<T extends string>({
  name,
  options,
  value,
}: {
  name: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
}) {
  return (
    <Select name={name} defaultValue={value}>
      {options.map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </Select>
  );
}

function NumberInput({
  name,
  value,
  min,
  max,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
}) {
  return <Input name={name} type="number" defaultValue={value} min={min} max={max} />;
}

function CheckInput({ name, checked }: { name: string; checked: boolean }) {
  return <Checkbox name={name} defaultChecked={checked} />;
}

function numVal(input: HTMLInputElement, fallback: number): number {
  if (input.value.trim() === "") return fallback;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  const min = input.min !== "" ? Number(input.min) : -Infinity;
  const max = input.max !== "" ? Number(input.max) : Infinity;
  return Math.min(Math.max(value, min), max);
}
