import { Select } from "./ui/Select";
import { FormEvent, useEffect, useState } from "react";
import type { ProviderId, Session, SessionConfig } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { displayPath } from "../projectScope";
import { RetrySettings } from "./RetrySettings";

const providers: ProviderId[] = [
  "codex",
  "claude",
  "kimi",
  "gemini",
  "opencode",
  "shell",
  "grok",
  "custom",
];
const isActive = (session: Session) =>
  !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);

export function SessionConfigDialog({
  session,
  onClose,
  onRerun,
}: {
  session: Session;
  onClose: () => void;
  onRerun: (id: string) => void;
}) {
  const [config, setConfig] = useState<SessionConfig>();
  const [args, setArgs] = useState("");
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void request("session.config.read", { sessionId: session.id })
      .then((value) => {
        setConfig(value);
        setArgs(value.args.join("\n"));
      })
      .catch((error) =>
        setIssue(
          error instanceof Error
            ? error.message
            : "Unable to read this session configuration.",
        ),
      );
  }, [session.id]);
  const update = <K extends keyof SessionConfig>(
    key: K,
    value: SessionConfig[K],
  ) =>
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  const save = async () => {
    if (!config) return false;
    setBusy(true);
    setIssue(undefined);
    try {
      const saved = await request("session.config.save", {
        sessionId: session.id,
        provider: config.provider,
        mode: config.mode,
        cwd: config.cwd.trim(),
        projectId: config.projectId,
        title: config.title?.trim() || undefined,
        executable: config.executable?.trim() || undefined,
        args: args
          .split("\n")
          .map((arg) => arg.trim())
          .filter(Boolean),
        expectedRevision: config.revision,
        operationId: operationId(),
      });
      setConfig(saved);
      setArgs(saved.args.join("\n"));
      return true;
    } catch (error) {
      setIssue(
        error instanceof Error ? error.message : "Configuration was not saved.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await save();
  };
  const rerun = async (stopFirst: boolean) => {
    if (isActive(session) && !stopFirst) return;
    if (
      stopFirst &&
      !confirm(
        "End this active session and create a new session from its saved configuration?",
      )
    )
      return;
    if (!(await save())) return;
    setBusy(true);
    try {
      if (stopFirst)
        await request("session.stop", {
          sessionId: session.id,
          operationId: operationId(),
        });
      const created = await request("session.rerun", {
        sessionId: session.id,
        operationId: operationId(),
      });
      onRerun(created.id);
    } catch (error) {
      setIssue(
        error instanceof Error
          ? error.message
          : "Unable to rerun this session.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" role="presentation">
      <section
        className="dialog session-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-config-title"
      >
        <div className="dialog-title">
          <h2 id="session-config-title">Session configuration</h2>
          <button onClick={onClose}>Close</button>
        </div>
        {config ? (
          <form
            className="dialog-form"
            onSubmit={(event) => void submit(event)}
          >
            <label>
              Provider
              <Select
                value={config.provider}
                onChange={(event) =>
                  update("provider", event.target.value as ProviderId)
                }
              >
                {providers.map((provider) => (
                  <option key={provider}>{provider}</option>
                ))}
              </Select>
            </label>
            <label>
              Mode
              <Select
                value={config.mode}
                onChange={(event) =>
                  update("mode", event.target.value as SessionConfig["mode"])
                }
              >
                <option value="terminal">Terminal</option>
                <option value="chat">Structured Chat</option>
              </Select>
            </label>
            <label>
              Working directory
              <input
                required
                value={displayPath(config.cwd)}
                onChange={(event) => update("cwd", event.target.value)}
              />
            </label>
            <label>
              Executable{" "}
              <input
                value={config.executable ?? ""}
                onChange={(event) => update("executable", event.target.value)}
                placeholder="Provider default"
              />
            </label>
            <label>
              Arguments{" "}
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder="One argument per line"
                rows={4}
              />
            </label>
            <label>
              Title{" "}
              <input
                value={config.title ?? ""}
                onChange={(event) => update("title", event.target.value)}
              />
            </label>
            <RetrySettings sessionId={session.id} terminal={session.mode === "terminal"} />
            {issue && (
              <p role="alert" className="surface-error">
                {issue}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" disabled={busy} type="submit">
                Save configuration
              </button>
              {isActive(session) ? (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void rerun(true)}
                >
                  Stop then rerun
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void rerun(false)}
                >
                  Rerun in new session
                </button>
              )}
            </div>
          </form>
        ) : (
          <p className="settings-note">Loading configuration…</p>
        )}
      </section>
    </div>
  );
}
