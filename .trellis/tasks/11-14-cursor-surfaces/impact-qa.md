# Design Mode QA impact

2026-11-14

- `codegraph explore "browser page comments markup qa Electron Playwright harness"` located the native browser comment and markup test seams.
- `codegraph impact WebPreview -d 2` identifies `PanelBrowser`, `SessionWorkspace`, and `PaneWorkspace` as consumers. QA will assert the rendered browser surface through stable accessible controls only; it will not alter those consumers.
- `codegraph impact pagePickerScript -d 2` identifies the picker implementation only. The probe will exercise its public browser UI rather than injecting page strings or bypassing desktop validation.
- Risk: Electron integration tests share a constrained runtime. The probe uses an isolated profile, the existing QA runtime, explicit temporary directory variables, and only terminates its own Electron PID through Playwright.
- `codegraph impact deliverDesignNotes -d 2` is unknown because the new helper is not in the main-checkout index; `codegraph impact formatReviewComments -d 2` identifies the established FileComments, previews, history, and review consumers. Delivery QA therefore asserts the helper through its public host contract without changing the existing formatter's other call sites.
