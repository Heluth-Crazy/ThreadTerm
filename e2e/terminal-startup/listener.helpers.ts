import { invoke } from "./helpers";
import {
  parseStartupSnapshot,
  pollUntil,
  type StartupSnapshot,
} from "./timing.helpers";

const STARTUP_STATE_EVENT = "pty-startup-state";
const LISTENER_SLOT_PREFIX = "__threadtermStartupListener_";
const STARTUP_STATES = new Set([
  "notRequired",
  "waiting",
  "ready",
  "timedOut",
  "dispatching",
  "sent",
  "cancelled",
  "failed",
]);

let listenerSlotSequence = 0;

type RecordValue = Record<string, unknown>;

export type StartupListener = {
  drain: () => Promise<unknown[]>;
  unlisten: () => Promise<void>;
};

export type BoundStartupSnapshot = StartupSnapshot & {
  ptyId: string;
};

export type StartupEventObservation = BoundStartupSnapshot;

type ListenerInvokeResult = {
  ok: boolean;
  eventId?: number;
};

type HarnessStatusProjection = {
  enabled: boolean;
  shellForcing: "supported" | "unsupported";
  timingInjection: "supported" | "unsupported";
  faultInjection: "supported" | "unsupported";
  readOnlyObservation: "supported" | "unsupported";
};

function objectValue(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function capabilityValue(
  value: unknown,
): "supported" | "unsupported" | undefined {
  return value === "supported" || value === "unsupported" ? value : undefined;
}

function parseHarnessStatus(value: unknown): HarnessStatusProjection | undefined {
  const source = objectValue(value);
  if (!source || source.enabled !== true) return undefined;
  const shellForcing = capabilityValue(source.shellForcing);
  const timingInjection = capabilityValue(source.timingInjection);
  const faultInjection = capabilityValue(source.faultInjection);
  const readOnlyObservation = capabilityValue(source.readOnlyObservation);
  if (
    !shellForcing ||
    !timingInjection ||
    !faultInjection ||
    !readOnlyObservation
  ) {
    return undefined;
  }
  return {
    enabled: true,
    shellForcing,
    timingInjection,
    faultInjection,
    readOnlyObservation,
  };
}

/**
 * The harness status is intentionally checked at the test boundary. A real
 * WebDriver run must never silently become a fake or partial observation.
 */
export async function assertListenerHarnessCapabilities(): Promise<void> {
  const result = await invoke("terminal_startup_harness_status", {});
  const status = result.ok ? parseHarnessStatus(result.value) : undefined;
  if (
    !status ||
    status.shellForcing !== "supported" ||
    status.timingInjection !== "supported" ||
    status.readOnlyObservation !== "supported"
  ) {
    throw new Error("listener-harness-capability-unavailable");
  }
}

function nextListenerSlot(): string {
  listenerSlotSequence += 1;
  return `${LISTENER_SLOT_PREFIX}${listenerSlotSequence}`;
}

/**
 * Register the same Tauri v2 event-plugin listener used by
 * `@tauri-apps/api/event.listen`. Registration happens in the live WebView so
 * this test observes the real event bridge rather than a Node-side mock.
 */
export async function listenForStartupState(): Promise<StartupListener> {
  const slot = nextListenerSlot();
  const registration = (await browser.executeAsync(
    (eventName, bucketSlot, done) => {
      const page = window as unknown as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: (name: string, args: unknown) => Promise<unknown>;
          transformCallback?: (
            callback: (event: unknown) => void,
          ) => number;
        };
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener?: (name: string, eventId: number) => void;
        };
        [key: string]: unknown;
      };
      const internals = page.__TAURI_INTERNALS__;
      if (!internals?.invoke || !internals.transformCallback) {
        done({ ok: false });
        return;
      }
      const bucket: unknown[] = [];
      page[bucketSlot as string] = bucket;
      const handler = internals.transformCallback((event) => {
        if (event && typeof event === "object" && "payload" in event) {
          bucket.push((event as { payload?: unknown }).payload);
        }
      });
      void internals
        .invoke("plugin:event|listen", {
          event: eventName,
          target: { kind: "Any" },
          handler,
        })
        .then(
          (eventId) => {
            const id =
              typeof eventId === "number" && Number.isSafeInteger(eventId)
                ? eventId
                : undefined;
            done(id === undefined ? { ok: false } : { ok: true, eventId: id });
          },
          () => done({ ok: false }),
        );
    },
    STARTUP_STATE_EVENT,
    slot,
  )) as ListenerInvokeResult;
  if (!registration.ok || !Number.isSafeInteger(registration.eventId)) {
    throw new Error("listener-registration-failed");
  }

  let active = true;
  return {
    drain: async () => {
      if (!active) return [];
      return (await browser.execute((bucketSlot) => {
        const page = window as unknown as Window & {
          [key: string]: unknown;
        };
        const bucket = page[bucketSlot as string];
        if (!Array.isArray(bucket)) return [];
        return bucket.splice(0, bucket.length);
      }, slot)) as unknown[];
    },
    unlisten: async () => {
      if (!active) return;
      const eventId = registration.eventId as number;
      const result = (await browser.executeAsync(
        (eventName, id, bucketSlot, done) => {
          const page = window as unknown as Window & {
            __TAURI_INTERNALS__?: {
              invoke?: (name: string, args: unknown) => Promise<unknown>;
            };
            __TAURI_EVENT_PLUGIN_INTERNALS__?: {
              unregisterListener?: (name: string, eventId: number) => void;
            };
            [key: string]: unknown;
          };
          const internals = page.__TAURI_INTERNALS__;
          const plugin = page.__TAURI_EVENT_PLUGIN_INTERNALS__;
          if (
            !internals?.invoke ||
            !plugin?.unregisterListener
          ) {
            done({ ok: false });
            return;
          }
          try {
            plugin.unregisterListener(eventName as string, id as number);
          } catch {
            done({ ok: false });
            return;
          }
          void internals
            .invoke("plugin:event|unlisten", {
              event: eventName,
              eventId: id,
            })
            .then(
              () => {
                delete page[bucketSlot as string];
                done({ ok: true });
              },
              () => done({ ok: false }),
            );
        },
        STARTUP_STATE_EVENT,
        eventId,
        slot,
      )) as { ok: boolean };
      active = false;
      if (!result.ok) throw new Error("listener-unlisten-failed");
    },
  };
}

function parseBoundSnapshot(
  value: unknown,
  expectedPtyId: string,
  expectedGeneration: string,
): BoundStartupSnapshot | undefined {
  const source = objectValue(value);
  if (!source) return undefined;
  const ptyId = stringValue(source.ptyId);
  const generation = stringValue(source.generation);
  const revision = safeInteger(source.revision);
  const startup = parseStartupSnapshot(source);
  if (!ptyId && !generation && revision === undefined && !startup) return undefined;
  if (
    !ptyId ||
    !generation ||
    revision === undefined ||
    !startup ||
    ptyId !== expectedPtyId ||
    generation !== expectedGeneration
  ) {
    throw new Error("listener-identity-mismatch");
  }
  return { ptyId, ...startup };
}

export async function readBoundStartupSnapshot(
  ptyId: string,
  generation: string,
): Promise<BoundStartupSnapshot | undefined> {
  const result = await invoke("pty_get_startup_state", { ptyId, generation });
  if (!result.ok || result.value === null || result.value === undefined) {
    return undefined;
  }
  return parseBoundSnapshot(result.value, ptyId, generation);
}

export async function waitForBoundStartupState(
  ptyId: string,
  generation: string,
  state: StartupSnapshot["state"],
  minimumRevision = 0,
): Promise<{ snapshot: BoundStartupSnapshot; reads: number }> {
  let reads = 0;
  const snapshot = await pollUntil(
    async () => {
      reads += 1;
      const value = await readBoundStartupSnapshot(ptyId, generation);
      if (value && (value.state === "failed" || value.state === "cancelled")) {
        throw new Error("listener-startup-failed");
      }
      return value;
    },
    (value) =>
      value.state === state && value.revision >= minimumRevision,
    20_000,
  );
  return { snapshot, reads };
}

function parseStartupEvent(
  value: unknown,
  expectedPtyId: string,
  expectedGeneration: string,
): StartupEventObservation {
  const snapshot = parseBoundSnapshot(value, expectedPtyId, expectedGeneration);
  if (!snapshot || !STARTUP_STATES.has(snapshot.state)) {
    throw new Error("listener-event-invalid");
  }
  return snapshot;
}

export async function waitForStartupEvent(
  listener: StartupListener,
  ptyId: string,
  generation: string,
  state: StartupSnapshot["state"],
): Promise<{ count: number; reads: number; revision: number }> {
  const deadline = Date.now() + 20_000;
  let count = 0;
  let reads = 0;
  let revision = 0;
  while (Date.now() < deadline) {
    reads += 1;
    for (const payload of await listener.drain()) {
      const event = parseStartupEvent(payload, ptyId, generation);
      revision = Math.max(revision, event.revision);
      if (event.state === state) count += 1;
    }
    if (state === "sent" && count > 1) {
      throw new Error("listener-event-duplicate");
    }
    if (count > 0) return { count, reads, revision };
    await browser.pause(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error("listener-event-missing");
}

export async function assertNoDuplicateSentEvents(
  listener: StartupListener,
  ptyId: string,
  generation: string,
): Promise<number> {
  const deadline = Date.now() + 1_000;
  let sentCount = 0;
  let stableEmptyReads = 0;
  while (Date.now() < deadline) {
    const payloads = await listener.drain();
    if (payloads.length === 0) stableEmptyReads += 1;
    else stableEmptyReads = 0;
    for (const payload of payloads) {
      const event = parseStartupEvent(payload, ptyId, generation);
      if (event.state === "sent") sentCount += 1;
    }
    if (sentCount > 1) throw new Error("listener-event-duplicate");
    if (stableEmptyReads >= 3) return sentCount;
    await browser.pause(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error("listener-event-settle-timeout");
}

export async function killAndConfirmSession(
  ptyId: string,
): Promise<{ confirmed: boolean; killCalls: number }> {
  const killCalls = 1;
  const killed = await invoke("pty_kill", { id: ptyId });
  if (!killed.ok) return { confirmed: false, killCalls };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await invoke("pty_get_session_state", { ptyId });
    if (!state.ok) return { confirmed: true, killCalls };
    await browser.pause(Math.min(75, Math.max(1, deadline - Date.now())));
  }
  return { confirmed: false, killCalls };
}
