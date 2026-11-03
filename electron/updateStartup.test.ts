import type { MessageBoxOptions } from "electron";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../src/ipc/contracts";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { StagedMsi } from "./updateInstall";
import type { StartState, UpdaterOptions } from "./updater";
import type { PackageKind } from "./updatePlan";

/** What the start finds and how the install steps answer. */
interface Scenario {
  kind: PackageKind | null;
  start: StartState;
  failures?: Partial<Record<"stageMsi" | "startMsiInstaller", Error>>;
  debCommand?: string[] | null;
  debResult?: "installed" | "cancelled";
}

const startup = vi.hoisted(() => ({
  /** Each observable step of one start, in order. */
  steps: [] as unknown[][],
  scenario: { kind: null, start: { pending: null, failure: null } } as Scenario,
  staged: { package: "/tmp/downpad-update-x1/Downpad-1.3.0-win-x64.msi", staging: "/tmp/downpad-update-x1" },
  resultFile: "/profile/updates/msi/install-result.txt",
  helperPid: 4321,
  updaterOptions: undefined as UpdaterOptions | undefined,
  updateInfo: { version: "1.2.0", selfUpdate: true, lastCheckMs: null, state: { status: "idle" } } as UpdateInfo,
  approveResult: true,
  approveFailure: undefined as Error | undefined,
  destroyed: false,
  senderEvent: {} as { sender?: unknown; senderFrame?: unknown },
  ipcListeners: new Map<string, (...args: unknown[]) => unknown>(),
  dialogAnswer: undefined as (() => Promise<{ response: number }>) | undefined,
}));

vi.mock("electron", () => {
  const window = {
    isDestroyed: () => startup.destroyed,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: () => {},
      mainFrame: { url: "" },
      setWindowOpenHandler: () => {},
      on: () => {},
      session: {
        on: () => {},
        removeListener: () => {},
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        availableSpellCheckerLanguages: ["en-US"],
        getSpellCheckerLanguages: () => ["en-US"],
        setSpellCheckerLanguages: () => {},
        setSpellCheckerEnabled: () => {},
      },
    },
    on: () => {},
    once: () => {},
    loadFile: async (file: string) => { window.webContents.mainFrame.url = pathToFileURL(file).href; },
  };
  startup.senderEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return {
    app: {
      isPackaged: true,
      setName: () => {},
      getPath: () => "dev-temp/update-startup",
      getVersion: () => "1.2.0",
      getPreferredSystemLanguages: () => ["en-US"],
      on: () => {},
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      quit: () => { startup.steps.push(["quit"]); },
      exit: (code: number) => { startup.steps.push(["exit", code]); },
      relaunch: (options: unknown) => { startup.steps.push(["relaunch", options]); },
    },
    BrowserWindow: class { constructor() { startup.steps.push(["window"]); return window; } },
    dialog: {
      showMessageBox: async (_window: unknown, options: MessageBoxOptions) => {
        startup.steps.push(["showMessageBox", options]);
        return startup.dialogAnswer ? startup.dialogAnswer() : { response: 0 };
      },
      showErrorBox: (title: string, detail: string) => { startup.steps.push(["showErrorBox", title, detail]); },
    },
    ipcMain: {
      handle: (channel: string) => { if (channel === "downpad:invoke") startup.steps.push(["registerIpc"]); },
      on: (channel: string, listener: (...args: unknown[]) => unknown) => { startup.ipcListeners.set(channel, listener); },
    },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    nativeTheme: {},
    net: {},
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    screen: {},
    session: { defaultSession: window.webContents.session },
    shell: {},
    systemPreferences: {},
  };
});

// The real start runs against a profile that never touches the disk.
vi.mock("./storage", () => ({
  adoptLegacyData: () => false,
  ConfigStore: class {
    directory = "dev-temp/update-startup";
    settingsPath = "dev-temp/update-startup/settings.toml";
    async initialize() {}
    async settings() { return { ...DEFAULT_SETTINGS }; }
  },
  RecentSearch: class {},
}));
vi.mock("./printing", () => ({ PrintService: class {} }));
vi.mock("./watchers", () => ({ watchPath: () => () => {} }));
vi.mock("./updater", () => ({
  Updater: class {
    constructor(options: UpdaterOptions) { startup.updaterOptions = options; }
    info() { return startup.updateInfo; }
    async approve() {
      startup.steps.push(["approve"]);
      if (startup.approveFailure) throw startup.approveFailure;
      return startup.approveResult;
    }
    async start() { return startup.scenario.start; }
    async handedToInstaller(version: string) { startup.steps.push(["handedToInstaller", version]); }
    installerResultFile() { return startup.resultFile; }
    async installerStarted(pid: number) { startup.steps.push(["installerStarted", pid]); }
    async dropPending(message?: string) { startup.steps.push(message === undefined ? ["dropPending"] : ["dropPending", message]); }
    async checkIfDue() { startup.steps.push(["checkIfDue"]); }
  },
}));
vi.mock("./updateInstall", () => ({
  installedPackageKind: async () => startup.scenario.kind,
  stageMsi: async (file: string, sha256: string) => {
    startup.steps.push(["stageMsi", file, sha256]);
    if (startup.scenario.failures?.stageMsi) throw startup.scenario.failures.stageMsi;
    return startup.staged;
  },
  startMsiInstaller: async (staged: StagedMsi, executable: string, result: string, argument: string | undefined,
    options: { onStarted?: (pid: number) => Promise<void> }) => {
    startup.steps.push(["startMsiInstaller", staged, executable, result, argument]);
    if (startup.scenario.failures?.startMsiInstaller) throw startup.scenario.failures.startMsiInstaller;
    await options.onStarted?.(startup.helperPid);
    return {};
  },
  discardStagedMsi: async (staged: StagedMsi) => { startup.steps.push(["discardStagedMsi", staged]); },
  replaceAppImage: async (file: string, sha256: string, target: string) => { startup.steps.push(["replaceAppImage", file, sha256, target]); },
  debInstallCommand: () => startup.scenario.debCommand ?? null,
  installDeb: async (file: string, sha256: string, command: readonly string[]) => {
    startup.steps.push(["installDeb", file, sha256, command]);
    return startup.scenario.debResult ?? "installed";
  },
}));

const SHA256 = "a".repeat(64);
const APPIMAGE = "/opt/Downpad.AppImage";
const LAUNCH_FILE = "/notes/plan.md";
const DEB_COMMAND = ["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y"];
const msi = { version: "1.3.0", file: "/profile/updates/msi/Downpad-1.3.0-win-x64.msi", sha256: SHA256 };
const appImage = { version: "1.3.0", file: "/profile/updates/appimage/Downpad-1.3.0-linux-x86_64.AppImage", sha256: SHA256 };
const deb = { version: "1.3.0", file: "/profile/updates/deb/Downpad-1.3.0-linux-amd64.deb", sha256: SHA256 };

/** The steps of a start that goes on to open the window, reporting `failure` if any. */
function normalStart(failure?: string): unknown[][] {
  const report = failure
    ? [["showMessageBox", { type: "warning", title: "Downpad", message: "The update could not be installed.", detail: failure }]]
    : [];
  return [["registerIpc"], ["window"], ...report, ["checkIfDue"]];
}

const launchArguments = process.argv;

beforeEach(() => {
  vi.resetModules();
  startup.steps = [];
  startup.scenario = { kind: null, start: { pending: null, failure: null } };
  startup.updaterOptions = undefined;
  startup.updateInfo = { version: "1.2.0", selfUpdate: true, lastCheckMs: null, state: { status: "idle" } };
  startup.approveResult = true;
  startup.approveFailure = undefined;
  startup.destroyed = false;
  startup.ipcListeners.clear();
  startup.dialogAnswer = undefined;
  vi.stubEnv("DOWNPAD_USER_DATA_DIR", "");
  vi.stubEnv("APPIMAGE", APPIMAGE);
  // A packaged launch that opens one Markdown file.
  process.argv = ["/opt/Downpad/downpad", LAUNCH_FILE];
});

afterEach(() => {
  process.argv = launchArguments;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each<{ name: string; scenario: Scenario; steps: unknown[][] }>([
  {
    name: "stages a Windows update, hands it over, starts its helper and quits",
    scenario: { kind: "msi", start: { pending: msi, failure: null } },
    steps: [
      ["stageMsi", msi.file, SHA256],
      ["handedToInstaller", "1.3.0"],
      ["startMsiInstaller", startup.staged, process.execPath, startup.resultFile, resolve(LAUNCH_FILE)],
      ["installerStarted", startup.helperPid],
      ["exit", 0],
    ],
  },
  {
    name: "discards the staged Windows update and starts normally when its helper cannot start",
    scenario: { kind: "msi", start: { pending: msi, failure: null }, failures: { startMsiInstaller: new Error("The update helper could not start.") } },
    steps: [
      ["stageMsi", msi.file, SHA256],
      ["handedToInstaller", "1.3.0"],
      ["startMsiInstaller", startup.staged, process.execPath, startup.resultFile, resolve(LAUNCH_FILE)],
      ["discardStagedMsi", startup.staged],
      ["dropPending", "Couldn't install Downpad 1.3.0. The update helper could not start."],
      ...normalStart("Couldn't install Downpad 1.3.0. The update helper could not start."),
    ],
  },
  {
    name: "never hands over a Windows update that could not be staged",
    scenario: { kind: "msi", start: { pending: msi, failure: null }, failures: { stageMsi: new Error("The downloaded update failed its integrity check and was discarded.") } },
    steps: [
      ["stageMsi", msi.file, SHA256],
      ["dropPending", "Couldn't install Downpad 1.3.0. The downloaded update failed its integrity check and was discarded."],
      ...normalStart("Couldn't install Downpad 1.3.0. The downloaded update failed its integrity check and was discarded."),
    ],
  },
  {
    name: "replaces the AppImage, forgets the update and starts the replaced file",
    scenario: { kind: "appimage", start: { pending: appImage, failure: null } },
    steps: [
      ["replaceAppImage", appImage.file, SHA256, APPIMAGE],
      ["dropPending"],
      ["relaunch", { execPath: APPIMAGE, args: [LAUNCH_FILE] }],
      ["exit", 0],
    ],
  },
  {
    name: "installs a Debian update, forgets it and starts again",
    scenario: { kind: "deb", start: { pending: deb, failure: null }, debCommand: DEB_COMMAND, debResult: "installed" },
    steps: [
      ["installDeb", deb.file, SHA256, DEB_COMMAND],
      ["dropPending"],
      ["relaunch", { execPath: process.execPath, args: [LAUNCH_FILE] }],
      ["exit", 0],
    ],
  },
  {
    name: "forgets a cancelled Debian update and starts without reporting a failure",
    scenario: { kind: "deb", start: { pending: deb, failure: null }, debCommand: DEB_COMMAND, debResult: "cancelled" },
    steps: [["installDeb", deb.file, SHA256, DEB_COMMAND], ["dropPending"], ...normalStart()],
  },
  {
    name: "reports a Debian update that has no program to install it",
    scenario: { kind: "deb", start: { pending: deb, failure: null }, debCommand: null },
    steps: [
      ["dropPending", "Couldn't install Downpad 1.3.0. pkexec or a package manager is missing."],
      ...normalStart("Couldn't install Downpad 1.3.0. pkexec or a package manager is missing."),
    ],
  },
  {
    name: "reports the Windows installer's failure from the previous start",
    scenario: { kind: "msi", start: { pending: null, failure: "Couldn't install Downpad 1.3.0. The Windows installer stopped with error 1618." } },
    steps: normalStart("Couldn't install Downpad 1.3.0. The Windows installer stopped with error 1618."),
  },
  {
    name: "quits an extra launch while the Windows installer runs",
    scenario: { kind: "msi", start: { pending: null, failure: null, installing: true } },
    steps: [["exit", 0]],
  },
])("start $name", async ({ scenario, steps }) => {
  startup.scenario = scenario;
  await import("./main");
  await vi.waitFor(() => expect(startup.steps).toEqual(steps), { interval: 5 });
  // The mocked start awaits no timers or files, so one macrotask lets it settle.
  await new Promise((settled) => setImmediate(settled));
  expect(startup.steps).toEqual(steps);
});

/** Start without a pending installation and optionally attach the renderer's close guard. */
async function startForPrompt(attachCloseListener = true): Promise<void> {
  startup.scenario.kind = "appimage";
  await import("./main");
  await vi.waitFor(() => expect(startup.steps).toEqual(normalStart()), { interval: 5 });
  expect(startup.updaterOptions?.onChange).toBeTypeOf("function");
  if (attachCloseListener) setCloseListener(true);
  startup.steps = [];
}

/** Register through the same trusted IPC callback as the preload's close listener. */
function setCloseListener(attached: boolean): void {
  const listener = startup.ipcListeners.get("downpad:close-listener");
  expect(listener).toBeTypeOf("function");
  listener!(startup.senderEvent, attached);
}

/** Publish a state change through the real main-process updater callback. */
function publishUpdate(state: UpdateInfo["state"] = { status: "ready", version: "1.3.0" }): void {
  startup.updateInfo = { ...startup.updateInfo, state };
  startup.updaterOptions!.onChange!(startup.updateInfo);
}

/** Flush async dialog handling without introducing an arbitrary timer delay. */
async function settlePrompt(): Promise<void> {
  await new Promise((settled) => setImmediate(settled));
}

/** Leave the native prompt open until the test chooses a button. */
function holdPrompt(): (response: number) => void {
  let answer!: (response: number) => void;
  const pending = new Promise<{ response: number }>((resolve) => {
    answer = (response) => resolve({ response });
  });
  startup.dialogAnswer = () => pending;
  return answer;
}

const readyPrompt = ["showMessageBox", expect.objectContaining({
  message: "Downpad 1.3.0 is ready to install.",
  buttons: ["Later", "Now"],
  defaultId: 0,
  cancelId: 0,
})];

it("waits for the renderer's close guard before offering a downloaded update", async () => {
  await startForPrompt(false);
  publishUpdate();
  await settlePrompt();
  expect(startup.steps).toEqual([]);

  setCloseListener(true);
  await settlePrompt();
  expect(startup.steps).toEqual([readyPrompt]);
});

it("keeps Later pending for next start and prompts only once for the same version", async () => {
  await startForPrompt();
  const answer = holdPrompt();
  publishUpdate();
  publishUpdate();
  expect(startup.steps).toEqual([readyPrompt]);

  answer(0);
  await settlePrompt();
  publishUpdate();
  setCloseListener(true);
  await settlePrompt();
  expect(startup.steps).toEqual([readyPrompt]);
  expect(startup.updateInfo.state).toEqual({ status: "ready", version: "1.3.0" });
});

it("approves Now and uses the normal quit path for unsaved-document handling", async () => {
  await startForPrompt();
  startup.dialogAnswer = async () => ({ response: 1 });
  publishUpdate();
  await settlePrompt();
  expect(startup.steps).toEqual([readyPrompt, ["approve"], ["quit"]]);
});

it.each(["removed download", "detached close guard", "destroyed window"])(
  "does not restart for Now after a %s", async (change) => {
    await startForPrompt();
    const answer = holdPrompt();
    publishUpdate();
    expect(startup.steps).toEqual([readyPrompt]);

    if (change === "removed download") publishUpdate({ status: "idle" });
    else if (change === "detached close guard") setCloseListener(false);
    else startup.destroyed = true;
    answer(1);
    await settlePrompt();
    expect(startup.steps).toEqual([readyPrompt]);
  },
);

it("does not offer an update when its window has been destroyed", async () => {
  await startForPrompt();
  startup.destroyed = true;
  publishUpdate();
  await settlePrompt();
  expect(startup.steps).toEqual([]);
});

it("logs a failed native prompt without rejecting the update notification", async () => {
  await startForPrompt();
  const failure = new Error("The native dialog could not open.");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  startup.dialogAnswer = async () => { throw failure; };
  expect(() => publishUpdate()).not.toThrow();
  await settlePrompt();
  expect(startup.steps).toEqual([readyPrompt]);
  expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
});

it.each(["missing package", "approval write failure"])("reports a %s when Now cannot restart", async (failure) => {
  await startForPrompt();
  const message = failure === "missing package" ? "No downloaded update is waiting." : "Could not write update approval.";
  if (failure === "missing package") startup.approveResult = false;
  else startup.approveFailure = new Error(message);
  startup.dialogAnswer = async () => ({ response: 1 });
  publishUpdate();
  await settlePrompt();
  expect(startup.steps).toEqual([readyPrompt, ["approve"], ["showMessageBox", expect.objectContaining({
    type: "warning",
    message: "Downpad could not restart to install the update.",
    detail: `${message}\nYou can try again from Settings > Updates.`,
  })]]);
  expect(startup.updateInfo.state).toEqual({ status: "ready", version: "1.3.0" });
});
