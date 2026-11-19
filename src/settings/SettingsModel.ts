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
import { sameSettings, withRecentLimit, writtenValues } from "./settingsChanges";

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

/** A save whose write has not ended. */
interface PendingSave {
  changes: Partial<Settings>;
}

export class SettingsModel {
  /** Cached Windows accent: undefined = not fetched, null = unavailable. */
  private systemAccent: string | null | undefined;

  /** Serializes disk writes (see save()): each save chains after the previous so
   *  two near-simultaneous saves can't race and clobber each other on disk. It
   *  never rejects, so a failure cannot stop the writes after it. */
  private writeChain: Promise<void> = Promise.resolve();
  /** settings.toml as the app last learnt it, by loading it, from an edit of
   *  it, or from what a write returned for the settings it sent. */
  private file: Settings;
  /** Changes whose write failed and that the app keeps, which the next write
   *  takes along. */
  private kept: Partial<Settings> = {};
  /** Saves whose write has not ended, in the order they were made. */
  private readonly pending: PendingSave[] = [];
  private settingsUnlisten: (() => void) | null = null;
  private themeDispose: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly onWysiwygConfigChange: () => void,
  ) {
    this.file = store.get().settings;
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    if (isElectron()) {
      try {
        const settings = await loadSettings();
        if (this.disposed) return;
        this.file = settings;
        this.store.set({ settings: this.composed() });
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
   *  The file wins over changes whose write failed. Changes still being
   *  written stay, since their writes put them onto the file as it is then. */
  private applyIncoming(settings: Settings): void {
    this.file = settings;
    this.kept = {};
    this.use(this.composed());
  }

  /** The settings the app uses: the file's, the kept changes of failed
   *  writes, and the changes being written, in that order, with no more
   *  recent files shown than kept, as the file stores them. */
  private composed(): Settings {
    return withRecentLimit(Object.assign({}, this.file, this.kept, ...this.pending.map((save) => save.changes)));
  }

  /** Make `settings` the app's settings and apply them to the page. */
  private use(settings: Settings): void {
    const before = wysiwygConfigSignature(this.store.get().settings);
    this.store.set({ settings });
    this.applySideEffects();
    if (wysiwygConfigSignature(settings) !== before) this.onWysiwygConfigChange();
  }

  /** Apply `changes` at once, and write them to settings.toml. The main
   *  process puts them onto the file as it is when the write runs, so a hand
   *  edit made since the app read the file stays. Disk writes are serialized
   *  (in call order) via writeChain: on first run the welcome flag and the
   *  default-handler flag are saved from two separate fire-and-forget calls,
   *  and the second write must not start before the first ends.
   *
   *  Resolves with the settings the file holds after the write, or null when
   *  the write failed, such as for a settings.toml with broken syntax. Outside
   *  the desktop app there is no file, and it resolves with the settings in
   *  use. A failed save stays in use and the next write takes it along, unless
   *  `undoIfUnwritten` is set, as the Settings dialog asks, which then says
   *  the change was not saved. The app then stops using it, and each setting
   *  it changed shows what the file and the other changes give it. */
  async save(changes: Partial<Settings>, { undoIfUnwritten = false }: { undoIfUnwritten?: boolean } = {}): Promise<Settings | null> {
    if (this.disposed) return null;
    if (!isElectron()) {
      this.file = withRecentLimit({ ...this.file, ...changes });
      this.use(this.composed());
      return this.file;
    }
    const save: PendingSave = { changes };
    this.pending.push(save);
    this.use(this.composed());
    const run = this.writeChain.then(() => this.write(save, undoIfUnwritten));
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  /** Write `save`'s changes, with the kept changes of failed writes, and use
   *  the result. Resolves with the settings the file then holds, or null. */
  private async write(save: PendingSave, undoIfUnwritten: boolean): Promise<Settings | null> {
    const sent = { ...this.kept, ...save.changes };
    let written: Settings | null = null;
    try {
      written = await saveSettings(sent);
    } catch (err) {
      console.error("Downpad: failed to save settings", err);
    }
    this.pending.splice(this.pending.indexOf(save), 1);
    if (written) {
      // Only the settings this write sent. An edit of settings.toml that
      // arrived while it ran can be newer for the others, and an edit that
      // came before it arrives on its own.
      this.file = { ...this.file, ...writtenValues(sent, written) };
      this.kept = {};
    } else if (!undoIfUnwritten) {
      // The kept changes as they are now, as an edit of settings.toml may
      // have replaced them while this write ran.
      this.kept = { ...this.kept, ...save.changes };
    }
    // Most writes change nothing the app shows, and applying the same
    // settings again would, for one, ask the system for its accent again.
    const next = this.composed();
    if (!this.disposed && !sameSettings(next, this.store.get().settings)) this.use(next);
    return written;
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
