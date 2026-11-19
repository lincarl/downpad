// Owns settings load/apply/save and the live-reload subscription (spec §5.9).
// Applies visual side-effects (editor width, body font, theme) and notifies
// when serialization style changes so the WYSIWYG view can re-mount (§5.16).

import type { Store } from "../state/store";
import type { Settings } from "../state/types";
import { loadSettings, saveSettings, getSystemAccentColor } from "../ipc/commands";
import { onSettingsChanged } from "../ipc/events";
import { isElectron } from "../ipc/env";
import { applyTheme } from "../shell/theme";
import { DEFAULT_ACCENT, normalizeHex, readableForeground } from "../shell/accent";
import { changesFrom, heldChanges } from "./settingsChanges";

// Settings that change WYSIWYG output/rendering and so require a re-mount: the
// serializer style (§5.16), the link display mode (§5.6), and whether the
// frontmatter panel is shown (§5.17 — flips between an inline `---` block and
// the pinned raw-YAML box).
function wysiwygConfigSignature(s: Settings): string {
  return [
    s.mdBulletChar,
    s.mdEmphasisChar,
    s.mdStrongChar,
    s.mdHeadingStyle,
    String(s.mdHardWrap),
    s.linkDisplay,
    String(s.showFrontmatterPanel),
  ].join("|");
}

export class SettingsModel {
  /** Cached Windows accent: undefined = not fetched, null = unavailable. */
  private systemAccent: string | null | undefined;

  /** Serializes disk writes (see save()): each save chains after the previous so
   *  two near-simultaneous saves can't race and clobber each other on disk. */
  private writeChain: Promise<void> = Promise.resolve();
  /** The settings last read from settings.toml or written to it. */
  private onDisk: Settings;
  /** Changes whose write failed and that the app keeps, which the next write
   *  takes along. */
  private unwritten: Partial<Settings> = {};
  private settingsUnlisten: (() => void) | null = null;
  private themeDispose: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly onWysiwygConfigChange: () => void,
  ) {
    this.onDisk = store.get().settings;
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    if (isElectron()) {
      try {
        const settings = await loadSettings();
        if (this.disposed) return;
        this.onDisk = settings;
        this.store.set({ settings });
      } catch {
        // Keep defaults if the backend load fails.
      }
      if (this.disposed) return;
      void onSettingsChanged((settings) => {
        if (!this.disposed) this.applyIncoming(settings);
      }).then((unlisten) => {
        if (this.disposed) unlisten();
        else this.settingsUnlisten = unlisten;
      }).catch(() => {});
    }
    if (this.disposed) return;
    this.applySideEffects();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settingsUnlisten?.();
    this.settingsUnlisten = null;
    this.themeDispose?.();
    this.themeDispose = null;
  }

  /** Apply settings arriving from the watcher (hand edits to settings.toml).
   *  The file wins, also over changes whose write failed. */
  private applyIncoming(settings: Settings): void {
    this.onDisk = settings;
    this.unwritten = {};
    this.use(settings);
  }

  /** Make `settings` the app's settings and apply them to the page. */
  private use(settings: Settings): void {
    const before = wysiwygConfigSignature(this.store.get().settings);
    this.store.set({ settings });
    this.applySideEffects();
    if (wysiwygConfigSignature(settings) !== before) this.onWysiwygConfigChange();
  }

  /** Apply `next` at once and write it to settings.toml. Applies even if the
   *  disk write fails (e.g. running outside Electron). Disk writes are
   *  serialized (in call order) via writeChain: on first run the welcome flag
   *  and the default-handler flag are saved from two separate fire-and-forget
   *  calls, and without ordering the second's write could land before the
   *  first's and be overwritten, silently dropping a flag (e.g. re-prompting
   *  for the default handler forever).
   *
   *  Each write holds the settings last on disk, the kept changes of earlier
   *  writes that failed, and this save's own changes from the settings before
   *  it. So a later save, such as a text size change, never writes a change
   *  whose own write is still running or failed and was undone.
   *
   *  Resolves false when the write failed, such as for a settings.toml with
   *  broken syntax, and true otherwise. `undoIfUnwritten`, as the Settings
   *  dialog asks, which then says the change was not saved, puts back each
   *  changed setting the app still holds as this save set it. Otherwise the
   *  app keeps the change, and the next write takes it along. */
  async save(next: Settings, { undoIfUnwritten = false }: { undoIfUnwritten?: boolean } = {}): Promise<boolean> {
    if (this.disposed) return false;
    const changes = changesFrom(this.store.get().settings, next);
    this.use(next);
    if (!isElectron()) return true;
    let written = true;
    this.writeChain = this.writeChain.then(async () => {
      const target = { ...this.onDisk, ...this.unwritten, ...changes };
      try {
        await saveSettings(target);
        this.onDisk = target;
        this.unwritten = {};
      } catch (err) {
        console.error("Downpad: failed to save settings", err);
        written = false;
        // Before the next write starts, so that it sees the undo.
        if (undoIfUnwritten) this.undo(changes);
        else this.unwritten = { ...this.unwritten, ...changes };
      }
    });
    await this.writeChain;
    return written;
  }

  /** Give each setting in `changes` that the app still holds its value on
   *  disk, or the kept change of an earlier failed write. A setting changed
   *  since keeps its value. */
  private undo(changes: Partial<Settings>): void {
    if (this.disposed) return;
    const current = this.store.get().settings;
    const before = { ...this.onDisk, ...this.unwritten };
    const keys = heldChanges(current, changes);
    if (keys.length === 0) return;
    this.use({ ...current, ...Object.fromEntries(keys.map((key) => [key, before[key]])) });
  }

  private applySideEffects(): void {
    const s = this.store.get().settings;
    const root = document.documentElement;
    root.style.setProperty("--editor-width", `${s.editorWidthPx}px`);
    // Page width (spec §6.1): "fill" lets the column fill the window (CSS drops
    // the max-width, so it adapts on resize with no JS); "fixed" caps it at
    // --editor-width. Fall back to "fill" for settings files predating the field.
    root.setAttribute("data-width-mode", s.editorWidthMode === "fixed" ? "fixed" : "fill");
    // Keep a fallback stack: a bare family missing on this system (Segoe UI on
    // Linux) would otherwise fall back to the browser's serif default.
    root.style.setProperty("--editor-font", `${s.fontFamily}, system-ui, sans-serif`);
    // Document text size (spec §5.20): a multiplier applied to the editor's base
    // font size in both views. Fall back to 1 for settings files predating it.
    root.style.setProperty("--editor-font-scale", String(s.editorFontScale ?? 1));
    this.themeDispose?.();
    this.themeDispose = applyTheme(s.theme, s.editorTheme ?? "follow-ui");
    this.applyAccent(s);
  }

  /** Resolve and apply the accent color (spec §6.2): the theme's design accent,
   *  the operating system accent, or a custom color, plus a readable foreground. */
  private applyAccent(s: Settings): void {
    const root = document.documentElement;
    const set = (color: string): void => {
      root.style.setProperty("--accent", color);
      root.style.setProperty("--accent-fg", readableForeground(color));
    };
    // The theme tokens supply each scheme's design accent: Nord's frost blue in
    // dark and the Cool slate blue in light. Removing the inline values lets them
    // apply, so the default needs no color of its own here.
    const useThemeAccent = (): void => {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-fg");
    };
    const mode = s.accentMode ?? "default";
    if (mode === "custom") {
      set(normalizeHex(s.accentColor) ?? DEFAULT_ACCENT);
      return;
    }
    if (mode !== "system") {
      useThemeAccent();
      return;
    }
    // "system": use the cached OS accent if we have it, falling back to the
    // theme accent when the platform reports none. Resolve it once, then re-apply
    // with the current settings, since the user may have switched modes meanwhile.
    if (this.systemAccent !== undefined) {
      if (this.systemAccent) set(this.systemAccent);
      else useThemeAccent();
      return;
    }
    useThemeAccent();
    if (!isElectron()) {
      this.systemAccent = null;
      return;
    }
    void getSystemAccentColor()
      .then((c) => {
        this.systemAccent = normalizeHex(c) ?? null;
      })
      .catch(() => {
        this.systemAccent = null;
      })
      .finally(() => {
        if (!this.disposed) this.applySideEffects();
      });
  }
}
