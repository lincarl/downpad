// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fakeCrepe = vi.hoisted(() => ({
  createPromise: Promise.resolve() as Promise<void>,
  destroyPromise: Promise.resolve() as Promise<void>,
  createCalls: 0,
  destroyCalls: 0,
  markdownUpdated: null as (() => void) | null,
}));

vi.mock("@milkdown/crepe", () => ({
  Crepe: class {
    static Feature = { CodeMirror: "code-mirror", ImageBlock: "image-block" };

    editor = {
      config: (configure: (ctx: { get(): object; set(): void; update(): void }) => void) => {
        configure({ get: () => ({}), set: () => {}, update: () => {} });
      },
      use: () => {},
      action: () => undefined,
    };

    on(register: (listener: { markdownUpdated(cb: () => void): void }) => void): void {
      register({
        markdownUpdated: (cb) => {
          fakeCrepe.markdownUpdated = cb;
        },
      });
    }

    create(): Promise<void> {
      fakeCrepe.createCalls += 1;
      return fakeCrepe.createPromise;
    }

    destroy(): Promise<void> {
      fakeCrepe.destroyCalls += 1;
      return fakeCrepe.destroyPromise;
    }

    getMarkdown(): string {
      return "settled markdown";
    }
  },
}));

import { WysiwygEditor } from "./WysiwygEditor";

beforeEach(() => {
  vi.useFakeTimers();
  fakeCrepe.createPromise = Promise.resolve();
  fakeCrepe.destroyPromise = Promise.resolve();
  fakeCrepe.createCalls = 0;
  fakeCrepe.destroyCalls = 0;
  fakeCrepe.markdownUpdated = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WysiwygEditor lifecycle", () => {
  it("shares terminal cleanup across destroy calls made during creation", async () => {
    const create = deferred();
    const destroy = deferred();
    fakeCrepe.createPromise = create.promise;
    fakeCrepe.destroyPromise = destroy.promise;
    const onChange = vi.fn();
    const editor = new WysiwygEditor();

    const mounting = editor.mount(
      document.createElement("div"),
      "original markdown",
      { onChange },
      serializerStyleFromSettings(DEFAULT_SETTINGS),
      {
        getSettings: () => DEFAULT_SETTINGS,
        getFilePath: () => null,
        requestSave: async () => false,
      },
    );
    expect(fakeCrepe.createCalls).toBe(1);

    const firstDestroy = editor.destroy();
    const secondDestroy = editor.destroy();
    expect(secondDestroy).toBe(firstDestroy);
    expect(fakeCrepe.destroyCalls).toBe(0);

    create.resolve();
    await mounting;
    await Promise.resolve();
    expect(fakeCrepe.destroyCalls).toBe(1);

    // The mount's zero-delay activation must not survive destruction and allow a
    // delayed Milkdown update to publish into a dead host.
    await vi.runAllTimersAsync();
    fakeCrepe.markdownUpdated?.();
    expect(onChange).not.toHaveBeenCalled();

    destroy.resolve();
    await firstDestroy;
    expect(fakeCrepe.destroyCalls).toBe(1);
  });
});
