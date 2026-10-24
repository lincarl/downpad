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
  private settingsUnlisten: (() => void) | null = null;
  private themeDispose: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly onWysiwygConfigChange: () => void,
  ) {}

  async init(): Promise<void> {
    if (this.disposed) return;
    if (isElectron()) {
      try {
        const settings = await loadSettings();
        if (this.disposed) return;
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

  /** Apply settings arriving from the watcher (hand edits to settings.toml). */
  private applyIncoming(settings: Settings): void {
    const before = wysiwygConfigSignature(this.store.get().settings);
    this.store.set({ settings });
    this.applySideEffects();
    if (wysiwygConfigSignature(settings) !== before) this.onWysiwygConfigChange();
  }

  /** Persist settings edited via the in-app dialog. Applies immediately even if
   *  the disk write fails (e.g. running outside Electron). Disk writes are serialized
   *  (in call order) via writeChain: on first run the welcome flag and the
   *  default-handler flag are saved from two separate fire-and-forget calls, and
   *  without ordering the second's write could land before the first's and be
   *  overwritten — silently dropping a flag (e.g. re-prompting for the default
   *  handler forever). Each save writes the full settings captured at call time;
   *  the synchronous store.set above keeps later callers' snapshots current. */
  async save(next: Settings): Promise<void> {
    if (this.disposed) return;
    const before = wysiwygConfigSignature(this.store.get().settings);
    this.store.set({ settings: next });
    this.applySideEffects();
    if (wysiwygConfigSignature(next) !== before) this.onWysiwygConfigChange();
    if (isElectron()) {
      this.writeChain = this.writeChain.then(() =>
        saveSettings(next).catch((err) => {
          console.error("Downpad: failed to save settings", err);
        }),
      );
      await this.writeChain;
    }
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
