// Electron visual QA for the shared Codex, Kimi, and Grok usage-card presentation.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
const out = join(
  "qa",
  "results",
  "unified-usage-visual-" + new Date().toISOString().replace(/[:.]/g, "-"),
);
const scratch = await mkdtemp(join(tmpdir(), "threadterm-unified-usage-"));
const smoke = JSON.parse(
  await readFile(join("qa", "results", "grok-chat-smoke.json"), "utf8"),
);
const grokParts = smoke?.observations?.commandParts?.["/usage"];
assert.ok(
  Array.isArray(grokParts) && grokParts.length,
  "missing actual Grok /usage parts",
);
const grokPlan = grokParts.find((part) => part?.data?.kind === "plan");
const grokPercent = grokPlan?.data?.rows?.[0]?.percent;
assert.ok(
  Number.isFinite(grokPercent),
  "actual Grok plan percentage is missing",
);
const entry = [
  'import React from "react";',
  'import {createRoot} from "react-dom/client";',
  'import {ChatView} from "./renderer/src/components/ChatView";',
  'import {I18nProvider} from "./renderer/src/i18n";',
  'import "./renderer/src/styles.css";',
  'let items=[],locale="en",session={id:"qa",provider:"codex",mode:"chat",status:"idle",title:"QA",createdAt:"now",updatedAt:"now"};',
  'const connection=id=>({sessionId:id,runtimeEpoch:"qa",connectionGeneration:1,revision:1,phase:"ready",optionsLoadState:"ready"});',
  'window.threadterm={onEvent(){return()=>{}},async request(method,params){if(method==="chat.snapshot")return {items,revision:1};if(method==="chat.draft.read")return {text:"",revision:1};if(method==="chat.draft.save")return {revision:1};if(method==="chat.connection"||method==="chat.connect")return connection(params.sessionId);if(method==="chat.options")return {options:[],commands:[],loadState:"ready"};if(method==="session.claim"||method==="session.renew")return {leaseEpoch:1};if(method==="session.release"||method==="chat.cancel")return null;throw Error("unexpected "+method)}};',
  'const root=createRoot(document.getElementById("root"));window.qaRender=next=>{items=next.items;locale=next.locale;session={id:next.id,provider:next.provider,mode:"chat",status:"idle",title:"QA",createdAt:"now",updatedAt:"now"};document.documentElement.dataset.theme=next.theme;root.render(React.createElement(I18nProvider,{locale},React.createElement(ChatView,{session})))};',
].join("\n");
await build({
  stdin: { contents: entry, resolveDir: resolve("."), loader: "tsx" },
  bundle: true,
  outfile: join(scratch, "qa.js"),
  jsx: "automatic",
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
});
await writeFile(
  join(scratch, "index.html"),
  '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script src="qa.js"></script>',
);
await writeFile(
  join(scratch, "main.cjs"),
  'const {app,BrowserWindow}=require("electron");app.setPath("userData",' +
    JSON.stringify(join(scratch, "profile")) +
    ");app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(" +
    JSON.stringify(join(scratch, "index.html")) +
    "));",
);
const user = (id, command) => ({
  id: id + "-user",
  role: "user",
  turnId: id,
  createdAt: "now",
  parts: [{ type: "text", text: command }],
});
const assistant = (id, parts, elapsedMs = 25) => ({
  id: id + "-assistant",
  role: "assistant",
  turnId: id,
  createdAt: "now",
  elapsedMs,
  parts,
});
const codexPayload = {
  directory: "C:/sensitive/project",
  thread: { id: "thread-123", sessionId: "session-456" },
  account: { planType: "prolite" },
  rateLimits: [
    {
      limitName: "GPT-5",
      planType: "prolite",
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1790000000,
      },
      secondary: {
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: 1790100000,
      },
    },
  ],
  context: {
    usedTokens: 0,
    modelContextWindow: 0,
    remainingTokens: 0,
    percentUsed: 0,
  },
};
const cases = [
  {
    name: "codex-usage",
    provider: "codex",
    items: [
      user("codex-usage", "/usage"),
      assistant(
        "codex-usage",
        [
          {
            type: "status",
            status: "complete",
            data: { ...codexPayload, kind: "usage" },
          },
        ],
        0,
      ),
    ],
    providerLabel: "codex",
    expect: /Codex/,
  },
  {
    name: "kimi-native",
    provider: "kimi",
    items: [
      user("kimi-usage", "/usage"),
      assistant("kimi-usage", [
        {
          type: "text",
          status: "complete",
          text: "Context: 0 / 0 tokens (0%)",
        },
        {
          type: "text",
          status: "complete",
          text: "Weekly limit: 0% used",
          data: {
            kind: "plan",
            rows: [
              {
                label: "Weekly limit",
                percent: 0,
                reset: "Reset time unavailable",
              },
            ],
          },
        },
      ]),
    ],
    providerLabel: "kimi",
    expect: /Kimi/,
  },
  {
    name: "grok-actual",
    provider: "grok",
    items: [user("grok-usage", "/usage"), assistant("grok-usage", grokParts)],
    providerLabel: "grok",
    expect: /Grok/,
  },
  {
    name: "codex-loading",
    provider: "codex",
    items: [
      user("codex-loading", "/usage"),
      assistant("codex-loading", [
        {
          type: "status",
          status: "complete",
          data: {
            kind: "usage",
            rateLimitsLoaded: false,
            accountLoaded: false,
          },
        },
      ]),
    ],
    providerLabel: "codex",
    expect: /Loading usage limits|正在加载用量限制/,
  },
  {
    name: "codex-error",
    provider: "codex",
    items: [
      user("codex-error", "/usage"),
      assistant("codex-error", [
        {
          type: "status",
          status: "complete",
          data: { kind: "usage", warning: "account data unavailable" },
        },
      ]),
    ],
    providerLabel: "codex",
    expect: /account data unavailable|暂时无法获取账户信息/,
  },
  {
    name: "kimi-empty",
    provider: "kimi",
    items: [
      user("kimi-empty", "/usage"),
      assistant("kimi-empty", [
        {
          type: "text",
          status: "complete",
          text: "Plan usage",
          data: { kind: "plan", rows: [] },
        },
      ]),
    ],
    providerLabel: "kimi",
    expect: /Kimi/,
  },
];
const statusCases = [
  {
    name: "codex-status-same-payload",
    provider: "codex",
    items: [
      user("codex-status", "/status"),
      assistant("codex-status", [
        {
          type: "status",
          status: "complete",
          data: {
            ...codexPayload,
            kind: "status",
            directory: "C:/sensitive/project",
            thread: { id: "thread-123", sessionId: "session-456" },
            approvalPolicy: "never",
          },
        },
      ]),
    ],
  },
  {
    name: "kimi-status",
    provider: "kimi",
    items: [
      user("kimi-status", "/status"),
      assistant("kimi-status", [
        {
          type: "text",
          status: "complete",
          text: "Session: qa\nModel: kimi\nWorking directory: C:/project\nPlan: Pro",
        },
      ]),
    ],
  },
  {
    name: "grok-status",
    provider: "grok",
    items: [
      user("grok-status", "/status"),
      assistant("grok-status", smoke.observations.commandParts["/status"]),
    ],
  },
];
const report = {
  startedAt: new Date().toISOString(),
  source: "qa/results/grok-chat-smoke.json",
  checks: [],
  cases: [],
};
let app;
try {
  await mkdir(out, { recursive: true });
  app = await electron.launch({ args: [join(scratch, "main.cjs")] });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => typeof window.qaRender === "function");
  const sharedStyles = {};
  for (const test of cases)
    for (const theme of ["light", "dark"])
      for (const locale of ["en", "zh-CN"])
        for (const width of [1280, 1440, 1920, 420]) {
          const id = `${test.name}-${theme}-${locale}-${width}`;
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((next) => window.qaRender(next), {
            ...test,
            theme,
            locale,
            id,
          });
          await page.locator(".v3-chat-log").waitFor();
          const card = page.locator('[data-testid="usage-card"]');
          await card.waitFor();
          assert.equal(
            await card.count(),
            1,
            id + " has one shared usage card",
          );
          assert.equal(
            await page.locator('[data-testid="plan-usage-card"]').count(),
            0,
            id + " has no loose legacy plan card",
          );
          assert.match(await card.innerText(), test.expect, id + " card text");
          assert.equal(
            await card.getAttribute("data-usage-provider"),
            test.providerLabel,
            id + " provider marker",
          );
          const style = await card.evaluate((node) => {
            const meter = node.querySelector(".usage-limit-meter"),
              fill = node.querySelector(".usage-limit-meter > span");
            const cs = getComputedStyle(node);
            return {
              display: cs.display,
              width: cs.width,
              radius: cs.borderRadius,
              font: cs.fontSize,
              background: cs.backgroundColor,
              padding: cs.padding,
              border: cs.border,
              boxSizing: cs.boxSizing,
              parentWidth: getComputedStyle(node.parentElement).width,
              groupDisplay: node.querySelector(".usage-limit-heading b")
                ? getComputedStyle(node.querySelector(".usage-limit-heading b"))
                    .display
                : null,
              fill: fill ? getComputedStyle(fill).width : null,
              track: meter ? getComputedStyle(meter).width : null,
            };
          });
          assert.equal(
            style.display,
            "grid",
            id + " production card styling loaded",
          );
          assert.ok(Number.parseFloat(style.radius) > 0, id + " card radius");
          assert.equal(style.font, "13px", id + " shared font");
          assert.ok(Number.parseFloat(style.width) > 0, id + " card width");
          assert.equal(
            style.width,
            style.parentWidth,
            id + " card fills its provider message column",
          );
          if (test.name === "codex-usage")
            assert.equal(
              style.groupDisplay,
              "inline",
              id + " keeps the grouped limit label inline",
            );
          if (test.name === "grok-actual") {
            assert.match(await card.innerText(), /SuperGrok/);
            assert.match(
              await card.innerText(),
              new RegExp(String(grokPercent) + "%"),
            );
            assert.ok(
              style.fill &&
                style.track &&
                Math.abs(
                  Number.parseFloat(style.fill) /
                    Number.parseFloat(style.track) -
                    grokPercent / 100,
                ) < 0.03,
              id + " actual Grok fill",
            );
          }
          if (test.name === "kimi-native") {
            assert.match(await card.innerText(), /0/);
            assert.equal(
              await card.locator(".usage-card-stats").count(),
              1,
              id + " context statistics rendered",
            );
            assert.doesNotMatch(
              await card.innerText(),
              /Reset time unavailable/,
              id + " omits missing reset text",
            );
          }
          if (test.name === "kimi-empty")
            assert.equal(
              await card.locator(".usage-card-section").count(),
              0,
              id + " omits empty sections",
            );
          const body = await page
            .locator(".v3-chat-message.assistant")
            .innerText();
          if (test.name === "codex-usage")
            assert.doesNotMatch(
              body,
              /sensitive|thread-123/,
              id + " usage omits status-only directory and thread identifiers",
            );
          assert.doesNotMatch(
            body,
            /Input tokens:\s*0|输入 token：\s*0/,
            id + " has no invented zero-token line",
          );
          const overflow = await page.evaluate(() =>
            [...document.querySelectorAll(".v3-chat-message,.usage-card")]
              .map((n) => ({
                className: n.className,
                scrollWidth: n.scrollWidth,
                clientWidth: n.clientWidth,
              }))
              .filter((n) => n.scrollWidth > n.clientWidth + 1),
          );
          assert.deepEqual(overflow, [], id + " horizontal overflow");
          assert.equal(
            await page.locator(".codex-work").count(),
            0,
            id + " has no elapsed-work disclosure for a usage response",
          );
          const shared = `${theme}-${width}-${test.provider}`;
          if (!sharedStyles[shared])
            sharedStyles[shared] = {
              radius: style.radius,
              font: style.font,
              padding: style.padding,
              border: style.border,
              boxSizing: style.boxSizing,
              width: style.width,
            };
          else
            assert.deepEqual(
              {
                radius: style.radius,
                font: style.font,
                padding: style.padding,
                border: style.border,
                boxSizing: style.boxSizing,
                width: style.width,
              },
              sharedStyles[shared],
              id + " shares card style",
            );
          if (
            (test.name === "grok-actual" &&
              theme === "light" &&
              locale === "en" &&
              width === 1280) ||
            (test.name === "codex-usage" &&
              theme === "light" &&
              locale === "en" &&
              width === 1280) ||
            (test.name === "kimi-native" &&
              theme === "dark" &&
              locale === "zh-CN" &&
              width === 420)
          )
            await page.screenshot({
              path: join(out, `${test.name}-${theme}-${locale}-${width}.png`),
            });
          report.cases.push({ id, style, overflow });
        }
  for (const test of statusCases) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate((next) => window.qaRender(next), {
      ...test,
      theme: "light",
      locale: "en",
      id: test.name,
    });
    await page.locator(".v3-chat-log").waitFor();
    assert.equal(
      await page.locator('[data-testid="usage-card"]').count(),
      0,
      test.name + " must remain its native status card",
    );
    assert.equal(
      await page.locator('[data-testid="plan-usage-card"]').count(),
      0,
      test.name + " must not create legacy plan card",
    );
    assert.ok(
      (await page
        .locator(".codex-status-card,.kimi-status-card,.v3-message-text")
        .count()) > 0,
      test.name + " status remains visible",
    );
  }
  report.checks = [
    "Codex /usage is distinct from the identical /status payload and does not expose status-only directory or thread data in the usage card",
    "Kimi native context and plan data plus actual Grok smoke /usage render one shared card with correct provider, meter, zero values, errors and loading feedback",
    "all EN/ZH, light/dark, 1280/1440/1920 and 420px split-pane cases have shared styling and no horizontal overflow",
  ];
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await app?.close();
  console.log(
    JSON.stringify(
      {
        out,
        passed: report.passed,
        checks: report.checks,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
