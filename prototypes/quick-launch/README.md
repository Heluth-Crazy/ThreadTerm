# Quick Launch Interaction Prototype

Open `index.html` directly in a browser. This is a static prototype with no network dependency: it does not execute shell commands or read or write project configuration.

Interactions to review:

- The **Quick Launch** menu: project/global commands, search, favorite markers, and worktree context.
- Normal Node start: Starting → process running without port evidence → Preview available.
- Scenario menu: Node missing a `dev` script, or no `java` on PATH with an invalid JAVA_HOME. Both show actionable next steps.
- A one-shot task with exit code 0; stop, failure, and closing/reopening the terminal view.
- Command editing panel: name, command, scope, service/one-shot task, shell, and relative working directory. JAVA_HOME / additional PATH can be explicitly overridden; inherited environment is not copied and saved.
- **Save Command** only saves a definition; **Save and Run** creates a simulated run instance in this prototype.
- Preview is a simulated page inside the prototype. It does not open a browser or verify a real service.

The prototype writes only `threadterm.quick-launch.prototype.v1` to browser `localStorage`, where it stores this prototype's command definitions. It does not read or write project configuration or execute local commands. Delete that key to reset the prototype.
