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
      remove: async () => {},
    };

    create(): Promise<void> {
      fakeCrepe.createCalls += 1;
      return fakeCrepe.createPromise;
    }

    destroy(): Promise<void> {
      fakeCrepe.destroyCalls += 1;
      return fakeCrepe.destroyPromise;
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
    const editor = new WysiwygEditor();

    const mounting = editor.mount(
      document.createElement("div"),
      "original markdown",
      { onChange: () => {} },
      serializerStyleFromSettings(DEFAULT_SETTINGS),
      {
        getSettings: () => DEFAULT_SETTINGS,
        getFilePath: () => null,
        requestSave: async () => false,
      },
    );
    // Creation starts once Crepe's indent plugin is removed.
    await vi.waitFor(() => expect(fakeCrepe.createCalls).toBe(1));

    const firstDestroy = editor.destroy();
    const secondDestroy = editor.destroy();
    expect(secondDestroy).toBe(firstDestroy);
    expect(fakeCrepe.destroyCalls).toBe(0);

    create.resolve();
    await mounting;
    await Promise.resolve();
    expect(fakeCrepe.destroyCalls).toBe(1);

    // Change reports need Crepe's plugins, which this stand-in never runs. The
    // source tests check that destroy cancels a pending report.
    destroy.resolve();
    await firstDestroy;
    expect(fakeCrepe.destroyCalls).toBe(1);
  });
});
