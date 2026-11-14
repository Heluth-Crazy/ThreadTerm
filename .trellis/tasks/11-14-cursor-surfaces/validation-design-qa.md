# QA evidence index

The final combined evidence and limits are in `validation-design.md` in this task directory. Earlier provisional QA failures were corrected and superseded by the passing native Design Mode run.

- Prototype references: `qa/results/design-mode/prototype-light.png`, `prototype-dark.png` (Playwright Chromium).
- Four active-note captures: `qa/results/page-comments/design-note-{en,zh-CN}-{light,dark}.png`.
- Native acceptance report: `qa/results/page-comments/report.json` (`passed: true`).
- Additional focused probes: `qa/design-picker.mjs`, `qa/design-delivery.test.mjs`, `qa/design-note-lifecycle.test.mjs`.
- All original markup-mount and Agent access assertions remain, adapted to the new popup structure.
