// @vitest-environment jsdom

import { StrictMode, useCallback, useRef, useState } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Store } from "@/state/store";

const ownership = vi.hoisted(() => ({
  hosts: [] as Array<{
    root: HTMLElement;
    disposed: boolean;
    disposeCalls: number;
  }>,
  runtimes: [] as Array<{
    editorHost: unknown;
    disposeCalls: number;
  }>,
}));

vi.mock("./EditorHost", () => ({
  EditorHost: class {
    disposed = false;
    disposeCalls = 0;

    constructor(public readonly root: HTMLElement) {
      ownership.hosts.push(this);
    }

    dispose(): Promise<void> {
      this.disposeCalls += 1;
      this.disposed = true;
      return Promise.resolve();
    }
  },
}));

vi.mock("@/app/AppRuntime", () => ({
  AppRuntime: class {
    disposeCalls = 0;

    constructor(
      _store: unknown,
      public readonly editorHost: unknown,
    ) {
      ownership.runtimes.push(this);
    }

    dispose(): void {
      this.disposeCalls += 1;
    }
  },
}));

import type { EditorHost } from "./EditorHost";
import { EditorIsland } from "./EditorIsland";
import { useOwnedAppRuntime } from "@/app/useAppRuntime";

function StrictOwnershipHarness() {
  const store = useRef({} as Store).current;
  const [editorHost, setEditorHost] = useState<EditorHost | null>(null);
  const editorArea = useRef<HTMLDivElement>(null);
  const recentHost = useRef<HTMLDivElement>(null);
  const findHost = useRef<HTMLDivElement>(null);
  const onHostReady = useCallback((host: EditorHost) => setEditorHost(host), []);
  const onHostDisposed = useCallback((host: EditorHost) => {
    setEditorHost((current) => (current === host ? null : current));
  }, []);
  const setRecentSummary = useCallback(() => {}, []);

  useOwnedAppRuntime(
    store,
    editorHost,
    { editorArea, recentHost, findHost },
    setRecentSummary,
  );

  return (
    <div ref={editorArea}>
      <EditorIsland
        store={store}
        onHostReady={onHostReady}
        onHostDisposed={onHostDisposed}
      />
      <div ref={recentHost} />
      <div ref={findHost} />
    </div>
  );
}

describe("EditorIsland Strict Mode ownership", () => {
  it("injects only the live replay host and terminally disposes each owner once", async () => {
    ownership.hosts.length = 0;
    ownership.runtimes.length = 0;

    const view = render(
      <StrictMode>
        <StrictOwnershipHarness />
      </StrictMode>,
    );

    await waitFor(() => expect(ownership.runtimes).toHaveLength(1));

    expect(ownership.hosts).toHaveLength(2);
    const [replayedHost, liveHost] = ownership.hosts;
    expect(replayedHost.root).toBe(liveHost.root);
    expect(replayedHost.disposeCalls).toBe(1);
    expect(replayedHost.disposed).toBe(true);
    expect(liveHost.disposeCalls).toBe(0);
    expect(liveHost.disposed).toBe(false);
    expect(ownership.runtimes[0].editorHost).toBe(liveHost);

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(liveHost.disposeCalls).toBe(1);
    expect(liveHost.disposed).toBe(true);
    expect(ownership.runtimes[0].disposeCalls).toBe(1);
  });
});
