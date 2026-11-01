import type { MessageBoxOptions } from "electron";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { StagedMsi } from "./updateInstall";
import type { StartState } from "./updater";
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
}));

vi.mock("electron", () => {
  const window = {
    webContents: {
      mainFrame: { url: "" },
      setWindowOpenHandler: () => {},
      on: () => {},
      session: {
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
    loadFile: async () => {},
  };
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
      exit: (code: number) => { startup.steps.push(["exit", code]); },
      relaunch: (options: unknown) => { startup.steps.push(["relaunch", options]); },
    },
    BrowserWindow: class { constructor() { startup.steps.push(["window"]); return window; } },
    dialog: {
      showMessageBox: async (_window: unknown, options: MessageBoxOptions) => { startup.steps.push(["showMessageBox", options]); return { response: 0 }; },
      showErrorBox: (title: string, detail: string) => { startup.steps.push(["showErrorBox", title, detail]); },
    },
    ipcMain: { handle: (channel: string) => { if (channel === "downpad:invoke") startup.steps.push(["registerIpc"]); }, on: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    nativeTheme: {},
    net: {},
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    screen: {},
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
  vi.stubEnv("DOWNPAD_USER_DATA_DIR", "");
  vi.stubEnv("APPIMAGE", APPIMAGE);
  // A packaged launch that opens one Markdown file.
  process.argv = ["/opt/Downpad/downpad", LAUNCH_FILE];
});

afterEach(() => {
  process.argv = launchArguments;
  vi.unstubAllEnvs();
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
