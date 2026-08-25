type InvokeResult = { ok: boolean; value?: unknown };
export type SmokeCounters = {
  writable: number;
  resize: number;
  hiddenReveal: number;
  closed: number;
  harnessUnknown: number;
  floatAttach: number;
  floatHideReveal: number;
  recycle: number;
};

export type MatrixCorrectness = {
  blank: number;
  unwritable: number;
  duplicate: number;
  lostDa1: number;
  orphan: number;
};

export type MatrixEvidenceExclusion =
  | "none"
  | "shellUnavailable"
  | "toolUnavailable";

const matrixCorrectnessKeys = [
  "blank",
  "duplicate",
  "lostDa1",
  "orphan",
  "unwritable",
] as const;

function zeroMatrixCorrectness(): MatrixCorrectness {
  return {
    blank: 0,
    unwritable: 0,
    duplicate: 0,
    lostDa1: 0,
    orphan: 0,
  };
}

function matrixEvidenceExclusion(report: object): MatrixEvidenceExclusion {
  const value = report as {
    status?: unknown;
    errorKind?: unknown;
    probeUnavailable?: unknown;
  };
  if (
    Number.isSafeInteger(value.probeUnavailable) &&
    (value.probeUnavailable as number) > 0
  )
    return "toolUnavailable";
  if (
    value.status === "unavailable" &&
    (value.errorKind === undefined || value.errorKind === "shellUnavailable")
  )
    return "shellUnavailable";
  return "none";
}

/**
 * Attach the privacy-safe matrix projection after a spec's assertions finish.
 * Failed rows are still schema-complete, but matrix validation rejects them;
 * this helper never converts a failure into a passed row.
 */
export function withMatrixEvidence<T extends object>(
  report: T,
): T & { correctness: MatrixCorrectness; exclusion: MatrixEvidenceExclusion } {
  const correctness = zeroMatrixCorrectness();
  if (
    Object.keys(correctness).sort().join(",") !==
    [...matrixCorrectnessKeys].sort().join(",") ||
    Object.values(correctness).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error("matrix-evidence-projection-invalid");
  return {
    ...report,
    correctness,
    exclusion: matrixEvidenceExclusion(report),
  };
}

export function normalizeWindowsCanonicalPath(value: string): string {
  let normalized = value.replaceAll("/", "\\");
  const longPrefix = "\\\\?\\";
  const longUncPrefix = `${longPrefix}UNC\\`;
  const lower = normalized.toLowerCase();
  if (lower.startsWith(longUncPrefix.toLowerCase())) {
    normalized = `\\\\${normalized.slice(longUncPrefix.length)}`;
  } else if (lower.startsWith(longPrefix.toLowerCase())) {
    normalized = normalized.slice(longPrefix.length);
  }
  return normalized.replace(/\\+$/, "").toLowerCase();
}

export async function invoke(
  command: string,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  try {
    return (await browser.executeAsync(
      (name, payload, done) => {
        const internals = (
          window as Window & {
            __TAURI_INTERNALS__?: {
              invoke: (key: string, value: unknown) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        if (!internals) return done({ ok: false });
        internals.invoke(name, payload).then(
          (value) => done({ ok: true, value }),
          () => done({ ok: false }),
        );
      },
      command,
      args,
    )) as Promise<InvokeResult>;
  } catch {
    return { ok: false };
  }
}

type SurfaceUnavailableDiagnostic = {
  event: "surfaceUnavailable";
  handleStatus: "none" | "single" | "multiple";
  urlKind: "aboutBlank" | "tauriLocal" | "other" | "unavailable" | "mixed";
  readyState: "loading" | "interactive" | "complete" | "unavailable" | "mixed";
  rootStatus: "present" | "missing" | "unavailable" | "mixed";
  bodyStatus: "empty" | "nonempty" | "unavailable" | "mixed";
};

type SurfaceSnapshot = Omit<
  SurfaceUnavailableDiagnostic,
  "event" | "handleStatus"
>;

function aggregateSurfaceSnapshots(
  snapshots: SurfaceSnapshot[],
): SurfaceSnapshot {
  const aggregate = <T extends SurfaceSnapshot[keyof SurfaceSnapshot]>(
    key: keyof SurfaceSnapshot,
  ): T => {
    const values = snapshots.map((snapshot) => snapshot[key]);
    if (values.length === 0 || values.every((value) => value === "unavailable"))
      return "unavailable" as T;
    return values.every((value) => value === values[0])
      ? (values[0] as T)
      : ("mixed" as T);
  };
  return {
    urlKind: aggregate("urlKind"),
    readyState: aggregate("readyState"),
    rootStatus: aggregate("rootStatus"),
    bodyStatus: aggregate("bodyStatus"),
  };
}

async function surfaceUnavailableDiagnostic(): Promise<
  SurfaceUnavailableDiagnostic | undefined
> {
  let handles: string[];
  try {
    handles = await browser.getWindowHandles();
  } catch {
    return undefined;
  }
  const snapshots: SurfaceSnapshot[] = [];
  for (const handle of handles) {
    try {
      await browser.switchToWindow(handle);
      snapshots.push(
        await browser.execute(() => {
          const url = window.location.href;
          const urlKind =
            url === "about:blank"
              ? "aboutBlank"
              : ((window.location.protocol === "http:" ||
                  window.location.protocol === "https:") &&
                  window.location.hostname === "tauri.localhost") ||
                  (window.location.protocol === "tauri:" &&
                    window.location.hostname === "localhost")
                ? "tauriLocal"
                : "other";
          const readyState = document.readyState;
          const rootStatus = document.querySelector("#root")
            ? "present"
            : "missing";
          const body = document.body;
          const bodyStatus =
            body && (body.childElementCount > 0 || body.textContent?.trim())
              ? "nonempty"
              : "empty";
          return { urlKind, readyState, rootStatus, bodyStatus };
        }),
      );
    } catch {
      snapshots.push({
        urlKind: "unavailable",
        readyState: "unavailable",
        rootStatus: "unavailable",
        bodyStatus: "unavailable",
      });
    }
  }
  return {
    event: "surfaceUnavailable",
    handleStatus:
      handles.length === 0
        ? "none"
        : handles.length === 1
          ? "single"
          : "multiple",
    ...aggregateSurfaceSnapshots(snapshots),
  };
}

export async function waitForSurface(
  onUnavailable?: (diagnostic: SurfaceUnavailableDiagnostic) => void,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (await browser.execute(() => Boolean(document.querySelector("#root"))))
        return;
    }
    await browser.pause(200);
  }
  const diagnostic = await surfaceUnavailableDiagnostic();
  if (diagnostic) onUnavailable?.(diagnostic);
  throw new Error("public-main-surface-unavailable");
}

async function visibleHost(): Promise<WebdriverIO.Element> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const host of await $$(".threadterm-xterm-host")) {
      if (await host.isDisplayed().catch(() => false)) return host;
    }
    await browser.pause(150);
  }
  throw new Error("visible-terminal-host-unavailable");
}

export async function createShell(): Promise<string> {
  await browser.keys(["Control", "n"]);
  const dialog = await $('div[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 10_000 });
  const shell = (await dialog.$$("div.grid.grid-cols-4 button"))[0];
  await shell.click();
  const fields = await dialog.$$("input");
  const label = `wd-${Date.now().toString(36)}`;
  await fields[0].setValue(label);
  await fields[1].setValue(process.cwd());
  const submit = await dialog.$('button[type="submit"]');
  await submit.waitForEnabled({ timeout: 10_000 });
  await submit.click();
  await visibleHost();
  return label;
}

export async function nonceReadback(): Promise<void> {
  const textarea = await (await visibleHost()).$("textarea");
  await textarea.click().catch(() => undefined);
  const nonce = `wd-${Date.now().toString(36)}`;
  await browser.keys(`echo ${nonce}`);
  await browser.keys("Enter");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sessions = await invoke("pty_get_all_session_states", {});
    const ids =
      sessions.ok && sessions.value && typeof sessions.value === "object"
        ? Object.keys(sessions.value as Record<string, unknown>)
        : [];
    for (const ptyId of ids) {
      const output = await invoke("pty_get_recent_output", { ptyId });
      if (
        output.ok &&
        typeof output.value === "string" &&
        output.value.includes(nonce)
      )
        return;
    }
    await browser.pause(150);
  }
  throw new Error("terminal-nonce-readback-missing");
}

export async function resizeAndReveal(counters: SmokeCounters): Promise<void> {
  const before = await (await visibleHost()).getSize();
  await browser.setWindowSize(counters.resize % 2 === 0 ? 1100 : 1000, 700);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const after = await (await visibleHost()).getSize();
    if (after.width !== before.width || after.height !== before.height) {
      counters.resize += 1;
      break;
    }
    await browser.pause(100);
  }
  if (counters.resize === 0) throw new Error("native-resize-not-observed");
  await browser.keys(["Control", "Shift", "m"]);
  await browser.pause(250);
  await browser.keys(["Control", "Shift", "m"]);
  await visibleHost();
  counters.hiddenReveal += 1;
}

export async function closeShell(counters: SmokeCounters): Promise<void> {
  const more = await $$('button[aria-haspopup="menu"]');
  for (const button of more.reverse()) {
    if (await button.isDisplayed().catch(() => false)) {
      await button.click();
      break;
    }
  }
  const items = await $$('[role="menuitem"]');
  for (const item of items) {
    const text = await item.getText().catch(() => "");
    if (/close|关闭/i.test(text)) {
      await item.click();
      counters.closed += 1;
      return;
    }
  }
  throw new Error("terminal-close-menu-unavailable");
}

async function tryClickTitled(match: RegExp): Promise<boolean> {
  const clicked = await browser.execute((source) => {
    const pattern = new RegExp(source, "i");
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button[title]"),
    ].find(
      (item) => pattern.test(item.title) && item.getClientRects().length > 0,
    );
    button?.click();
    return Boolean(button);
  }, match.source);
  return clicked;
}

async function clickTitled(match: RegExp): Promise<void> {
  if (!(await tryClickTitled(match)))
    throw new Error("public-float-control-unavailable");
}

async function waitForFloatWindow(): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (
        await browser.execute(
          () =>
            Boolean(document.querySelector("[data-tauri-drag-region]")) &&
            Boolean(document.querySelector(".threadterm-xterm-host")),
        )
      )
        return handle;
    }
    await browser.pause(200);
  }
  throw new Error("float-window-unavailable");
}

async function confirmPinnedFromSelector(): Promise<void> {
  if (!(await invoke("overlay_show_selector", {})).ok)
    throw new Error("shipping-selector-command-unavailable");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      const url = await browser.getUrl().catch(() => "");
      if (url.includes("selector.html")) {
        await browser.keys("Enter");
        return;
      }
    }
    await browser.pause(200);
  }
  throw new Error("selector-window-unavailable");
}

async function pinCard(label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const action = await browser.execute((cardLabel) => {
      const handle = [
        ...document.querySelectorAll<HTMLElement>("[aria-label]"),
      ].find((item) => item.getAttribute("aria-label")?.includes(cardLabel));
      const card = handle?.closest("div.relative.flex.h-full");
      if (!card) return "wait";
      const footer = card.querySelector<HTMLElement>(
        "[data-card-footer-density]",
      );
      const density = footer?.dataset.cardFooterDensity;
      const controls = [
        ...card.querySelectorAll<HTMLButtonElement>("button[title]"),
      ];
      if (
        controls.some((item) =>
          /unpin from overlay selector|从浮层选择器取消固定/i.test(item.title),
        )
      )
        return "already";
      const pin = controls.find((item) =>
        /pin to overlay selector|固定到浮层选择器/i.test(item.title),
      );
      if (pin) {
        pin.click();
        return "pinned";
      }
      if (density === "wide") return "wait";
      const more = card.querySelector<HTMLButtonElement>(
        'button[aria-haspopup="menu"]',
      );
      if (more) {
        more.click();
        return "more";
      }
      return "wait";
    }, label);
    if (action === "pinned" || action === "already") return;
    if (action === "more") {
      const menuDeadline = Date.now() + 3_000;
      while (Date.now() < menuDeadline) {
        const expanded = await browser.execute(() =>
          Boolean(
            [
              ...document.querySelectorAll<HTMLButtonElement>(
                'button[aria-haspopup="menu"]',
              ),
            ].find((button) => button.getAttribute("aria-expanded") === "true"),
          ),
        );
        if (expanded) {
          const menuState = await browser.execute(() => {
            const items = [
              ...document.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ),
            ];
            if (
              items.some((button) =>
                /pin list full|固定列表已满/i.test(button.title),
              )
            )
              return "full";
            const item = items.find((button) =>
              /pin to overlay selector|固定到浮层选择器/i.test(button.title),
            );
            item?.click();
            return item ? "pinned" : "wait";
          });
          if (menuState === "pinned") return;
          if (menuState === "full")
            throw new Error("isolated-selector-pin-capacity-full");
        }
        await browser.pause(100);
      }
      throw new Error("card-local-pin-menu-unavailable");
    }
    await browser.pause(100);
  }
  throw new Error("card-local-pin-unavailable");
}

export async function floatAttachHideRevealReturn(
  counters: SmokeCounters,
  label: string,
): Promise<void> {
  const mainHandle = await browser.getWindowHandle();
  await browser.setWindowSize(1400, 850);
  await clickTitled(/back.*grid|返回网格/);
  await pinCard(label);
  await confirmPinnedFromSelector();
  await waitForFloatWindow();
  await visibleHost();
  counters.floatAttach += 1;
  await clickTitled(/close|关闭/);
  await confirmPinnedFromSelector();
  await waitForFloatWindow();
  await visibleHost();
  counters.floatHideReveal += 1;
  await clickTitled(/send back to main|送回主窗口/);
  await browser.switchToWindow(mainHandle);
  await waitForSurface();
  counters.recycle += 1;
  const opened = await browser.execute((cardLabel) => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
    ].find(
      (item) =>
        item.getClientRects().length > 0 &&
        item.getAttribute("aria-label")?.includes(cardLabel),
    );
    button?.click();
    return Boolean(button);
  }, label);
  if (!opened) throw new Error("recycled-terminal-card-unavailable");
  await visibleHost();
}

export const SHIPPING_HARNESS_COMMANDS = [
    "terminal_startup_harness_status",
    "terminal_startup_harness_attest_runtime_udf",
    "terminal_startup_harness_prepare_case",
    "terminal_startup_harness_snapshot",
    "terminal_startup_harness_cleanup_case",
    "terminal_startup_harness_drive_case",
    "terminal_startup_harness_warmup_snapshot",
    "terminal_startup_harness_warmup_release",
  ] as const;

export async function assertHarnessAbsent(): Promise<number> {
  for (const command of SHIPPING_HARNESS_COMMANDS) {
    if ((await invoke(command, {})).ok)
      throw new Error("shipping-harness-command-present");
  }
  return SHIPPING_HARNESS_COMMANDS.length;
}
