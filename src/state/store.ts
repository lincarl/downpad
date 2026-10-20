// The single canonical store. A minimal observable — no framework.
// See docs/design.md §4. `state.doc.markdown` is the single source of truth.

import type { AppState, DocumentState, DocumentViewFailure } from "./types";
import { blankDoc } from "./types";

type Listener = (state: AppState, prev: AppState) => void;
type Selector<T> = (state: AppState) => T;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  get(): AppState {
    return this.state;
  }

  /**
   * Apply a shallow patch to the top-level state (or a function producing one),
   * then notify listeners. Nested objects in the patch replace wholesale, so
   * callers pass fresh nested objects (see `patchDoc` etc. for convenience).
   */
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const prev = this.state;
    const delta = typeof patch === "function" ? patch(prev) : patch;
    this.state = { ...prev, ...delta };
    for (const l of this.listeners) l(this.state, prev);
  }

  /**
   * Patch the active document slice. The patched object is shared by `doc` and
   * the active tab entry, so both stay identical (spec §5.19). A no-op for `doc`
   * when no tab is open (there is nothing editable to patch).
   */
  patchDoc(patch: Partial<DocumentState>): void {
    this.set((s) => {
      const doc = { ...s.doc, ...patch };
      if (s.activeTabId === null) return { doc };
      const tabs = s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, doc } : t));
      return { doc, tabs };
    });
  }

  /**
   * Patch a specific tab's document slice by id (spec §5.19). The mirror into
   * `AppState.doc` happens only when that tab is the active one — so a background
   * editor pane (a tab the user has open but isn't viewing) can flush its own
   * in-progress edits into its own tab without disturbing the active document.
   * No-op for an unknown id.
   */
  patchDocById(tabId: string, patch: Partial<DocumentState>): void {
    this.set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const doc = { ...tab.doc, ...patch };
      const tabs = s.tabs.map((t) => (t.id === tabId ? { ...t, doc } : t));
      return tabId === s.activeTabId ? { doc, tabs } : { tabs };
    });
  }

  // ── Tabs (spec §5.19) ──────────────────────────────────────────────────────

  /** Open a document in a new tab and make it active. Returns the new tab id. */
  addTab(doc: DocumentState): string {
    const id = crypto.randomUUID();
    this.set((s) => ({ doc, tabs: [...s.tabs, { id, doc }], activeTabId: id }));
    return id;
  }

  /** Replace the active tab's document wholesale (open/new into the current tab). */
  replaceActiveDoc(doc: DocumentState): void {
    this.set((s) => {
      if (s.activeTabId === null) {
        const id = crypto.randomUUID();
        return { doc, tabs: [{ id, doc }], activeTabId: id };
      }
      const tabs = s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, doc } : t));
      return { doc, tabs };
    });
  }

  /** Make `id` the active tab, mirroring its document into `doc`. No-op if unknown. */
  activateTab(id: string): void {
    this.set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || id === s.activeTabId) return {};
      return { doc: tab.doc, activeTabId: id };
    });
  }

  /** Record whether files dropped on a tab's document, or images pasted into
   *  it, are still on their way into it (§5.4, §5.5). No-op for an unknown
   *  id. */
  setFilesPending(tabId: string, pending: boolean): void {
    this.set((s) => {
      if (!s.tabs.some((t) => t.id === tabId)) return {};
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, filesPending: pending } : t)) };
    });
  }

  /**
   * Remove a tab. If it was active, the neighbour to the right (or left) becomes
   * active; when none remain, `doc` falls back to a blank buffer and activeTabId
   * is null. Returns the id now active (or null).
   */
  closeTab(id: string): string | null {
    let nextActive: string | null = null;
    this.set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) {
        nextActive = s.activeTabId;
        return {};
      }
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (s.activeTabId !== id) {
        nextActive = s.activeTabId;
        return { tabs };
      }
      // Closing the active tab: prefer the right neighbour, else the left.
      const neighbour = tabs[idx] ?? tabs[idx - 1] ?? null;
      nextActive = neighbour?.id ?? null;
      return { tabs, activeTabId: nextActive, doc: neighbour?.doc ?? blankDoc() };
    });
    return nextActive;
  }

  /** Record why a tab's Document view could not be built, or clear it with
   *  null. No-op for an unknown id, or to clear a tab that has no failure. */
  setDocumentViewFailure(tabId: string, failure: DocumentViewFailure | null): void {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab || (!tab.documentViewFailure && !failure)) return;
    this.set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, documentViewFailure: failure ?? undefined } : t)),
    }));
  }

  /** Patch the find slice. */
  patchFind(patch: Partial<AppState["find"]>): void {
    this.set((s) => ({ find: { ...s.find, ...patch } }));
  }

  /** Subscribe to every change. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to a derived slice; the listener only fires when the selected
   * value changes (by `Object.is`). Useful for view bindings that should not
   * re-run on unrelated state changes.
   */
  select<T>(selector: Selector<T>, listener: (value: T, prev: T) => void): () => void {
    let current = selector(this.state);
    return this.subscribe((state) => {
      const next = selector(state);
      if (!Object.is(next, current)) {
        const prev = current;
        current = next;
        listener(next, prev);
      }
    });
  }
}
