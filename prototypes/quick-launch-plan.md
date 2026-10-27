# ThreadTerm Quick Launch Proposal

Status: proposal and interaction prototype for review; no product functionality has been implemented. This iteration does not modify product code.

## 1. Recommended Direction

Add a **Quick Launch** entry to the current project/worktree toolbar, where commonly used service, test, and build commands can be saved. Clicking an entry creates a managed terminal to run it; clicking an entry that is already running opens its original terminal. Node, Java, Python, and Docker use the same execution mechanism. Their differences belong in the command, shell, working directory, and environment.

Do not change the default behavior of existing ordinary shells, and do not put Quick Launch into work presets. Existing presets explicitly promise to review commands without executing them during restore; Quick Launch should be an independent feature.

## 2. User Flow

1. Select a project and worktree, then open the **Quick Launch** menu.
2. Search for or select a project command or global command. Each entry shows its name, command summary, shell, and run state.
3. Click Run to open a terminal tab for that command. During initial setup, users can choose a template or enter their own command.
4. When a service runs, show an available preview entry point; tests and builds show their exit result.
5. Opening the terminal, opening the preview, stopping a run, and editing a definition are separate actions.

Closing a terminal view only hides the view; the service continues to run. Stop ends the Session process tree for that run while retaining its output history. Editing a running definition does not change an already started process; to apply new settings, users explicitly stop it and run it again.

## 3. First-Version Interface

- **Entry point:** **Quick Launch ▾** in the worktree toolbar. Its primary button can rerun the most recently used entry; if none exists, it opens the menu.
- **Menu:** Search, project commands, global commands, and favorites. A running entry shows **Open Terminal**. Recent-use records should point to a definition ID rather than copy a new command.
- **Editing panel:** Name, command, shell, working directory, scope, and purpose. Environment overrides and the preview address belong under **Advanced Settings**. Saving does not execute; execution is a separate action.
- **Terminal tab:** Uses the entry name and displays a text state plus a status dot. The right side can open a preview or stop the run. Color must not be the only state indicator.
- **Templates:** Node development service, Java Maven / Gradle, run JAR, build, and test. Templates only populate editable content; they do not install tools automatically.

Keep the Quick Launch list compact rather than creating a service console that consumes the entire workspace. Existing terminal and browser panels host the running content.

## 4. How Node and Java Share One Model

| Scenario | Example command | Working directory | Optional preview |
| --- | --- | --- | --- |
| Node frontend | `npm run dev` | Directory containing the relevant package.json | http://localhost:5173 |
| Maven service | `.\mvnw.cmd spring-boot:run` | Directory containing the Maven wrapper / pom.xml | http://localhost:8080 |
| Gradle service | `.\gradlew.bat bootRun` | Directory containing the Gradle wrapper | User-configured |
| Java JAR | `java -jar app.jar` | Directory containing the JAR | Optional |
| One-shot test | `npm test` | Relevant package directory | None |

Every definition explicitly stores its shell choice and supports Windows CMD, Windows PowerShell, and PowerShell 7 when installed. On creation, the UI can show **Inherit default shell** and the resolved shell. The existing Windows default remains CMD; this proposal does not switch it implicitly. PowerShell in the prototype is a demonstration selection.

Do not automatically change shells based on `node` or `java` in a command, split commands into argv by spaces, or save a global copy of the inherited environment. Each run inherits the current Windows environment, then applies that entry's explicit environment overrides. Node or Java versions can be specified through commands, scripts, or overrides such as JAVA_HOME; the system PATH and registry are never modified.

Whether Java can run cannot be determined only by whether JAVA_HOME is non-empty: `java -jar` may work when a valid `java` is on PATH. Error messages should cite the actual detection result or the selected tool's specific requirements.

## 5. Definitions, Runs, and States

A **command definition** stores its name, scope (global / project), shell, command body, relative working directory, purpose (service / one-shot task), explicit environment overrides, optional preview URL, and version. Sensitive values are not automatically collected or copied into ordinary configuration. The first version does not provide secret management or automatic environment-file export.

A **run record** stores a definition ID and version snapshot, the actual worktree/path, Session ID, start/end times, actual exit result, and stop intent. A global definition is reusable across projects; it does not mean that it starts from a global directory. Changing worktrees resolves the working directory again, and instances from separate worktrees are never shared.

For the same definition and worktree, the first version allows only one active instance by default. The Runtime performs an atomic check at the run entry point and returns an existing instance. Disabling a frontend button alone is insufficient, because a double-click or two windows could otherwise start two processes.

Registered non-Git directories must also work, using the real project directory rather than inventing a worktree ID. Archived, removed, or read-only targets follow the existing creation/control restrictions and cannot be bypassed through Quick Launch. JAVA_HOME in a run configuration is an ordinary directory and may be displayed directly; inherited PATH shows only its source and is not copied and saved in full.

| Display state | Evidence | Actions |
| --- | --- | --- |
| Starting | The start operation has been accepted, but the process has not yet been confirmed as running | Open Terminal |
| Running | The managed process for this run remains alive | Open Terminal / Stop |
| Preview available | The configured address has listening or HTTP-response evidence | Open Preview; retain Running state |
| Completed | A one-shot task actually exited with code 0 | View Output / Run Again |
| Exited | A service exited on its own with code 0 | View Output / Run Again |
| Start or run failed | Startup failed, or the command exited with a non-zero code | View Reason / Edit / Run Again |
| Stopped | An explicit stop request was made and the original process exit is confirmed | View Output / Run Again |
| Connection interrupted; state pending synchronization | The client cannot temporarily confirm Runtime state | Reconnect and restore the same run record |

A live process does not equal business health. A listening port or HTTP response also does not prove a database connection or business endpoint is healthy. Preview state and run state are separate: the root path of a Java API can return 404 while the service remains accessible, and it must not be marked as a run failure.

A configured address that responds may belong to another process already using that port. If the first version lacks process-ownership evidence, it should say **Configured address is reachable; ownership is unconfirmed** rather than claim that this service is ready. Stop must still target only its own Session.

## 6. One Key Technical Choice

Quick Launch tracks **one foreground command run**. CMD uses `/C`, which exits with the command; PowerShell uses `-Command`, without `-NoExit`. It must not use `/K` or `-NoExit`, which would leave an empty shell and incorrectly report that a service is still running. After a command exits, its terminal output remains available as history.

Ordinary interactive shells retain their existing startup behavior. The first version requires service commands to run in the foreground; commands that daemonize themselves, hand off to an existing system service, or use a third-party manager do not promise automatic child-service lifecycle tracking.

The command body is preserved verbatim and parsed by the selected shell. The working directory and environment are set through structured startup parameters rather than concatenating `cd ... && ...`. Windows quoting goes through a common startup adapter and must cover spaces, Chinese paths, quotes, pipes, and special characters. A later version can add an advanced **executable + argument array** mode; the first version does not expose two complex forms at once.

## 7. Errors and Readiness Checks

The first version performs only lightweight checks with clear evidence, avoiding claims that it can validate arbitrary shell scripts:

- Validate the worktree, relative directory, and shell availability; reconfirm the actual path at run time.
- A Node template can read package.json in that directory and list actual scripts. When `dev` is absent, prompt the user to change directory or choose an existing script instead of blindly repeating execution.
- A Java template checks actual Java / wrapper conditions. If `java` cannot be found and JAVA_HOME is invalid, identify the environment setting that must be configured.
- Custom commands do not use fragile string guessing; actual stderr and exit code after execution remain the final evidence.
- If a readiness check fails, do not create a falsely successful run. Retain the definition so it can be edited and retried.
- When a start request times out, first query the original operation/run record. Do not resend under a new operation ID and create a duplicate process.
- Log links and port numbers cannot identify a process to stop; stopping always targets the Session ID of that run.

## 8. Integration with Existing Code

The following capabilities already exist. New objects and interfaces are only recommendations in this proposal and have not been implemented:

| Existing foundation | Reuse approach |
| --- | --- |
| [SessionCreateDialog](../renderer/src/components/SessionCreateDialog.tsx:45) / [session.create](../protocol/index.ts:171) | Create manageable terminal sessions |
| [session_configs.rs](../runtime/src/session_configs.rs:16) | Reuse one-time startup configuration persistence |
| [service.rs startup flow](../runtime/src/service.rs:1113) / [PTY](../runtime/src/pty.rs:68) | Preserve existing supervision, output, and process-tree lifecycle |
| [environment.rs](../runtime/src/environment.rs:1) | Use the current Windows environment for every run |
| [session.stop](../runtime/src/service.rs:713) | Stop the exact managed Session |
| [Session.exitCode](../protocol/index.ts:23) / [native exit projection](../runtime/src/pty.rs:208) | Directly reuse actual exit codes and state events |
| [sessionStartup](../renderer/src/sessionStartup.ts:2) | Preserve the existing compatibility path for creating windows, and add an explicit shell adapter separately |
| [presetRestore](../renderer/src/presetRestore.ts:25) | Preserve the preset convention of **no automatic execution** |

Add independent Quick Launch definitions, run associations, and Runtime RPCs: list / save / delete / run. Saving and deleting carry `expectedRevision` and `operationId`; run carries a target project/worktree and `operationId`. The Runtime performs singleton checks, creates the run record, and starts the existing session instead of writing another process manager.

Cross-layer extensions must include explicit environment overrides, stop intent / termination reason, definition-version snapshots, and run-association projections. Existing Sessions already persist and project native `exitCode`, so an exit-code mechanism does not need to be recreated. However, ordinary stops and natural exits can return the same state and exit code, so a persistent termination reason is required to display **Stopped** accurately. Merely relabeling existing Session `running` / `exited` states cannot pretend to provide complete service state. Deleting a definition does not automatically stop instances that are already running.

For the first preview version, check only a user-configured local URL; do not implement machine-wide automatic port discovery. A failed check does not affect command execution. Discovering actual addresses from logs, port/process ownership, WSL/remote hosts, combined frontend/backend starts, automatic restart, and business-health checks belong in later work.

## 9. Prototype and Validation

Open the [interaction prototype](quick-launch/index.html). Commands, logs, ports, previews, and environment fixes in the prototype are all local simulations. It does not start processes, request real services, or access credentials.

Review path: normal Node start → run again to open the existing terminal → open preview → close the view and reopen it → stop; missing Java environment → fix the simulated environment → retry; Node missing `dev` → edit directory / command; one-shot task completion; switch worktrees to verify instance isolation; edit a definition to verify that the run configuration snapshot remains unchanged.

During actual implementation, verify at least: no duplicate starts from double-clicks/multiple windows; working-directory and shell errors; CMD/PowerShell quoting; isolation between worktrees; exit-code distinctions; stopping the original process tree; closing a view without stopping a process; no re-execution after disconnection; environment overrides that do not pollute other runs; and light/dark themes plus keyboard operation.

## 10. Phased Delivery Proposal

1. **Definitions and one-click runs:** save / edit / search, scope, explicit shell, relative directory, environment overrides, services / tasks, atomic singleton behavior, existing terminals and stopping, and exit results.
2. **Project tasks and previews (the first version's second milestone):** import actual package scripts / wrapper templates, template-specific readiness checks, configured local preview addresses, and reachability evidence. The prototype shows both milestones so they can be reviewed together.
3. **Later enhancements:** combined starts, dependency order, automatic address discovery, executable-argument mode, run-environment profiles, WSL/remote support, and business-health checks.

This iteration delivers the proposal and prototype. Prototype behavior is a recommendation; it does not mean that the Runtime has been integrated or that later capabilities above have been implemented.
