import { desktopBridge } from "../ipc/bridge";
import { differingRuns } from "./differingRuns";

/** A prose word and its UTF-16 positions in the editor's document. */
export interface SpellingWord {
  word: string;
  from: number;
  to: number;
  /** Disjoint text spans when Markdown formatting occurs inside a word. */
  parts?: { from: number; to: number }[];
}

/** An immutable editor model, collected independently of the visible DOM. */
export interface SpellingSnapshot {
  token: object;
  words(): Promise<SpellingWord[]>;
}

/** Model operations needed by the shared spelling controller. */
export interface SpellingAdapter {
  root: HTMLElement;
  snapshot(): SpellingSnapshot;
  paint(words: SpellingWord[]): void;
  positionAt(x: number, y: number): number | null;
  replace(word: SpellingWord, replacement: string): void;
}

/** Corrections bound to the clicked word and the document that contained it. */
export interface EditorSpellingChoices {
  word: string;
  suggestions: string[];
  replace(suggestion: string): Promise<void>;
  add(): Promise<void>;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const controllers = new WeakMap<HTMLElement, SpellingController>();
const live = new Set<SpellingController>();
const PAUSE_MS = 300;
const BATCH_SIZE = 256;

/** Yield between parser and dictionary batches so large files stay editable. */
export function yieldSpelling(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Segment prose with Unicode boundaries, excluding URLs, emails and numbers. */
export function proseWords(text: string, offset = 0): SpellingWord[] {
  const excluded = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu)];
  const words: SpellingWord[] = [];
  let skip = 0;
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike || part.segment.length > 128 || !/\p{L}/u.test(part.segment)) continue;
    while (excluded[skip] && excluded[skip].index + excluded[skip][0].length <= part.index) skip++;
    if (excluded[skip] && excluded[skip].index < part.index + part.segment.length) continue;
    words.push({ word: part.segment, from: offset + part.index, to: offset + part.index + part.segment.length });
  }
  return words;
}

/** Change only letters, preserving Markdown markers and rich-text mark runs. */
export function spellingEdits(word: SpellingWord, replacement: string): { from: number; to: number; insert: string }[] {
  const parts = word.parts ?? [{ from: word.from, to: word.to }];
  const edits: { from: number; to: number; insert: string }[] = [];
  for (const run of differingRuns(word.word.length, replacement.length, (a, b) => word.word[a] === replacement[b])) {
    let offset = 0;
    let inserted = false;
    for (const part of parts) {
      const length = part.to - part.from;
      const from = Math.max(run.fromA, offset);
      const to = Math.min(run.toA, offset + length);
      if (from < to || (!inserted && run.fromA === run.toA && from === to && from >= offset && from <= offset + length)) {
        edits.push({ from: part.from + from - offset, to: part.from + to - offset, insert: inserted ? "" : replacement.slice(run.fromB, run.toB) });
        inserted = true;
      }
      offset += length;
    }
  }
  return edits;
}

/** Whether this renderer has the installed app's explicit native checker. */
export function managedSpellingAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.downpadDesktop?.checkSpelling === "function";
}

/** Find the registered editor for text, its editable root or a pane wrapper. */
function controllerAt(element: HTMLElement): SpellingController | undefined {
  const root = element.closest<HTMLElement>("[data-managed-spelling]")
    ?? element.querySelector<HTMLElement>("[data-managed-spelling]");
  return root ? controllers.get(root) : undefined;
}

/** Whether an element belongs to an editor with app-owned spelling. */
export function hasEditorSpelling(element: HTMLElement): boolean {
  return !!controllerAt(element);
}

/** Check the clicked word immediately, even before the typing pause expires. */
export function spellingAt(element: HTMLElement, x: number, y: number): Promise<EditorSpellingChoices | null> {
  const pointed = element.ownerDocument.elementFromPoint?.(x, y);
  const target = pointed instanceof HTMLElement && element.contains(pointed) ? pointed : element;
  return controllerAt(target)?.at(x, y) ?? Promise.resolve(null);
}

/** Debounce model checks, cache unchanged words, and discard stale native replies. */
export class SpellingController {
  private enabled = false;
  private disposed = false;
  private composing = false;
  private clearAfterComposition = false;
  private generation = 0;
  private modelRevision = 0;
  private dictionaryRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly cache = new Map<string, boolean>();
  private readonly unsubscribe: () => void;
  private readonly compositionStart = (): void => {
    this.composing = true;
    this.cancel();
    this.generation++;
  };
  private readonly compositionEnd = (): void => {
    this.composing = false;
    if (this.clearAfterComposition) {
      this.clearAfterComposition = false;
      this.adapter.paint([]);
    }
    this.changed();
  };

  constructor(private readonly adapter: SpellingAdapter) {
    adapter.root.dataset.managedSpelling = "true";
    controllers.set(adapter.root, this);
    live.add(this);
    adapter.root.addEventListener("compositionstart", this.compositionStart);
    adapter.root.addEventListener("compositionend", this.compositionEnd);
    this.unsubscribe = desktopBridge().listen("spelling-changed", () => this.invalidate());
  }

  /** Enable checking or remove marks and cached results when disabled. */
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate();
  }

  /** Schedule checks after a model change, including a changed unfinished word. */
  changed(): void {
    this.generation++;
    this.modelRevision++;
    this.cancel();
    if (!this.enabled || this.disposed || this.composing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan(false).catch(() => {});
    }, PAUSE_MS);
  }

  /** Discard dictionary-dependent results and recheck the current model. */
  private invalidate(): void {
    this.dictionaryRevision++;
    this.cache.clear();
    if (this.composing) this.clearAfterComposition = true;
    else if (!this.disposed) this.adapter.paint([]);
    this.changed();
  }

  /** Scan every prose word, bypassing the cache for an explicit full check. */
  async scan(force = true): Promise<number> {
    if (!this.enabled || this.disposed) throw new Error("Spell check is turned off.");
    if (this.composing) throw new Error("Finish composing the current word before checking spelling.");
    this.cancel();
    const generation = ++this.generation;
    const snapshot = this.adapter.snapshot();
    const current = (): void => {
      if (this.disposed || !this.enabled || this.composing || generation !== this.generation
        || this.adapter.snapshot().token !== snapshot.token) {
        throw new Error("The document changed while spelling was checked. Check again.");
      }
    };
    const words = await snapshot.words();
    current();
    const unique = [...new Set(words.map(({ word }) => word))];
    const pending = unique.filter((word) => force || !this.cache.has(word));
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);
      const misspelled = new Set(await desktopBridge().checkSpelling(batch));
      current();
      for (const word of batch) this.cache.set(word, misspelled.has(word));
      if (start + BATCH_SIZE < pending.length) {
        await yieldSpelling();
        current();
      }
    }
    const present = new Set(unique);
    for (const word of this.cache.keys()) if (!present.has(word)) this.cache.delete(word);
    const misspelled = words.filter(({ word }) => this.cache.get(word));
    this.adapter.paint(misspelled);
    return misspelled.length;
  }

  /** Obtain corrections without selecting or changing the clicked word. */
  async at(x: number, y: number): Promise<EditorSpellingChoices | null> {
    if (this.disposed || !this.enabled || this.composing) return null;
    const pos = this.adapter.positionAt(x, y);
    if (pos === null) return null;
    const snapshot = this.adapter.snapshot();
    const dictionaryRevision = this.dictionaryRevision;
    const modelRevision = this.modelRevision;
    const current = (): boolean => !this.disposed && this.enabled && !this.composing
      && this.dictionaryRevision === dictionaryRevision && this.modelRevision === modelRevision
      && this.adapter.snapshot().token === snapshot.token;
    const words = await snapshot.words();
    const word = words.find((item) => item.from <= pos && item.to > pos)
      ?? words.find((item) => item.to === pos);
    if (!word || !current()) return null;
    let misspelled = this.cache.get(word.word);
    if (misspelled === undefined) {
      misspelled = (await desktopBridge().checkSpelling([word.word])).includes(word.word);
      if (!current()) return null;
      this.cache.set(word.word, misspelled);
    }
    if (!misspelled) return null;
    const suggestions = await desktopBridge().spellingSuggestions(word.word);
    if (!current()) return null;
    const validate = (): void => {
      if (!current()) throw new Error("The word changed. Open its spelling menu again.");
    };
    return {
      word: word.word,
      suggestions,
      replace: async (suggestion) => {
        validate();
        if (!suggestions.includes(suggestion)) throw new Error("Choose one of the spelling suggestions.");
        this.adapter.replace(word, suggestion);
      },
      add: async () => {
        validate();
        await desktopBridge().invoke("add_dictionary_word", { word: word.word });
        for (const controller of live) controller.invalidate();
      },
    };
  }

  /** Detach all listeners and prevent delayed replies from touching an editor. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cancel();
    this.unsubscribe();
    live.delete(this);
    controllers.delete(this.adapter.root);
    delete this.adapter.root.dataset.managedSpelling;
    this.adapter.root.removeEventListener("compositionstart", this.compositionStart);
    this.adapter.root.removeEventListener("compositionend", this.compositionEnd);
    this.cache.clear();
  }

  /** Cancel a scheduled automatic scan. */
  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
