import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./helpers", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "./helpers";
import { createWritablePty } from "./warmup.helpers";

const mockedInvoke = vi.mocked(invoke);
const originalDataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;

function successfulCreate(ptyId: string) {
  mockedInvoke.mockImplementation(async (command) => {
    switch (command) {
      case "terminal_startup_harness_prepare_case":
        return { ok: true, value: { caseToken: "case-token-1" } };
      case "pty_create_session_v2":
        return {
          ok: true,
          value: { ptyId, generation: "1", disposition: "created" },
        };
      case "terminal_startup_harness_snapshot":
        return { ok: true, value: { state: "bound" } };
      case "terminal_startup_harness_cleanup_case":
        return { ok: true, value: {} };
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  });
}

describe("createWritablePty", () => {
  beforeEach(() => {
    process.env.THREADTERM_WDIO_DATA_ROOT = "C:\\harness-data";
    mockedInvoke.mockReset();
  });

  it("prepares the fixed cmd plain-shell plan before create and binds its token", async () => {
    const ptyId = "warmup-test-pty";
    successfulCreate(ptyId);

    await expect(createWritablePty(ptyId)).resolves.toEqual({
      ptyId,
      generation: "1",
      disposition: "created",
      caseToken: "case-token-1",
    });

    expect(mockedInvoke.mock.calls).toEqual([
      ["terminal_startup_harness_prepare_case", {
        request: {
          shell: "cmd",
          surface: "uiNextCreate",
          timing: "natural",
          da1Fault: "none",
          warmup: "disabled",
          fixture: "plainShell",
        },
      }],
      ["pty_create_session_v2", {
        request: {
          id: ptyId,
          workingDir: "C:\\harness-data",
          rows: 24,
          cols: 100,
          startup: { kind: "none" },
        },
      }],
      ["terminal_startup_harness_snapshot", { caseToken: "case-token-1" }],
    ]);
  });

  it("fails closed when preparation fails without attempting PTY create", async () => {
    mockedInvoke.mockResolvedValue({ ok: false });

    await expect(createWritablePty("warmup-test-prepare-fail")).rejects.toThrow(
      "warmup-prepare-failed",
    );
    expect(mockedInvoke.mock.calls).toEqual([
      ["terminal_startup_harness_prepare_case", expect.any(Object)],
    ]);
  });

  it("cleans the prepared token and fails closed when create fails", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "terminal_startup_harness_prepare_case") {
        return { ok: true, value: { caseToken: "case-token-cleanup" } };
      }
      if (command === "pty_create_session_v2") return { ok: false };
      if (command === "terminal_startup_harness_cleanup_case") {
        return { ok: true, value: {} };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(createWritablePty("warmup-test-create-fail")).rejects.toThrow(
      "warmup-create-failed",
    );
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual([
      "terminal_startup_harness_prepare_case",
      "pty_create_session_v2",
      "terminal_startup_harness_cleanup_case",
    ]);
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "terminal_startup_harness_cleanup_case",
      { caseToken: "case-token-cleanup" },
    );
  });

  it("does not hide a failed claim cleanup behind the original create failure", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "terminal_startup_harness_prepare_case") {
        return { ok: true, value: { caseToken: "case-token-leaked" } };
      }
      if (command === "pty_create_session_v2") return { ok: false };
      if (command === "terminal_startup_harness_cleanup_case") {
        return { ok: false };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(createWritablePty("warmup-test-cleanup-fail")).rejects.toThrow(
      "warmup-cleanup-failed",
    );
  });
});

process.env.THREADTERM_WDIO_DATA_ROOT = originalDataRoot;
