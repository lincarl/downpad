import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  Hash,
  Image,
  Info,
  Keyboard,
  Palette,
  RotateCw,
  Settings as SettingsIcon,
  SquarePen,
  type LucideIcon,
} from "lucide-react";

import { DocumentArtwork } from "@/components/icons";
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
  dialogButtonClassName,
  dialogContentClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
} from "@/components/ui/dialog-layout";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getSystemAccentColor, openDefaultAppsSettings } from "@/ipc/commands";
import { isElectron } from "@/ipc/env";
import { DEFAULT_ACCENT, normalizeHex } from "@/shell/accent";
import { checkForUpdates } from "@/shell/updater";
import type { Settings } from "@/state/types";
import { layoutFromDefaultView } from "@/state/types";
import { cn } from "@/lib/utils";
import { AccentColorFieldView } from "./AccentColorFieldView";
import { CheckRow, FormRow, Hint, SettingsBox, SettingsPage } from "./SettingsLayout";
import { KEYBOARD_SHORTCUTS } from "./shortcuts";
import { ThemeCard, ThemeCardGroup } from "./ThemeCard";
import { DocumentThemePreview, UiThemePreview } from "./ThemePreviews";
import { UI_PALETTES, resolveScheme, type Scheme } from "./themePalettes";

export interface SettingsDialogViewProps {
  initial: Settings;
  onSave: (next: Settings) => void;
  onRequestClose: () => void;
}

type PageId =
  | "general"
  | "appearance"
  | "editor"
  | "images"
  | "markdown"
  | "shortcuts"
  | "updates"
  | "about";

interface PageEntry {
  id: PageId;
  title: string;
  icon: LucideIcon;
  /** Draw the divider above this row, before the secondary pages. */
  divider?: boolean;
}

const UI_THEMES = [
  { value: "dark", label: "Dark", description: "Dark window, toolbars and dialogs" },
  { value: "light", label: "Light", description: "Light window, toolbars and dialogs" },
  {
    value: "system",
    label: "Follow system",
    description: "Switches between light and dark with the operating system",
  },
] as const satisfies ReadonlyArray<{ value: Settings["theme"]; label: string; description: string }>;

const DOCUMENT_THEMES = [
  { value: "light", label: "Light", description: "White page with dark text" },
  { value: "dark", label: "Dark", description: "Dark grey page with light text" },
  {
    value: "follow-ui",
    label: "Follow UI theme",
    description: "Light or dark with the UI theme",
  },
] as const satisfies ReadonlyArray<{ value: Settings["editorTheme"]; label: string; description: string }>;

/** A saved value outside the choices shows the follow choice, as applyTheme
 *  treats it. */
function knownOr<T extends string>(value: string, choices: ReadonlyArray<{ value: T }>, fallback: T): T {
  return choices.find((choice) => choice.value === value)?.value ?? fallback;
}

/** The first control a page's keyboard user lands on: the checked radio of a
 *  card group, otherwise the first enabled field or button. */
const FIRST_CONTROL =
  'input[type="radio"]:checked, input:not([type="radio"]):not([type="hidden"]):not(:disabled), select:not(:disabled), button:not(:disabled)';

export function SettingsDialogView({ initial, onSave, onRequestClose }: SettingsDialogViewProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const baseId = useId();
  const tabId = (page: PageId) => `${baseId}-tab-${page}`;
  const panelId = (page: PageId) => `${baseId}-page-${page}`;

  const [page, setPage] = useState<PageId>("general");
  const [theme, setTheme] = useState(() => knownOr(initial.theme, UI_THEMES, "system"));
  const [documentTheme, setDocumentTheme] = useState(() =>
    knownOr(initial.editorTheme, DOCUMENT_THEMES, "follow-ui"),
  );
  const [accentMode, setAccentMode] = useState(initial.accentMode);
  // What unchecking "Use the system accent color" returns to.
  const chosenAccentMode = useRef<Exclude<Settings["accentMode"], "system">>(
    initial.accentMode === "system" ? "default" : initial.accentMode,
  );
  const [accentColor, setAccentColor] = useState(
    () => normalizeHex(initial.accentColor) ?? DEFAULT_ACCENT,
  );
  const [systemAccent, setSystemAccent] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");

  useEffect(() => {
    if (!isElectron()) return;
    let live = true;
    void getSystemAccentColor()
      .then((color) => {
        if (live) setSystemAccent(normalizeHex(color));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The accent a scheme shows with the staged choice: the custom colour, the
  // OS accent when known, otherwise the scheme's own default.
  const accentFor = (scheme: Scheme): string => {
    if (accentMode === "custom") return accentColor;
    if (accentMode === "system" && systemAccent) return systemAccent;
    return UI_PALETTES[scheme].accent;
  };
  const scheme = resolveScheme(theme);
  const setChosenAccentMode = (mode: Exclude<Settings["accentMode"], "system">): void => {
    chosenAccentMode.current = mode;
    setAccentMode(mode);
  };

  const pages: PageEntry[] = [
    { id: "general", title: "General", icon: SettingsIcon },
    { id: "appearance", title: "Appearance", icon: Palette },
    { id: "editor", title: "Editor", icon: SquarePen },
    { id: "images", title: "Images", icon: Image },
    { id: "markdown", title: "Markdown", icon: Hash },
    { id: "shortcuts", title: "Keyboard shortcuts", icon: Keyboard, divider: true },
    ...(isElectron() ? [{ id: "updates", title: "Updates", icon: RotateCw } as const] : []),
    { id: "about", title: "About", icon: Info },
  ];

  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = pages.findIndex((entry) => entry.id === page);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(index + 1, pages.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = pages.length - 1;
    else if (event.key === "Enter") {
      // Enter moves into the page, as in Mervin; it never submits the form.
      event.preventDefault();
      document.getElementById(panelId(page))?.querySelector<HTMLElement>(FIRST_CONTROL)?.focus();
      return;
    } else return;
    event.preventDefault();
    const target = pages[next].id;
    setPage(target);
    document.getElementById(tabId(target))?.focus();
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = formRef.current;
    if (!form) return;

    const input = (name: string): HTMLInputElement =>
      form.elements.namedItem(name) as HTMLInputElement;
    const select = (name: string): HTMLSelectElement =>
      form.elements.namedItem(name) as HTMLSelectElement;
    const radio = (name: string): RadioNodeList => form.elements.namedItem(name) as RadioNodeList;

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
      theme: radio("theme").value as Settings["theme"],
      accentMode: input("accentMode").value as Settings["accentMode"],
      accentColor,
      editorTheme: radio("editorTheme").value as Settings["editorTheme"],
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

  const pageProps = (id: PageId) => ({ id: panelId(id), tabId: tabId(id), active: page === id });
  const useSystemAccent = accentMode === "system";

  return (
    <Dialog open onOpenChange={(open) => !open && onRequestClose()}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn(
            "dialog settings-dialog",
            dialogContentClassName,
            "h-[min(760px,90vh)] max-h-none w-[min(820px,94vw)] overflow-hidden leading-4",
          )}
        >
          <DialogDescription className="sr-only">
            Configure the editor appearance, editing behavior, files, autosave, and updates.
          </DialogDescription>
          <form ref={formRef} className="settings-form flex min-h-0 flex-1 flex-col" onSubmit={save}>
            <div className="flex min-h-0 flex-1">
              <nav className="settings-nav flex w-[196px] shrink-0 flex-col overflow-y-auto border-r border-line-bar bg-status px-2 py-2.5">
                <DialogTitle asChild>
                  <h2 className="dialog-title m-0 px-3 pb-2.5 pt-1 text-[15px] font-semibold leading-5 text-ink-primary">
                    Settings
                  </h2>
                </DialogTitle>
                <div
                  role="tablist"
                  aria-label="Settings pages"
                  aria-orientation="vertical"
                  className="flex flex-col gap-1"
                  onKeyDown={onNavKeyDown}
                >
                  {pages.map((entry) => {
                    const selected = entry.id === page;
                    const Icon = entry.icon;
                    return (
                      <div key={entry.id} className="contents">
                        {entry.divider && (
                          <div aria-hidden="true" className="mx-[15px] mt-1 h-px shrink-0 bg-separator" />
                        )}
                        <button
                          type="button"
                          role="tab"
                          id={tabId(entry.id)}
                          aria-selected={selected}
                          aria-controls={panelId(entry.id)}
                          tabIndex={selected ? 0 : -1}
                          onClick={() => setPage(entry.id)}
                          className={cn(
                            "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border pl-[11px] pr-2 text-left outline-none",
                            "focus-visible:border-accent",
                            selected
                              ? "border-line bg-pressed text-ink-primary"
                              : "border-transparent text-ink-body hover:bg-row-hover",
                          )}
                        >
                          <Icon
                            size={16}
                            absoluteStrokeWidth
                            strokeWidth={1}
                            aria-hidden="true"
                            className={selected ? "text-ink-primary" : "text-ink-soft"}
                          />
                          <span className="truncate">{entry.title}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </nav>

              <div className="dialog-body flex min-w-0 flex-1 flex-col">
                <SettingsPage {...pageProps("general")}>
                  <SettingsBox title="Autosave">
                    <CheckRow label="Autosave to file" placement="box">
                      <Checkbox name="autosaveEnabled" defaultChecked={initial.autosaveEnabled} />
                    </CheckRow>
                    <FormRow label="Autosave interval (seconds)">
                      <NumberInput
                        name="autosaveIntervalSeconds"
                        value={initial.autosaveIntervalSeconds}
                        min={5}
                        max={3600}
                      />
                    </FormRow>
                  </SettingsBox>
                  <SettingsBox title="Recent files">
                    <FormRow label="Recent files shown">
                      <NumberInput
                        name="recentFilesVisibleCount"
                        value={initial.recentFilesVisibleCount}
                        min={1}
                        max={100_000}
                      />
                    </FormRow>
                    <FormRow label="Recent history kept">
                      <NumberInput
                        name="recentFilesMaxRetained"
                        value={initial.recentFilesMaxRetained}
                        min={10}
                        max={100_000}
                      />
                    </FormRow>
                  </SettingsBox>
                  {isElectron() && window.mdEasy?.platform === "win32" && (
                    <SettingsBox title="System integration">
                      <ButtonRow
                        label="Set as default…"
                        onClick={() => {
                          void openDefaultAppsSettings().catch((error) => {
                            console.error("md-easy: could not open default-app settings", error);
                          });
                        }}
                      >
                        Set md-easy as the default app for .md files.
                      </ButtonRow>
                    </SettingsBox>
                  )}
                </SettingsPage>

                <SettingsPage {...pageProps("appearance")}>
                  <SettingsBox title="Application">
                    <ThemeCardGroup label="UI theme">
                      {UI_THEMES.map((choice) => (
                        <ThemeCard
                          key={choice.value}
                          name="theme"
                          {...choice}
                          checked={theme === choice.value}
                          onSelect={() => setTheme(choice.value)}
                        >
                          <UiThemePreview
                            theme={choice.value}
                            documentTheme={documentTheme}
                            accentFor={accentFor}
                          />
                        </ThemeCard>
                      ))}
                    </ThemeCardGroup>
                    <FormRow label="Accent color" asLabel={false} className="mt-1">
                      <AccentColorFieldView
                        value={accentFor(scheme)}
                        defaultColor={UI_PALETTES[scheme].accent}
                        disabled={useSystemAccent}
                        onCommit={(color) => {
                          setAccentColor(color);
                          setChosenAccentMode("custom");
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={useSystemAccent}
                        className={cn("dialog-btn", dialogButtonClassName)}
                        onClick={() => setChosenAccentMode("default")}
                      >
                        Reset
                      </Button>
                    </FormRow>
                    <CheckRow label="Use the system accent color">
                      <Checkbox
                        checked={useSystemAccent}
                        onChange={(event) =>
                          setAccentMode(event.currentTarget.checked ? "system" : chosenAccentMode.current)
                        }
                      />
                    </CheckRow>
                    <input type="hidden" name="accentMode" value={accentMode} />
                  </SettingsBox>
                  <SettingsBox title="Document">
                    <ThemeCardGroup label="Document theme">
                      {DOCUMENT_THEMES.map((choice) => (
                        <ThemeCard
                          key={choice.value}
                          name="editorTheme"
                          {...choice}
                          checked={documentTheme === choice.value}
                          onSelect={() => setDocumentTheme(choice.value)}
                        >
                          <DocumentThemePreview theme={choice.value} />
                        </ThemeCard>
                      ))}
                    </ThemeCardGroup>
                    <FormRow label="Text size (%)" className="mt-1">
                      <NumberInput
                        name="editorFontScalePct"
                        value={Math.round(initial.editorFontScale * 100)}
                        min={60}
                        max={250}
                      />
                    </FormRow>
                    <FormRow label="Page width">
                      <ChoiceSelect
                        name="editorWidthMode"
                        options={[
                          ["fill", "Fill the window"],
                          ["fixed", "Fixed"],
                        ]}
                        value={initial.editorWidthMode}
                      />
                    </FormRow>
                    <FormRow label="Fixed width (px)">
                      <NumberInput name="editorWidthPx" value={initial.editorWidthPx} min={320} max={2000} />
                    </FormRow>
                    <FormRow label="Body font">
                      <Input
                        name="fontFamily"
                        type="text"
                        defaultValue={initial.fontFamily}
                        className="w-[220px] min-w-0"
                      />
                    </FormRow>
                  </SettingsBox>
                </SettingsPage>

                <SettingsPage {...pageProps("editor")}>
                  <SettingsBox>
                    <FormRow label="Default view">
                      <ChoiceSelect
                        name="defaultView"
                        options={[
                          ["document", "Document"],
                          ["split", "Split"],
                          ["markdown", "Markdown"],
                        ]}
                        value={layoutFromDefaultView(initial)}
                      />
                    </FormRow>
                    <FormRow label="Link display">
                      <ChoiceSelect
                        name="linkDisplay"
                        options={[
                          ["text-and-url", "Text and URL"],
                          ["text-only", "Text only"],
                        ]}
                        value={initial.linkDisplay}
                      />
                    </FormRow>
                    <FormRow label="Tabs that keep undo history">
                      <NumberInput
                        name="maxRetainedTabEditors"
                        value={initial.maxRetainedTabEditors}
                        min={1}
                        max={20}
                      />
                    </FormRow>
                    <CheckRow label="Spell check">
                      <Checkbox name="spellCheckEnabled" defaultChecked={initial.spellCheckEnabled} />
                    </CheckRow>
                    <CheckRow label="Show frontmatter table">
                      <Checkbox
                        name="showFrontmatterPanel"
                        defaultChecked={initial.showFrontmatterPanel}
                      />
                    </CheckRow>
                    <CheckRow label="Collapse base64 in Markdown view">
                      <Checkbox
                        name="collapseBase64InRawView"
                        defaultChecked={initial.collapseBase64InRawView}
                      />
                    </CheckRow>
                  </SettingsBox>
                </SettingsPage>

                <SettingsPage {...pageProps("images")}>
                  <SettingsBox>
                    <CheckRow label="Embed images as base64" placement="box">
                      <Checkbox
                        name="embedImagesAsBase64"
                        defaultChecked={initial.embedImagesAsBase64}
                      />
                    </CheckRow>
                    <FormRow label="Max embed size (KB)">
                      <NumberInput
                        name="maxEmbedSizeKB"
                        value={initial.maxEmbedSizeKB}
                        min={0}
                        max={1_000_000}
                      />
                    </FormRow>
                    <FormRow label="Attachments folder">
                      <Input
                        name="attachmentsFolderName"
                        type="text"
                        defaultValue={initial.attachmentsFolderName}
                        className="w-[220px] min-w-0"
                      />
                    </FormRow>
                    <Hint>Images that are not embedded are saved here, next to the file.</Hint>
                  </SettingsBox>
                </SettingsPage>

                <SettingsPage {...pageProps("markdown")}>
                  <SettingsBox>
                    <FormRow label="Bullet">
                      <ChoiceSelect
                        name="mdBulletChar"
                        options={[
                          ["-", "-"],
                          ["*", "*"],
                          ["+", "+"],
                        ]}
                        value={initial.mdBulletChar}
                      />
                    </FormRow>
                    <FormRow label="Italic">
                      <ChoiceSelect
                        name="mdEmphasisChar"
                        options={[
                          ["*", "*italic*"],
                          ["_", "_italic_"],
                        ]}
                        value={initial.mdEmphasisChar}
                      />
                    </FormRow>
                    <FormRow label="Bold">
                      <ChoiceSelect
                        name="mdStrongChar"
                        options={[
                          ["**", "**bold**"],
                          ["__", "__bold__"],
                        ]}
                        value={initial.mdStrongChar}
                      />
                    </FormRow>
                    <FormRow label="Heading style">
                      <ChoiceSelect
                        name="mdHeadingStyle"
                        options={[
                          ["atx", "# Heading"],
                          ["setext", "Underlined"],
                        ]}
                        value={initial.mdHeadingStyle}
                      />
                    </FormRow>
                    <CheckRow label="Hard wrap">
                      <Checkbox name="hardWrapOn" defaultChecked={initial.mdHardWrap !== false} />
                    </CheckRow>
                    <FormRow label="Wrap column">
                      <NumberInput
                        name="hardWrapCol"
                        value={typeof initial.mdHardWrap === "number" ? initial.mdHardWrap : 80}
                        min={20}
                        max={400}
                      />
                    </FormRow>
                    <Hint placement="box">
                      md-easy writes Markdown in this style when you edit in the Document view.
                    </Hint>
                  </SettingsBox>
                </SettingsPage>

                <SettingsPage {...pageProps("shortcuts")} plain>
                  {KEYBOARD_SHORTCUTS.map(({ action, keys }) => (
                    <div
                      key={action}
                      className="flex items-center justify-between gap-4 border-b border-separator py-[5px]"
                    >
                      <span className="font-semibold text-ink-primary">{action}</span>
                      <span className="whitespace-nowrap text-ink">{keys}</span>
                    </div>
                  ))}
                  <p className="m-0 mt-2.5 text-ink-soft">
                    Formatting and link shortcuts work in the Document view.
                  </p>
                </SettingsPage>

                {isElectron() && (
                  <SettingsPage {...pageProps("updates")}>
                    <SettingsBox title="Updates">
                      <p className="settings-status col-span-full m-0">
                        Current version: {__APP_VERSION__}
                      </p>
                      <ButtonRow
                        label="Check for updates"
                        className="mt-1"
                        onClick={() => {
                          setUpdateStatus("Checking…");
                          void checkForUpdates().then(setUpdateStatus);
                        }}
                      >
                        {updateStatus}
                      </ButtonRow>
                    </SettingsBox>
                  </SettingsPage>
                )}

                <SettingsPage {...pageProps("about")} plain>
                  <div className="flex items-center gap-3.5">
                    <DocumentArtwork size={48} />
                    <div className="flex flex-col">
                      <span className="text-[18px] font-semibold leading-6 text-ink-primary">md-easy</span>
                      <span className="select-text text-ink-soft">Version {__APP_VERSION__}</span>
                    </div>
                  </div>
                  <div className="my-2.5 h-px bg-separator" />
                  <p className="m-0">md-easy is free software under the MIT License.</p>
                </SettingsPage>
              </div>
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

/** A push button with its status or explanation in ink-soft beside it. */
function ButtonRow({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("dialog-row col-span-full flex items-center gap-2.5", className)}>
      <Button
        type="button"
        variant="outline"
        className={cn("dialog-btn", dialogButtonClassName)}
        onClick={onClick}
      >
        {label}
      </Button>
      <span className="settings-status min-w-0 text-ink-soft">{children}</span>
    </div>
  );
}

/** A native select at its natural width, with readable labels for stored values. */
function ChoiceSelect<T extends string>({
  name,
  options,
  value,
}: {
  name: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
}) {
  return (
    <Select name={name} defaultValue={value} className="min-w-0">
      {options.map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </Select>
  );
}

/**
 * A typed number field without stepper buttons, sized to its range as Mervin
 * sizes its number fields.
 */
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
  return (
    <Input
      name={name}
      type="number"
      defaultValue={value}
      min={min}
      max={max}
      style={{ width: `calc(${String(max).length}ch + 26px)` }}
      className="min-w-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

function numVal(input: HTMLInputElement, fallback: number): number {
  if (input.value.trim() === "") return fallback;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  const min = input.min !== "" ? Number(input.min) : -Infinity;
  const max = input.max !== "" ? Number(input.max) : Infinity;
  return Math.min(Math.max(value, min), max);
}
