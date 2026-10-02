/* ==========================================================================
   ThreadTerm · 消费级应用原型（改造版）
   纯静态单页应用：hash 路由 + 数据模块（mock）+ 渲染函数 + 浮层。
   演示数据与中文文案移植自 prototype/threadterm-product-vision/app.js。
   所有交互均为本地演示，不执行真实命令、不发出网络请求。
   ========================================================================== */
(() => {
  "use strict";

  /* ==================== 基础工具 ==================== */
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  // Keep this prototype isolated from its source snapshot and the production demo.
  const KEY = "threadterm.app.v3";

  /* 内联 SVG 图标（stroke 风格，24 视图框） */
  const ICONS = {
    home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-6h6v6"/>',
    inbox:
      '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 6h14l2 7v5H3v-5z"/>',
    terminal:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 6-3 7-3 9h18c0-2-3-3-3-9M10 21h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 3 3-1 2 3 3-1 1-3 3-1 1-3-2-2 1-3-3-3-3 1z"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4 4 10-10"/>',
    star: '<path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.2-5.6-3-5.6 3 1.2-6.2L3 9.6l6.3-.8z"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    file: '<path d="M6 3h8l4 4v14H6zM14 3v5h5"/>',
    folder: '<path d="M3 6V4h7l2 2h9v14H3z"/>',
    branch:
      '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 6h8M6 8v8a2 2 0 0 0 2 2h8"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
    spark: '<path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
    moon: '<path d="M20 13A8 8 0 1 1 11 4a6.5 6.5 0 0 0 9 9z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    popout: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M19 13v7H4V5h7"/>',
    export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v5h16v-5"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    archive: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M10 14h4"/>',
    trash: '<path d="M5 7h14M9 7V5h6v2M8 7l1 13h6l1-13"/>',
  };
  const icon = (name, cls = "ico") =>
    `<svg class="${cls}" aria-hidden="true" viewBox="0 0 24 24">${
      ICONS[name] || ICONS.file
    }</svg>`;

  /* agent 品牌图标：SVG path 逐字移植自真实应用 src/components/terminal/agentIcons.tsx
     （@lobehub/icons-static-svg，MIT；24×24 grid）。gradient id 带 tt-brand- 前缀防冲突。
     Shell 用终端线图标。 */
  const AGENT_BRAND = {
    Claude:
      '<path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    Codex:
      '<defs><linearGradient id="tt-brand-codex-grad" x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse"><stop stopColor="#B1A7FF"/><stop offset=".5" stopColor="#7A9DFF"/><stop offset="1" stopColor="#3941FF"/></linearGradient></defs>' +
      '<path class="codex-tile" fill="#fff" d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"/>' +
      '<path fill="url(#tt-brand-codex-grad)" d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"/>',
    Gemini: (() => {
      const spark =
        "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";
      return (
        '<defs><linearGradient id="tt-brand-gemini-grad-green" x1="7" x2="11" y1="15.5" y2="12" gradientUnits="userSpaceOnUse"><stop stopColor="#08B962"/><stop offset="1" stopColor="#08B962" stopOpacity="0"/></linearGradient>' +
        '<linearGradient id="tt-brand-gemini-grad-red" x1="8" x2="11.5" y1="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#F94543"/><stop offset="1" stopColor="#F94543" stopOpacity="0"/></linearGradient>' +
        '<linearGradient id="tt-brand-gemini-grad-yellow" x1="3.5" x2="17.5" y1="13.5" y2="12" gradientUnits="userSpaceOnUse"><stop stopColor="#FABC12"/><stop offset=".46" stopColor="#FABC12" stopOpacity="0"/></linearGradient></defs>' +
        `<path d="${spark}" fill="#3186FF"/>` +
        `<path d="${spark}" fill="url(#tt-brand-gemini-grad-green)"/>` +
        `<path d="${spark}" fill="url(#tt-brand-gemini-grad-red)"/>` +
        `<path d="${spark}" fill="url(#tt-brand-gemini-grad-yellow)"/>`
      );
    })(),
  };
  function agentIcon(agent, cls = "brand-ico") {
    const brand = agent === "Claude Code" ? "Claude" : agent;
    const extra = {
      OpenCode: '<path fill="currentColor" fill-rule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/>',
      Kimi: '<path fill="#1783FF" d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"/><path fill="#1783FF" d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"/>',
      Grok: '<path fill="currentColor" fill-rule="evenodd" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/>',
    };
    const body = AGENT_BRAND[brand] || extra[brand];
    /* Shell 等：终端 ›_ 线图标（带上 .ico 的描边样式） */
    if (!body) return icon("terminal", cls + " ico");
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-agent-icon="${esc(brand.toLowerCase())}">${body.replaceAll('stopColor=', 'stop-color=').replaceAll('stopOpacity=', 'stop-opacity=')}</svg>`;
  }
  /* 侧栏图标槽：品牌/线图标 + 右下 8px 状态点叠加（dotCls 挂动效类，v9） */
  const bico = (inner, state, dotCls = "") =>
    `<span class="bico">${inner}<i class="bico-dot st-${state}${dotCls}"></i></span>`;

  const attrs = (obj) =>
    Object.entries(obj)
      .filter(([, v]) => v != null && v !== false)
      .map(([k, v]) => ` ${k}="${esc(v === true ? "" : v)}"`)
      .join("");
  const btn = (label, action, extra = {}, cls = "btn btn-ghost") =>
    `<button type="button" class="${cls}" data-action="${action}"${attrs(
      extra,
    )}>${label}</button>`;

  /* ==================== 状态五态（全产品统一） ==================== */
  const STATE_LABEL = {
    needs: "需要你",
    running: "运行中",
    failed: "失败",
    ended: "已结束",
    stalled: "停滞",
  };
  const chip = (state, label) =>
    `<span class="chip st-${state}">${esc(label || STATE_LABEL[state])}</span>`;

  /* ==================== 演示数据（移植自旧版） ==================== */
  const PROJECTS = {
    orbit: {
      name: "orbit-web",
      path: "D:/demo/orbit-web",
      color: "mint",
      files: ["src/checkout/FocusTrap.tsx", "tests/payment.spec.ts"],
      title: "把结账页的键盘焦点问题收个尾",
      note: "上次停在修复范围的选择上。两份差异和原会话都已放好。",
      file:
        "export function keepFocusInDialog(node: HTMLElement) {\n  const target = node.querySelector<HTMLElement>('[data-primary]');\n  target?.focus();\n}\n\n// This is a local prototype draft, not a real project file.\n",
    },
    pulse: {
      name: "pulse-api",
      path: "D:/demo/pulse-api",
      color: "blue",
      files: ["src/webhooks/retry.ts", "tests/retry.spec.ts"],
      title: "从 webhook 重试的最后输出继续",
      note: "会话已停止。先查看留下的错误与重试策略，再决定下一步。",
      file:
        "export const retryPolicy = {\n  attempts: 3,\n  backoff: [500, 1500, 4500],\n  retryOn: [429, 503],\n};\n\n// Demo data only; no request is sent.\n",
    },
    docs: {
      name: "docs-site",
      path: "D:/demo/docs-site",
      color: "amber",
      files: ["docs/navigation.md", "docs/getting-started.md"],
      title: "回到昨天整理好的导航文档",
      note: "完成记录已保留。可以回看输出，也可以从文档开始下一轮整理。",
      file:
        "# Navigation guide\n\n## Start with a project\nChoose a local folder, then open a session.\n\n## Find your way back\nKeep the project and source visible.\n",
    },
  };

  const WORKTREES = {
    "orbit-main": { id: "orbit-main", project: "orbit", branch: "main", path: "D:/demo/orbit-web", detail: "主工作树" },
    "orbit-checkout": { id: "orbit-checkout", project: "orbit", branch: "feature/checkout-a11y", path: "D:/demo/orbit-web-checkout", detail: "需要输入" },
    "orbit-hotfix": { id: "orbit-hotfix", project: "orbit", branch: "hotfix/payment-timeout", path: "D:/demo/orbit-web-payment-hotfix", detail: "有差异" },
    "orbit-missing": { id: "orbit-missing", project: "orbit", branch: "feature/legacy-migrate", path: "D:/demo/orbit-web-legacy", detail: "缺失 · 仅历史", missing: true },
    "orbit-clean": { id: "orbit-clean", project: "orbit", branch: "chore/demo-clean", path: "D:/demo/orbit-web-clean", detail: "空闲且干净", removable: true },
    "pulse-main": { id: "pulse-main", project: "pulse", branch: "retry/webhook", path: "D:/demo/pulse-api", detail: "连接中断" },
    "docs-main": { id: "docs-main", project: "docs", branch: "main", path: "D:/demo/docs-site", detail: "已完成" },
  };

  /* state：五态；detail：旧版细粒度状态（详情页二级信息） */
  const SEED_SESSIONS = [
    {
      id: "orbit-claude", project: "orbit", tree: "orbit-checkout",
      name: "checkout keyboard fix", agent: "Claude", command: "claude --resume",
      state: "needs", detail: "需要输入", time: "今天 14:21",
      summary: "等待确认：限制修复范围还是抽取共享组件？",
      output: [
        "Claude Code · orbit-web / feature/checkout-a11y",
        "› 排查结账弹窗的键盘焦点顺序",
        "",
        "读取 src/checkout/FocusTrap.tsx",
        "读取 tests/payment.spec.ts",
        "发现：嵌套弹窗关闭后，焦点未回到支付方式选项。",
        "",
        "已保留 2 份候选差异，等待你的下一步输入。",
        "需要你的决定：仅修复 checkout route，还是抽取为共享组件？",
      ],
    },
    {
      id: "orbit-shell", project: "orbit", tree: "orbit-checkout",
      name: "开发服务器", agent: "Shell", command: "pnpm dev",
      state: "running", detail: "运行中", time: "今天 14:09",
      summary: "本地开发服务会话，输出保留在此项目。",
      output: [
        "$ pnpm dev",
        "VITE · demo output",
        "Local: http://localhost:3000 (示例地址，不连接)",
        "",
        "watching src/checkout/",
        "等待文件变更…",
      ],
    },
    {
      id: "pulse-codex", project: "pulse", tree: "pulse-main",
      name: "retry webhook delivery", agent: "Codex", command: "codex resume",
      state: "failed", detail: "连接中断 · 已停止", time: "今天 13:57",
      summary: "连接中断；保留重试策略和最后输出，可查看后重新开始。",
      output: [
        "Codex · pulse-api / retry/webhook",
        "› 检查 webhook 重试时的幂等性",
        "",
        "读取 src/webhooks/retry.ts",
        "保留现有 3 次退避策略。",
        "需要确认：429 响应是否遵循 Retry-After？",
        "",
        "连接已中断，进程停止。最后输出仍保留。",
        "重新开始前请先检查本地配置（演示状态）。",
      ],
    },
    {
      id: "pulse-shell", project: "pulse", tree: "pulse-main",
      name: "API 检查", agent: "Shell", command: "pnpm test -- retry",
      state: "ended", detail: "已完成", time: "今天 13:40",
      summary: "本地测试命令的演示记录。",
      output: [
        "$ pnpm test -- retry",
        "Demo fixture: retry policy",
        "3 scenarios captured in this example.",
        "这是预置输出，不是真实测试结果。",
      ],
    },
    {
      id: "docs-gemini", project: "docs", tree: "docs-main",
      name: "navigation information architecture", agent: "Gemini", command: "gemini",
      state: "ended", detail: "已完成", time: "昨天 17:08",
      summary: "导航文档整理完成，已加入本地书签。",
      output: [
        "Gemini · docs-site / main",
        "› 整理首次使用与导航文档",
        "",
        "整理 docs/navigation.md",
        "补充 docs/getting-started.md",
        "",
        "建议目录：开始项目 → 使用会话 → 找回上下文。",
        "本次输出已保存为演示记录。",
      ],
    },
    {
      id: "orbit-hotfix-shell", project: "orbit", tree: "orbit-hotfix",
      name: "支付超时复核", agent: "Shell", command: "pnpm test -- payment",
      state: "running", detail: "运行中", time: "今天 13:48",
      summary: "payment hotfix 的本地演示会话。",
      output: [
        "$ pnpm test -- payment",
        "payment timeout fixture loaded",
        "等待审阅本地差异…",
      ],
    },
    {
      id: "orbit-missing-history", project: "orbit", tree: "orbit-missing",
      name: "迁移记录（缺失工作树）", agent: "Claude", command: "claude --resume",
      state: "stalled", detail: "目录缺失 · 仅历史", time: "昨天 16:02",
      summary: "原工作树不在本机；可阅读历史但不能继续。",
      output: [
        "这是一条只读的本地历史记录。",
        "原工作树目录不可用；不会自动迁移。",
      ],
    },
    {
      id: "orbit-clean-history", project: "orbit", tree: "orbit-clean",
      name: "清理前的完成记录", agent: "Shell", command: "git status --short",
      state: "ended", detail: "已完成", time: "昨天 15:18",
      summary: "可清理工作树的只读完成记录；移除目录后仍保留同一会话身份。",
      output: [
        "$ git status --short",
        "演示工作树为空闲且干净。",
        "这条历史会在模拟移除后继续保留。",
      ],
    },
    /* v13 数据口径：orbit-web = 5 工作树 / 9 会话（checkout 多会话占 Token 大头） */
    {
      id: "orbit-main-lint", project: "orbit", tree: "orbit-main",
      name: "依赖升级巡检", agent: "Shell", command: "pnpm outdated",
      state: "ended", detail: "已完成", time: "昨天 15:40",
      summary: "主工作树的依赖巡检记录。",
      output: [
        "$ pnpm outdated",
        "Demo fixture: dependency audit",
        "3 packages listed in this example.",
        "这是预置输出，不是真实巡检结果。",
      ],
    },
    {
      id: "orbit-main-perf", project: "orbit", tree: "orbit-main",
      name: "性能基线记录", agent: "Claude", command: "claude --resume",
      state: "ended", detail: "已完成", time: "昨天 14:10",
      summary: "结账页性能基线的完成记录。",
      output: [
        "Claude Code · orbit-web / main",
        "› 记录结账页性能基线",
        "",
        "LCP / INP 示例数据已归档。",
        "本次输出已保存为演示记录。",
      ],
    },
    {
      id: "orbit-checkout-extract", project: "orbit", tree: "orbit-checkout",
      name: "抽取共享焦点组件", agent: "Claude", command: "claude --resume",
      state: "running", detail: "运行中", time: "今天 14:02",
      summary: "正在把 FocusTrap 抽到共享层；Token 消耗集中在这棵树。",
      output: [
        "Claude Code · orbit-web / feature/checkout-a11y",
        "› 抽取 src/checkout/FocusTrap.tsx 为共享组件",
        "",
        "正在生成候选差异…",
        "这是预置输出，不连接真实模型。",
      ],
    },
    {
      id: "orbit-checkout-audit", project: "orbit", tree: "orbit-checkout",
      name: "结账 a11y 审计", agent: "Shell", command: "pnpm test -- a11y",
      state: "ended", detail: "已完成", time: "今天 13:30",
      summary: "结账页无障碍审计的完成记录。",
      output: [
        "$ pnpm test -- a11y",
        "Demo fixture: a11y audit",
        "4 scenarios captured in this example.",
        "这是预置输出，不是真实测试结果。",
      ],
    },
  ];

  /* kind：approval 待确认 / waiting 待输入 / failed 失败 / review 待复核 / stalled 停滞提醒 */
  const ATTENTION = [
    { id: "orbit-approval-focus", session: "orbit-claude", kind: "approval", title: "确认焦点修复范围", reason: "有两种修复方案，等待你的选择。" },
    { id: "orbit-input-checkout", session: "orbit-claude", kind: "waiting", title: "需要补充验收范围", reason: "请说明是否覆盖嵌套弹窗。" },
    { id: "pulse-failed-retry", session: "pulse-codex", kind: "failed", title: "重试连接已中断", reason: "保留最后输出；可先查看重试策略。" },
    { id: "docs-review-navigation", session: "docs-gemini", kind: "review", title: "导航文档待复核", reason: "完成结果尚未确认是否采用。" },
    { id: "orbit-stalled-server", session: "orbit-shell", kind: "stalled", idleMinutes: 45, title: "开发服务器长时间无新输出", reason: "仅提示，不代表失败或需要操作。" },
  ];
  const KIND_LABEL = { approval: "待确认", waiting: "待输入", failed: "失败", review: "待复核", stalled: "停滞" };
  const KIND_STATE = { approval: "needs", waiting: "needs", failed: "failed", review: "needs", stalled: "stalled" };

  const LAYOUT_NAME = { split: "终端 + 文件 + 上下文", focus: "专注终端", review: "差异审阅" };
  const PRESETS = [
    {
      id: "orbit", title: "结账问题排查", project: "orbit", layout: "split", filter: "needs", pro: true,
      commands: ["pnpm test -- checkout", "git diff -- src/checkout"],
      entries: [
        { tree: "orbit-checkout", session: "orbit-claude", view: "文件 · src/checkout/FocusTrap.tsx", layout: "split", commands: ["pnpm test -- checkout", "git diff -- src/checkout"] },
      ],
    },
    {
      id: "orbit-parallel", title: "结账功能与支付热修并行复核", project: "orbit", layout: "review", filter: "needs", pro: true,
      commands: ["pnpm test -- checkout", "git diff -- src/checkout", "pnpm test -- payment", "git diff -- tests/payment.spec.ts"],
      entries: [
        { tree: "orbit-checkout", session: "orbit-claude", view: "文件 · src/checkout/FocusTrap.tsx", layout: "split", commands: ["pnpm test -- checkout", "git diff -- src/checkout"] },
        { tree: "orbit-hotfix", session: "orbit-hotfix-shell", view: "差异 · tests/payment.spec.ts", layout: "review", commands: ["pnpm test -- payment", "git diff -- tests/payment.spec.ts"] },
      ],
    },
    {
      id: "pulse", title: "发布前 API 检查", project: "pulse", layout: "review", filter: "needs", pro: true,
      commands: ["pnpm test -- retry", "git diff -- src/webhooks", "pnpm lint"],
      entries: [
        { tree: "pulse-main", session: "pulse-codex", view: "终端", layout: "review", commands: ["pnpm test -- retry", "git diff -- src/webhooks", "pnpm lint"] },
      ],
    },
    {
      id: "docs", title: "文档整理", project: "docs", layout: "focus", filter: "all", pro: false,
      commands: [],
      entries: [
        { tree: "docs-main", session: "docs-gemini", view: "终端", layout: "focus", commands: [] },
      ],
    },
  ];

  /* ==================== 状态（localStorage 持久化 + 会话内） ==================== */
  const persisted = () => {
    const base = {
      theme: "light",
      bookmarks: ["docs-gemini"],
      followed: ["orbit-hotfix-shell", "orbit-shell", "docs-gemini"],
      ignored: [],
      resolved: [],
      ended: [],
      notifRead: [],
      userSessions: [],
      savedPresets: [],
      aliases: {},
      expanded: { orbit: true, pulse: true, docs: true },
      trial: false,
      stalledRule: { enabled: true, thresholdMinutes: 30 },
      welcomeSeen: false,
      userTrees: [], // 用户创建的模拟工作树
      removedTrees: [], // 已模拟移除的工作树（历史保留）
      archivedProjects: [], // 仅本应用收起，与 CLI 归档无关
      archivedTrees: [],
      archivedSessions: [],
      deletedProjects: [], // 仅从本应用目录移除
      deletedTrees: [],
      deletedSessions: [],
      featureStates: {}, // additive state owned by feature scripts
      userProjects: [],
      projectNames: {},
      pinnedProjects: [],
      projectOrder: [],
      sessionOrder: {},
      attentionEvents: [],
      pinnedSessionIds: [], // independent quick selector; distinct from follow/bookmark
      recentSessionIds: ["orbit-claude", "pulse-codex", "docs-gemini"],
    };
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!raw || typeof raw !== "object") return base;
      // Preserve additive feature fields during upgrades.  Core still validates
      // its own fields below, while independently registered features retain
      // their saved mock state.
      Object.assign(base, raw);
      if (!["dark", "light"].includes(base.theme)) base.theme = "light";
      if (!base.featureStates || typeof base.featureStates !== "object") base.featureStates = {};
      if (!Array.isArray(base.pinnedSessionIds)) base.pinnedSessionIds = [];
      if (!Array.isArray(base.recentSessionIds)) base.recentSessionIds = ["orbit-claude", "pulse-codex", "docs-gemini"];
      return base;
    } catch {
      return base;
    }
  };
  const store = persisted();
  /* User-added directories are mock-only projects.  A non-Git project gets a
     main directory tree, but no branch assumptions or Git actions. */
  for (const p of store.userProjects)
    if (p && typeof p.id === "string" && typeof p.name === "string" && !PROJECTS[p.id])
      PROJECTS[p.id] = { ...p, files: Array.isArray(p.files) && p.files.length ? p.files : ["README.md"], file: p.file || "# Local directory\n\nSynthetic prototype content.\n", nonGit: true, user: true };
  for (const [id, name] of Object.entries(store.projectNames || {}))
    if (PROJECTS[id] && typeof name === "string" && name.trim()) PROJECTS[id].name = name.trim().slice(0, 60);
  /* 恢复用户创建的模拟工作树 */
  for (const t of store.userTrees)
    if (t && typeof t.id === "string" && PROJECTS[t.project] && !WORKTREES[t.id])
      WORKTREES[t.id] = { ...t, user: true };
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      /* 离线原型：存储不可用时保持内存态 */
    }
  };

  /* 会话内状态（筛选、工作区视图、演示日志等，不持久化） */
  const ui = {
    route: { name: "workbench" },
    origin: null, // 进入工作区前的位置 { name, label, param }
    inboxFilter: "all",
    tFilters: { query: "", project: "all", tree: "all", status: "all", layout: "cards" },
    tHighlight: "",
    tInspect: "",
    wsTab: "terminal",
    wsFile: 0,
    wsTiles: [], // 并排格子：同工作树会话 id，1–4；空则仅当前会话
    wsInspector: false,
    switchFilter: { query: "", status: "all", needs: false },
    logs: {}, // sessionId -> 追加的演示输出行
    drafts: {}, // treeId:file -> 未保存草稿
    files: {}, // treeId:file -> 已保存内容
    pendingByTree: {}, // treeId -> 待审阅命令
    termDrafts: {}, // sessionId -> 终端/浮窗输入草稿
    float: { sessionId: "", visibility: "closed", pinned: false }, // 浮动终端层
    composer: { text: "", project: "orbit", tree: "orbit-checkout", agent: "Claude" }, // 起始页创建框
    presetLayout: null, // v8：预设布局态 { title, entries }，null = 普通工作区
    briefHideFocus: false, // 项目主页演示态——true 时收起「需要关注」区
    sidebarScope: "all",
  };
  const isEnglish = () => store.featureStates?.settings?.appearance?.language === "en";
  const tr = (zh, en) => (isEnglish() ? en : zh);

  /* Extension lifecycle.  Feature scripts register after the legacy shell has
     loaded; callbacks deliberately receive stable references rather than copies. */
  const beforeRenderHooks = new Set();
  const renderHooks = new Set();
  const resetHooks = new Set();
  const menuExtensions = new Map();
  const contentSlots = new Map();
  let creatorExtension = null;
  let terminatorExtension = null;
  const safelyRun = (callback, context) => {
    try { callback(context); } catch (error) { console.error("ThreadTerm prototype extension failed", error); }
  };
  const addHook = (hooks, callback) => {
    if (typeof callback !== "function") throw new TypeError("ThreadTermPrototype hook must be a function");
    hooks.add(callback);
    return () => hooks.delete(callback);
  };
  const resetPrototype = () => {
    resetHooks.forEach((callback) => safelyRun(callback, { store, ui }));
    closeDialog(false); closePopover();
    try { localStorage.removeItem(KEY); } catch { /* storage may be unavailable */ }
    // A reload clears transient drafts, mounted editor instances, timers, and
    // additive feature state together, while leaving v1/source namespaces intact.
    location.hash = "#/workbench";
    location.reload();
  };
  const appendMenuExtensions = (kind, context) => {
    const callbacks = menuExtensions.get(kind);
    if (!callbacks?.size) return "";
    return [...callbacks]
      .map((callback) => {
        try {
          const result = callback(context);
          return typeof result === "string" ? result : result?.html || "";
        } catch (error) {
          console.error("ThreadTerm prototype menu extension failed", error);
          return "";
        }
      })
      .filter(Boolean)
      .join("");
  };
  const renderContentSlot = (kind, context) => {
    const callbacks = contentSlots.get(kind);
    if (!callbacks?.size) return null;
    for (const callback of [...callbacks].reverse()) {
      try {
        const result = callback(context);
        if (typeof result === "string") return result;
      } catch (error) {
        console.error("ThreadTerm prototype content slot failed", error);
      }
    }
    return null;
  };

  /* ==================== 派生数据 ==================== */
  const sessions = () => [...SEED_SESSIONS, ...store.userSessions];
  const orderedProjectIds = () => {
    const known = Object.keys(PROJECTS).filter(isSidebarProject);
    const explicit = store.projectOrder.filter((id) => known.includes(id));
    const remainder = known.filter((id) => !explicit.includes(id));
    return [...explicit, ...remainder].sort((a, b) => {
      const pin = Number(store.pinnedProjects.includes(b)) - Number(store.pinnedProjects.includes(a));
      return pin || [...explicit, ...remainder].indexOf(a) - [...explicit, ...remainder].indexOf(b);
    });
  };
  const sessionById = (id) => sessions().find((s) => s.id === id);
  const treeOf = (item) => WORKTREES[item.tree];
  const displayName = (item) => store.aliases[item.id] || item.name;
  const isEnded = (item) => store.ended.includes(item.id);
  const isRemovedTree = (treeId) => store.removedTrees.includes(treeId);
  /* 目录缺失或被模拟移除的会话：只读历史，不可继续 */
  const isMissing = (item) => Boolean(treeOf(item)?.missing) || isRemovedTree(item.tree);
  const isUnavailable = (item) => !item || isEnded(item) || isMissing(item);
  /* 五态展示：用户手动结束的会话覆盖为「已结束」 */
  const stateOf = (item) => (isEnded(item) ? "ended" : item.state === "retrying" ? "running" : item.state);
  const isFollowed = (id) => store.followed.includes(id);
  const pinnedSessions = () => store.pinnedSessionIds.map(sessionById).filter((item) => item && !isCatalogGoneSession(item));
  const recentSessions = () => {
    const saved = store.recentSessionIds.map(sessionById).filter((item) => item && !isCatalogGoneSession(item));
    const fallback = sessions().filter((item) => !isCatalogGoneSession(item) && !saved.includes(item));
    return [...saved, ...fallback].slice(0, 6);
  };
  const recordVisit = (id) => {
    store.recentSessionIds = [id, ...store.recentSessionIds.filter((value) => value !== id)].slice(0, 12);
    save();
  };
  const activityRank = (item) => ({ needs: 0, failed: 1, running: 2, stalled: 3, ended: 4 })[stateOf(item)] ?? 5;
  const isDeletedProject = (id) => store.deletedProjects.includes(id);
  const isDeletedTree = (id) => store.deletedTrees.includes(id);
  const isDeletedSession = (id) => store.deletedSessions.includes(id);
  const isArchivedProject = (id) => store.archivedProjects.includes(id);
  const isArchivedTree = (id) => store.archivedTrees.includes(id);
  const isArchivedSession = (id) => store.archivedSessions.includes(id);
  const isCatalogGoneTree = (id) => {
    const t = WORKTREES[id];
    return !t || isDeletedTree(id) || isDeletedProject(t.project);
  };
  const isCatalogGoneSession = (s) =>
    !s || isDeletedSession(s.id) || isCatalogGoneTree(s.tree);
  const isSidebarProject = (id) =>
    Boolean(PROJECTS[id]) && !isDeletedProject(id) && !isArchivedProject(id);
  const isSidebarTree = (id) => {
    const t = WORKTREES[id];
    return Boolean(t) && !isRemovedTree(id) && !isCatalogGoneTree(id) && !isArchivedTree(id) && !isArchivedProject(t.project);
  };
  const isSidebarSession = (s) =>
    Boolean(s) && !isCatalogGoneSession(s) && !isArchivedSession(s.id) && isSidebarTree(s.tree);
  function selectedScope() {
    const value = ui.sidebarScope || "all";
    const project = value.startsWith("project:") ? value.slice(8) : WORKTREES[value]?.project;
    const tree = value.startsWith("project:") ? "" : WORKTREES[value]?.id || "";
    if (!project || !PROJECTS[project]) return { project: "", tree: "", label: tr("全部项目", "All projects") };
    return { project, tree, label: tree ? `${PROJECTS[project].name} · ${WORKTREES[tree].branch}` : PROJECTS[project].name };
  }
  const matchesSelectedScope = (item) => {
    const scope = selectedScope();
    return (!scope.project || item.project === scope.project) && (!scope.tree || item.tree === scope.tree);
  };
  const isWorkingSession = (s) =>
    Boolean(s) && !isCatalogGoneSession(s) && !isArchivedSession(s.id) && !isArchivedTree(s.tree);
  const archivedTreesOf = (projectId) =>
    Object.values(WORKTREES).filter(
      (t) => t.project === projectId && isArchivedTree(t.id) && !isDeletedTree(t.id),
    );
  const archivedSessionsOf = (treeId) =>
    sessions().filter((s) => s.tree === treeId && isArchivedSession(s.id) && !isDeletedSession(s.id));
  const catalogLabel = (kind, id) => {
    if (kind === "project") return PROJECTS[id]?.name || id;
    if (kind === "tree") return WORKTREES[id]?.branch || id;
    const item = sessionById(id);
    return item ? displayName(item) : id;
  };
  const CATALOG_SCOPE =
    "只影响 ThreadTerm 的工作列表。不会调用 Agent CLI 的归档或删除，也不会改动磁盘上的 Git 目录。";

  const attentionSource = () => [...ATTENTION, ...(store.attentionEvents || [])];
  const attentionItems = () =>
    attentionSource().filter(
      (ep) =>
        !store.ignored.includes(ep.id) && !store.resolved.includes(ep.id),
    )
      .map((ep) => ({ ...ep, item: sessionById(ep.session) }))
      .filter(
        (ep) =>
          ep.item &&
          isWorkingSession(ep.item) &&
          !isEnded(ep.item) &&
          (ep.kind !== "stalled" ||
            (store.stalledRule.enabled &&
              ep.idleMinutes >= store.stalledRule.thresholdMinutes)),
      );
  const actionableAttention = () => attentionItems().filter((ep) => ep.kind !== "stalled");
  const stalledAttention = () => attentionItems().filter((ep) => ep.kind === "stalled");
  const inboxCount = () => actionableAttention().length;
  const publishAttention = ({ session, kind = "review", title, reason = "本地演示事件", identity = "" } = {}) => {
    if (!sessionById(session)) throw new Error("attention event requires an existing session");
    if (!KIND_STATE[kind]) throw new Error(`unsupported attention kind: ${kind}`);
    const id = identity ? `event-${session}-${identity}` : `event-${session}-${Date.now()}`;
    const existing = store.attentionEvents.find((event) => event.id === id);
    if (existing) return existing;
    const event = { id, session, kind, title: String(title || "需要关注的模拟事件").slice(0, 120), reason: String(reason).slice(0, 180), idleMinutes: 0 };
    store.attentionEvents.push(event);
    save();
    return event;
  };

  /* worktree 五态：需要你 > 失败 > 运行中 > 停滞 > 已结束/空闲 */
  function treeState(tree) {
    if (tree.missing || isRemovedTree(tree.id)) return "stalled";
    const list = sessions().filter((s) => s.tree === tree.id && isWorkingSession(s));
    const live = list.filter((s) => !isUnavailable(s));
    const states = live.map(stateOf);
    if (states.includes("needs")) return "needs";
    if (states.includes("failed")) return "failed";
    if (states.includes("running")) return "running";
    if (states.includes("stalled")) return "stalled";
    return "ended";
  }
  /* 移除工作树的拦截理由（对照旧版 removeTree 逻辑） */
  function removeTreeReasons(tree) {
    const reasons = [];
    if (tree.id === "orbit-main") reasons.push("主工作树不能移除");
    else if (!tree.user && !tree.removable) reasons.push("这是受保护的演示工作树");
    if (sessions().some((s) => s.tree === tree.id && !isEnded(s) && ["running", "needs"].includes(stateOf(s))))
      reasons.push("仍有运行中的会话");
    if (Object.keys(ui.drafts).some((key) => key.startsWith(tree.id + ":")))
      reasons.push("存在未保存草稿");
    if (tree.detail.includes("差异")) reasons.push("存在未提交的演示差异");
    return reasons;
  }
  const treeNeedsCount = (tree) =>
    sessions().filter((s) => s.tree === tree.id && isWorkingSession(s) && !isUnavailable(s) && stateOf(s) === "needs").length;
  const projectNeedsCount = (projectId) =>
    sessions().filter((s) => s.project === projectId && isWorkingSession(s) && !isUnavailable(s) && stateOf(s) === "needs").length;
  const projectState = (projectId) => {
    const trees = Object.values(WORKTREES).filter(
      (t) => t.project === projectId && !isRemovedTree(t.id) && !isCatalogGoneTree(t.id) && !isArchivedTree(t.id),
    );
    const states = trees.map(treeState);
    for (const s of ["needs", "failed", "running", "stalled"]) if (states.includes(s)) return s;
    return "ended";
  };
  /* worktree 行的 title 提示：状态细节收进提示，不折行 */
  function treeTitle(tree) {
    const list = sessions().filter((s) => s.tree === tree.id && isWorkingSession(s));
    const needs = treeNeedsCount(tree);
    const parts = [];
    if (needs) parts.push(`${STATE_LABEL.needs} · ${needs} 会话`);
    else if (isRemovedTree(tree.id)) parts.push("目录已移除 · 仅历史");
    else parts.push(`${STATE_LABEL[treeState(tree)]} · ${list.length} 会话`);
    parts.push(tree.path);
    return parts.join(" · ");
  }

  const AGENTS = ["Claude", "Codex", "Gemini", "Shell"];

  /* v14 恢复：项目页用量 mock（确定性常量，刷新不漂移）。Token 按工作树对得上；Shell 用时长，不和 Token 画成同一根饼。 */
  const PROJECT_USAGE = {
    orbit: {
      todayTokens: 1_240_000,
      todayCost: 19.8,
      weekTokens: 6_480_000,
      weekCost: 97.29,
      weekSeries: [620000, 780000, 910000, 1050000, 1240000, 880000, 1000000],
      trees: [
        { tree: "orbit-checkout", tokens: 5_200_000, shellHours: 4.2 },
        { tree: "orbit-hotfix", tokens: 240_000, shellHours: 18.4 },
        { tree: "orbit-missing", tokens: 320_000, shellHours: 0 },
        { tree: "orbit-main", tokens: 400_000, shellHours: 1.6 },
        { tree: "orbit-clean", tokens: 320_000, shellHours: 0.5 },
      ],
      agents: [
        { agent: "Claude", kind: "tokens", tokens: 6_400_000, cost: 97.29 },
        { agent: "Shell", kind: "hours", hours: 18.4 },
      ],
      sparks: {
        running24h: [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
        stalled24h: [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0],
        attention24h: [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1],
        trees7d: [5, 5, 5, 5, 5, 5, 5],
        sessions7d: [7, 7, 8, 8, 9, 9, 9],
      },
    },
    pulse: {
      todayTokens: 180_000,
      todayCost: 2.7,
      weekTokens: 890_000,
      weekCost: 13.35,
      weekSeries: [90000, 120000, 80000, 160000, 180000, 110000, 150000],
      trees: [{ tree: "pulse-main", tokens: 890_000, shellHours: 2.1 }],
      agents: [
        { agent: "Codex", kind: "tokens", tokens: 860_000, cost: 13.35 },
        { agent: "Shell", kind: "hours", hours: 2.1 },
      ],
      sparks: {
        running24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        stalled24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        attention24h: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1],
        trees7d: [1, 1, 1, 1, 1, 1, 1],
        sessions7d: [1, 2, 2, 2, 2, 2, 2],
      },
    },
    docs: {
      todayTokens: 40_000,
      todayCost: 0.6,
      weekTokens: 210_000,
      weekCost: 3.15,
      weekSeries: [20000, 30000, 30000, 40000, 40000, 20000, 30000],
      trees: [{ tree: "docs-main", tokens: 210_000, shellHours: 0.4 }],
      agents: [
        { agent: "Gemini", kind: "tokens", tokens: 210_000, cost: 3.15 },
        { agent: "Shell", kind: "hours", hours: 0.4 },
      ],
      sparks: {
        running24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        stalled24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        attention24h: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
        trees7d: [1, 1, 1, 1, 1, 1, 1],
        sessions7d: [1, 1, 1, 1, 1, 1, 1],
      },
    },
  };
  /* 会话用量：与上面工作树合计对齐（checkout 5.2M / 4.2h 等） */
  const SESSION_USAGE = {
    "orbit-claude": { tokens: 2_340_000, hours: 0 },
    "orbit-shell": { tokens: 0, hours: 3.1 },
    "orbit-checkout-extract": { tokens: 2_860_000, hours: 0 },
    "orbit-checkout-audit": { tokens: 0, hours: 1.1 },
    "orbit-hotfix-shell": { tokens: 240_000, hours: 18.4 },
    "orbit-missing-history": { tokens: 320_000, hours: 0 },
    "orbit-main-lint": { tokens: 0, hours: 1.6 },
    "orbit-main-perf": { tokens: 400_000, hours: 0 },
    "orbit-clean-history": { tokens: 320_000, hours: 0.5 },
    "pulse-codex": { tokens: 860_000, hours: 0 },
    "pulse-shell": { tokens: 30_000, hours: 2.1 },
    "docs-gemini": { tokens: 210_000, hours: 0.4 },
  };
  const ZERO_SPARK_24H = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  function fmtTok(n) {
    if (!n) return "0";
    if (n >= 1e5) {
      const m = n / 1e6;
      return `${(m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, "")}M`;
    }
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  }
  function fmtYen(n) {
    return `¥${n.toFixed(2)}`;
  }
  function sparkline(values, { w = 72, h = 18, fill = false } = {}) {
    const n = values.length;
    if (!n) return "";
    const padX = 1;
    const padY = 2;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const flat = max === min;
    const pts = values.map((v, i) => {
      const x = padX + (n === 1 ? (w - padX * 2) / 2 : (i / (n - 1)) * (w - padX * 2));
      const y = flat
        ? (max === 0 ? h - padY : h / 2)
        : padY + (1 - (v - min) / (max - min)) * (h - padY * 2);
      return [x, y];
    });
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    const area = fill
      ? `<path d="${d} L${last[0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z" fill="currentColor" opacity="0.18"/>`
      : "";
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">${area}<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="1.35" fill="currentColor"/></svg>`;
  }
  function usageFor(projectId) {
    const base = PROJECT_USAGE[projectId] || {
      todayTokens: 0,
      todayCost: 0,
      weekTokens: 0,
      weekCost: 0,
      weekSeries: [0, 0, 0, 0, 0, 0, 0],
      trees: [],
      agents: [],
      sparks: {
        running24h: ZERO_SPARK_24H,
        stalled24h: ZERO_SPARK_24H,
        attention24h: ZERO_SPARK_24H,
        trees7d: [1, 1, 1, 1, 1, 1, 1],
        sessions7d: [1, 1, 1, 1, 1, 1, 1],
      },
    };
    const trees = Object.values(WORKTREES).filter(
      (t) => t.project === projectId && !isRemovedTree(t.id) && !isCatalogGoneTree(t.id) && !isArchivedTree(t.id),
    );
    const byId = Object.fromEntries((base.trees || []).map((row) => [row.tree, row]));
    const weekTokens = base.weekTokens || 0;
    return {
      ...base,
      trees: trees.map((t) => {
        const row = byId[t.id] || { tree: t.id, tokens: 0, shellHours: 0 };
        return {
          ...row,
          branch: t.branch,
          share: weekTokens ? (row.tokens || 0) / weekTokens : 0,
        };
      }),
    };
  }
  /* 用量单独一张卡：今日/近 7 日并排，明细在卡头（Plausible/Tremor 相关指标同卡）。 */
  function usageStrip({ label, todayTokens, todayCost, weekTokens, weekCost, weekSeries, details = "" }) {
    const series = weekSeries?.length ? weekSeries : [0, 0, 0, 0, 0, 0, 0];
    return `<aside class="usage-panel${details ? "" : " no-details"}" aria-label="${esc(label)}">
      <div class="usage-card-head">
        <span class="metric-label">${esc(label)}</span>
        ${details}
      </div>
      <div class="usage-card-body">
        <div class="usage-stat">
          <span class="metric-label">今日<i>${fmtYen(todayCost)}</i></span>
          <b class="tnum">${fmtTok(todayTokens)}</b>
        </div>
        <div class="usage-stat">
          <span class="metric-label">近 7 日<i>${fmtYen(weekCost)}</i></span>
          <b class="tnum">${fmtTok(weekTokens)}</b>
        </div>
      </div>
      <span class="spark-wrap" title="近 7 日 Token 总量">${sparkline(series, { w: 180, h: 20, fill: true })}</span>
    </aside>`;
  }
  function usagePanel(projectId) {
    const usage = usageFor(projectId);
    return usageStrip({
      label: "本项目用量",
      todayTokens: usage.todayTokens,
      todayCost: usage.todayCost,
      weekTokens: usage.weekTokens,
      weekCost: usage.weekCost,
      weekSeries: usage.weekSeries,
      details: btn("明细", "usage-details", { "data-project": projectId }, "btn btn-ghost brief-head-btn"),
    });
  }
  function openUsageDetails(projectId, invoker) {
    const project = PROJECTS[projectId];
    if (!project) return;
    const prices = (store.featureStates.coreUsage ||= { prices: { Claude: 15, Codex: 12, Gemini: 3, Unknown: 0 } }).prices;
    const rows = sessions().filter((item) => item.project === projectId).map((item, index) => ({
      id: item.id, time: index % 2 ? "7d" : "today", provider: item.agent, model: `${item.agent} · demo`, result: stateOf(item), source: "会话快照", tokens: SESSION_USAGE[item.id]?.tokens || 0, requests: index % 3 + 1, success: stateOf(item) === "failed" ? 0 : 1, cacheRate: item.agent === "Shell" ? null : 0.2,
    }));
    rows.push({ id: "unattributed", time: "7d", provider: "Unknown", model: "未知模型", result: "unknown", source: "未归属用量", tokens: 0, requests: null, success: null, cacheRate: null });
    const option = (key) => [...new Set(rows.map((row) => row[key]))].map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
    const body = `<div class="sheet-filters">
        <div class="sheet-chip-row" role="group" aria-label="时间范围">
          <button type="button" class="sheet-chip" data-usage-chip="time" data-value="all" aria-pressed="true">全部</button>
          <button type="button" class="sheet-chip" data-usage-chip="time" data-value="today" aria-pressed="false">今日</button>
          <button type="button" class="sheet-chip" data-usage-chip="time" data-value="7d" aria-pressed="false">近 7 日</button>
          <select hidden data-usage-filter="time"><option value="all" selected>全部</option><option value="today">今日</option><option value="7d">近 7 日</option></select>
        </div>
        <div class="sheet-filter-grid">
          <select data-usage-filter="provider" aria-label="提供者"><option value="all">全部提供者</option>${option("provider")}</select>
          <select data-usage-filter="model" aria-label="模型"><option value="all">全部模型</option>${option("model")}</select>
          <select data-usage-filter="result" aria-label="结果"><option value="all">全部结果</option>${option("result")}</select>
          <select data-usage-filter="source" aria-label="来源"><option value="all">全部来源</option>${option("source")}</select>
        </div>
      </div>
      <div class="sheet-scroll">
        <div data-usage-rows></div>
        <h3 class="sheet-section-label">每百万 Token 估算单价（¥）</h3>
        <div class="usage-price-grid">${Object.entries(prices).map(([provider, price]) => `<label>${esc(provider)}<input data-usage-price="${esc(provider)}" type="number" min="0" step="0.1" value="${Number(price)}"></label>`).join("")}</div>
      </div>`;
    const root = openDialog("用量明细", project.name, body, "", { invoker, sheet: "wide", icon: "spark", tone: "primary" });
    let page = 0;
    const draw = () => {
      const selected = Object.fromEntries([...root.querySelectorAll("[data-usage-filter]")].map((el) => [el.dataset.usageFilter, el.value]));
      const filtered = rows.filter((row) => Object.entries(selected).every(([key, value]) => value === "all" || row[key] === value));
      const perPage = 5, pages = Math.max(1, Math.ceil(filtered.length / perPage)); page = Math.min(page, pages - 1);
      const slice = filtered.slice(page * perPage, page * perPage + perPage);
      const tokens = filtered.reduce((sum, row) => sum + row.tokens, 0), requests = filtered.reduce((sum, row) => sum + (row.requests || 0), 0), known = filtered.filter((row) => row.success != null), success = known.length ? `${Math.round(known.reduce((sum, row) => sum + row.success, 0) / known.length * 100)}%` : "未知", cache = filtered.filter((row) => row.cacheRate != null);
      const cacheRate = cache.length ? `${Math.round(cache.reduce((sum, row) => sum + row.cacheRate, 0) / cache.length * 100)}%` : "未知";
      const estimate = filtered.reduce((sum, row) => sum + row.tokens / 1e6 * (prices[row.provider] ?? prices.Unknown ?? 0), 0);
      const logs = slice.map((row) => {
        const cost = row.tokens / 1e6 * (prices[row.provider] ?? prices.Unknown ?? 0);
        return `<article class="usage-log">
          <div class="usage-log-top"><b>${esc(row.model)}</b><span class="usage-log-status st-${esc(row.result)}">${esc(STATE_LABEL[row.result] || row.result)}</span></div>
          <div class="usage-log-meta"><span>${row.time === "today" ? "今日" : "近 7 日"} · ${esc(row.provider)} · ${esc(row.source)} · ${fmtTok(row.tokens)}</span><span>${row.tokens ? `¥${cost.toFixed(2)}` : "未定价"}</span></div>
        </article>`;
      }).join("");
      $("[data-usage-rows]", root).innerHTML = `<p class="note">合成口径：${requests || "未知"} 请求 · 成功率 ${success} · 缓存率 ${cacheRate} · 估算 ¥${estimate.toFixed(2)}</p>
        <div class="usage-summary"><b>¥${estimate.toFixed(2)}</b><p>${fmtTok(tokens)} Token · ${requests || 0} 请求 · ${filtered.length} 条记录</p><div class="usage-summary-grid"><span>成功率 ${success}</span><span>缓存命中 ${cacheRate}</span></div></div>
        <h3 class="sheet-section-label">请求记录</h3>
        ${logs || "<p class='sheet-empty-copy'>没有符合筛选的用量记录。</p>"}
        <div class="page-actions"><span class="dim">${filtered.length} 条 · 第 ${page + 1}/${pages} 页</span>${btn("上一页", "usage-page", { "data-direction": "-1", disabled: page === 0 }, "btn")}${btn("下一页", "usage-page", { "data-direction": "1", disabled: page >= pages - 1 }, "btn")}</div>`;
    };
    root.addEventListener("change", (event) => { const el = event.target; if (el.matches("[data-usage-filter]")) { page = 0; draw(); } if (el.matches("[data-usage-price]")) { prices[el.dataset.usagePrice] = Math.max(0, Number(el.value) || 0); save(); draw(); toast("已更新本地估算单价；历史记录没有改动。"); } });
    root.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-usage-chip]");
      if (chip) {
        const select = root.querySelector(`[data-usage-filter="${chip.dataset.usageChip}"]`);
        if (select) select.value = chip.dataset.value;
        root.querySelectorAll(`[data-usage-chip="${chip.dataset.usageChip}"]`).forEach((node) => node.setAttribute("aria-pressed", String(node === chip)));
        page = 0;
        draw();
        return;
      }
      const pager = event.target.closest('[data-action="usage-page"]');
      if (pager) { page += Number(pager.dataset.direction); draw(); }
    });
    draw();
  }
  function openActivityAll({ project, tree } = {}, invoker) {
    const scope = PROJECTS[project];
    const branch = tree ? WORKTREES[tree] : null;
    if (!scope) return;
    const entries = activityEntries({ project, tree });
    const title = branch ? `${scope.name} · ${branch.branch}` : scope.name;
    const body = `<div class="sheet-filters">
        <div class="sheet-chip-row" role="group" aria-label="活动筛选">
          <button type="button" class="sheet-chip" data-activity-filter="all" aria-pressed="true">全部</button>
          <button type="button" class="sheet-chip" data-activity-filter="today" aria-pressed="false">今天</button>
          <button type="button" class="sheet-chip" data-activity-filter="yesterday" aria-pressed="false">昨天</button>
        </div>
      </div>
      <div class="sheet-scroll" data-testid="project-activity"><div data-activity-rows></div></div>`;
    const root = openDialog("最近活动", "仅展示本地保留记录，不是完整审计历史。", body, "", { invoker, sheet: "wide", icon: "clock", tone: "info", count: entries.length });
    let filter = "all";
    const draw = () => {
      const visible = entries.filter((item) => filter === "all" || (filter === "today" ? item.time.startsWith("今天") : item.time.startsWith("昨天")));
      if (!visible.length) {
        $("[data-activity-rows]", root).innerHTML = `<div class="sheet-empty"><span class="sheet-icon sheet-icon-info">${icon("clock")}</span><p>这个范围内还没有活动记录。</p></div>`;
        return;
      }
      $("[data-activity-rows]", root).innerHTML = visible.map((item) => {
        const tree = treeOf(item);
        return `<button type="button" class="sheet-card activity-row" data-action="activity-open" data-session="${item.id}">
          <span class="sheet-card-icon">${agentIcon(item.agent)}</span>
          <span class="sheet-card-main">
            <strong>${esc(displayName(item))}</strong>
            <small>${verbOf(item)} · ${esc(tree?.branch || "目录不可用")} · ${esc(item.agent)}</small>
          </span>
          <span class="sheet-card-time">${esc(item.time)}</span>
        </button>`;
      }).join("");
    };
    root.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-activity-filter]");
      if (!chip) return;
      filter = chip.dataset.activityFilter;
      root.querySelectorAll("[data-activity-filter]").forEach((node) => node.setAttribute("aria-pressed", String(node === chip)));
      draw();
    });
    draw();
  }

  /* v7：预设布局示意 = 按 entries 数据驱动渲染（卡片 / 预览对话框 / 新建对话框共用）。
     每条 entry 一栏；栏内按 entry.layout 拼 pane（split=终端+上下文、review=差异+上下文、focus=单终端）；
     pane 标题用真实内容：会话名 + agent 品牌图标 / entry.view 里的文件名。 */
  function presetMap(preset, { entries = preset.entries, large = false } = {}) {
    const paneTitle = (entry, kind) => {
      const session = sessionById(entry.session);
      const viewFile = String(entry.view || "").split(" · ")[1]?.split("/").at(-1) || "";
      if (kind === "terminal")
        return `${agentIcon(session?.agent || "Shell")}<span>${esc(session ? displayName(session) : "会话")}</span>`;
      if (kind === "diff") return `${icon("branch")}<span>${esc(viewFile || "差异")}</span>`;
      return `${icon("layers")}<span>${esc(entry.layout === "split" && viewFile ? viewFile : "上下文")}</span>`;
    };
    const cols = entries
      .map((entry) => {
        const tree = WORKTREES[entry.tree];
        const kinds =
          entry.layout === "focus" ? ["terminal"]
          : entry.layout === "review" ? ["diff", "context"]
          : ["terminal", "context"];
        const panes = kinds
          .map(
            (kind) =>
              `<div class="pm-pane"><span class="pm-title">${paneTitle(entry, kind)}</span><i></i><i class="short"></i></div>`,
          )
          .join("");
        return `<div class="pm-col">${
          large ? `<div class="pm-branch">${icon("branch")}${esc(tree?.branch || entry.tree)}</div>` : ""
        }<div class="pm-panes ${entry.layout}">${panes}</div></div>`;
      })
      .join("");
    const colCount = Math.min(Math.max(entries.length, 1), 3);
    return `<div class="preset-map cols-${colCount}${large ? " large" : ""}" aria-hidden="true">${cols}</div>`;
  }

  /* v9：侧栏会话行状态叠点动效类——运行中=呼吸（pulse），需要你=扩散环（ping），可同时叠加 */
  const sessAnim = (s) =>
    (stateOf(s) === "running" ? " pulse" : "") +
    (stateOf(s) === "needs" || attentionItems().some((ep) => ep.session === s.id && ep.kind !== "stalled") ? " ping" : "");

  const ROUTES = ["workbench", "inbox", "terminals", "presets", "pro", "workspace", "project", "worktree"];
  const ROUTE_TITLE = {
    workbench: "工作台",
    inbox: "待处理",
    terminals: "所有终端",
    presets: "工作预设",
    pro: "Local Pro",
  };

  /* 侧栏承载一切：品牌行 / 导航 / 三级项目树 / 最近 / 用户行 */
  function sidebar() {
    const unread = actionableAttention().filter(
      (ep) => !store.notifRead.includes(ep.id),
    ).length;

    /* 导航：新建终端为首项（等同"新对话"形态） */
    const nav =
      `<button type="button" class="nav-item new" data-action="open-create" aria-label="${tr("新建终端", "New terminal")}">${icon("plus")}<span class="grow">${tr("新建终端", "New terminal")}</span></button>` +
      [
        ["inbox", tr("待处理", "Inbox"), "inbox"],
        ["terminals", tr("所有终端", "All terminals"), "terminal"],
        ["presets", tr("工作预设", "Work presets"), "layers"],
      ]
        .map(([route, label, glyph]) => {
          const active = ui.route.name === route;
          const badge =
            route === "inbox" && inboxCount()
              ? `<span class="badge amber" aria-label="${inboxCount()} 项待处理">${inboxCount()}</span>`
              : "";
          return `<button type="button" class="nav-item${active ? " active" : ""}" data-action="nav" data-route="${route}" aria-current="${active ? "page" : false}">${icon(glyph)}<span class="grow">${label}</span>${badge}</button>`;
        })
        .join("");

    /* 三级树：项目 → worktree（状态点+徽章）→ 会话（状态点+名称） */
    const currentSessionId = ui.route.name === "workspace" ? ui.route.sessionId : "";
    const currentTreeId =
      ui.route.name === "worktree"
        ? ui.route.treeId
        : sessionById(currentSessionId)?.tree || "";
    const rowMore = (action, extra, label) =>
      btn(icon("more"), action, { ...extra, "aria-label": label, "aria-expanded": "false", title: "管理" }, "icon-btn row-more");
    const scope = selectedScope();
    const expandedBranchLists = (store.featureStates.sidebarLists ||= {});
    const tree = orderedProjectIds().filter((pid) => !scope.project || scope.project === pid)
      .map((pid) => {
        const p = PROJECTS[pid];
        const expanded = store.expanded[pid] !== false;
        const needs = projectNeedsCount(pid);
        const archivedN = archivedTreesOf(pid).length;
        const allTrees = Object.values(WORKTREES).filter((t) => t.project === pid && isSidebarTree(t.id) && (!scope.tree || t.id === scope.tree));
        const showAll = Boolean(expandedBranchLists[pid]) || allTrees.findIndex((t) => t.id === currentTreeId) >= 8;
        const rows = (showAll ? allTrees : allTrees.slice(0, 8))
          .map((t) => {
            const list = sessions().filter((s) => s.tree === t.id && isSidebarSession(s));
            const current = currentTreeId === t.id;
            const countBadge = list.length
              ? `<span class="badge">${list.length}</span>`
              : "";
            const sessRows = list
              .map(
                (s) =>
                  `<div class="sess-row-wrap">
                    <button type="button" class="sess-row${s.id === currentSessionId ? " active" : ""}" data-action="open-session" data-session="${s.id}" title="${esc(displayName(s))} · ${esc(STATE_LABEL[stateOf(s)])}">${bico(agentIcon(s.agent), stateOf(s), sessAnim(s))}<span class="grow">${esc(displayName(s))}</span>${isFollowed(s.id) ? '<span class="follow-star" aria-label="已关注">★</span>' : ""}</button>
                    ${rowMore("session-menu", { "data-session": s.id }, `${displayName(s)} 管理`)}
                  </div>`,
              )
              .join("");
            return `<div class="tree-row-wrap${current ? " current" : ""}">
              <button type="button" class="tree-row${current ? " active" : ""}" data-action="open-tree" data-tree="${t.id}" title="${esc(treeTitle(t))}">${bico(icon("branch"), treeState(t))}<span class="branch">${esc(t.branch)}</span>${countBadge}</button>
              ${rowMore("tree-menu", { "data-tree": t.id }, `${t.branch} 管理`)}
            </div>${sessRows}`;
          })
          .join("");
        const summaryBadge =
          !expanded && needs ? `<span class="badge amber">${needs}</span>`
          : archivedN ? `<span class="badge">${archivedN}</span>`
          : "";
        const projectActive = ui.route.name === "project" && ui.route.projectId === pid;
        return `<div class="proj-group">
          <div class="proj-row-wrap${projectActive ? " active" : ""}">
            <button type="button" class="proj-disclosure${expanded ? " open" : ""}" data-action="toggle-project" data-project="${pid}" aria-expanded="${expanded}" aria-label="${expanded ? "收起" : "展开"} ${esc(p.name)} 工作树">${icon("chevD", "ico chev")}</button>
            <button type="button" class="proj-row" data-action="open-project" data-project="${pid}" title="${esc(p.path)}">
              ${icon("folder")}<span class="grow">${esc(p.name)}</span>${store.pinnedProjects.includes(pid) ? '<span class="follow-star" aria-label="已置顶">★</span>' : ""}${summaryBadge}
            </button>
            ${rowMore("project-menu", { "data-project": pid }, `${p.name} 管理`)}
          </div>
          ${expanded ? `<div class="tree-list">${rows}${allTrees.length > 8 ? btn(showAll ? "收起更多工作目录" : `显示其余 ${allTrees.length - 8} 个工作目录`, "branch-list-toggle", { "data-project": pid }, "btn-subtle") : ""}</div>` : ""}
        </div>`;
      })
      .join("");
    const archivedProjects = Object.keys(PROJECTS)
      .filter((pid) => isArchivedProject(pid) && !isDeletedProject(pid))
      .map((pid) => {
        const p = PROJECTS[pid];
        const projectActive = ui.route.name === "project" && ui.route.projectId === pid;
        return `<div class="proj-row-wrap archived${projectActive ? " active" : ""}">
          <button type="button" class="proj-row" data-action="open-project" data-project="${pid}" title="${esc(p.path)} · 已归档">
            ${icon("archive")}<span class="grow">${esc(p.name)}</span>
          </button>
          ${rowMore("project-menu", { "data-project": pid }, `${p.name} 管理`)}
        </div>`;
      })
      .join("");
    const archivedBlock = archivedProjects
      ? `<div class="side-label">已归档项目</div><div class="side-tree">${archivedProjects}</div>`
      : "";

    /* 最近：单行平铺（与会话行同一套品牌图标 + 状态点） */
    const recent = recentSessions()
      .filter(isSidebarSession)
      .filter(matchesSelectedScope)
      .map(
        (s) =>
          `<button type="button" class="sess-row recent-sess${s.id === currentSessionId ? " active" : ""}" data-action="open-session" data-session="${s.id}" title="${esc(PROJECTS[s.project].name)} · ${esc(s.time)}">${bico(agentIcon(s.agent), stateOf(s), sessAnim(s))}<span class="grow">${esc(displayName(s))}</span>${isFollowed(s.id) ? '<span class="follow-star" aria-label="已关注">★</span>' : ""}</button>`,
      )
      .join("");

    return `<aside class="sidebar">
      <div class="side-head">
        <button type="button" class="brand-home" data-action="nav" data-route="workbench" title="回到起始页"><span class="brand-mark">${icon("terminal")}</span>ThreadTerm</button>
        ${btn(icon("search"), "open-palette", { "aria-label": "打开命令面板（Ctrl K）", title: "搜索命令、项目、会话（Ctrl K）" }, "icon-btn")}
        ${btn(
          `${icon("bell")}${unread ? `<i class="bell-badge">${unread}</i>` : ""}`,
          "open-notifications",
          { "aria-label": `通知，${unread} 条未读`, "aria-expanded": "false" },
          "icon-btn",
        )}
      </div>
      <div class="side-scroll">
        <nav class="side-nav" aria-label="工作区导航">${nav}</nav>
        <button type="button" class="side-label side-scope" data-action="scope-open" aria-label="选择项目范围" title="${esc(scope.label)}">${tr("项目", "Projects")} · ${esc(scope.label)}</button>
        <div class="side-tree">${tree}</div>
        ${archivedBlock}
        <div class="side-label">${tr("最近", "Recent")}</div>
        <div class="side-tree">${recent}</div>
      </div>
      <div class="side-foot">
        ${btn(`<span class="avatar">本</span><span class="grow">本地用户</span>${store.trial ? '<span class="badge">Pro 演示中</span>' : ""}${icon("chevD")}`, "open-settings", { "aria-label": "账户与设置菜单", "aria-expanded": "false" }, "user-row")}
      </div>
    </aside>`;
  }

  function statusbar() {
    const briefToggle = ui.route.name === "project" || ui.route.name === "worktree"
      ? `<span class="sb-note">${ui.route.name === "worktree" ? "分支简报" : "项目简报"}</span>
        ${btn("有关注项", "brief-focus-demo", { "data-mode": "show" }, ui.briefHideFocus ? "sb-btn" : "sb-btn on")}
        ${btn("关注为空", "brief-focus-demo", { "data-mode": "hide" }, ui.briefHideFocus ? "sb-btn on" : "sb-btn")}`
      : "";
    return `<footer class="statusbar">
      ${btn(`${icon("spark")}演示数据 ${icon("chevD")}`, "open-scenarios", { "aria-label": "切换演示场景", "aria-expanded": false }, "sb-btn")}
      <span class="sb-note">${icon("shield")}交互原型</span>
      ${briefToggle}
      <div class="top-spacer"></div>
      <span>离线运行 · 不连接真实终端 · 2026.09</span>
    </footer>`;
  }

  /* ==================== 共享片段：待处理行 / 重点关注面板 ==================== */
  /* 待处理行：待处理页与两个概览页共用同一呈现；空态为固定高度占位 */
  function attentionRows(items, emptyTitle = "当前范围没有待处理项", emptyText = "") {
    return items.length
      ? items
          .map((ep) => {
            const item = ep.item;
            return `<div class="inbox-row">
              <span class="dot st-${KIND_STATE[ep.kind]}"></span>
              <div class="ir-main">
                <div class="ir-title">${esc(ep.title)}</div>
                <div class="ir-ctx">${esc(displayName(item))} · ${esc(ep.reason)}</div>
              </div>
              <span class="chip st-${KIND_STATE[ep.kind]}">${KIND_LABEL[ep.kind]}</span>
              ${btn("查看", "attention-view", { "data-episode": ep.id }, "btn")}
              ${btn(icon("more"), "row-menu", { "data-episode": ep.id, "aria-label": `${ep.title} 更多操作`, "aria-expanded": "false" }, "icon-btn")}
            </div>`;
          })
          .join("")
      : `<div class="empty"><b>${esc(emptyTitle)}</b>${emptyText ? `<p>${esc(emptyText)}</p>` : ""}</div>`;
  }

  /* 范围化过滤：项目总览 / 工作树概览用 */
  const inScope = (scope) => (ep) =>
    (!scope.project || ep.item.project === scope.project) &&
    (!scope.tree || ep.item.tree === scope.tree);
  const attentionInScope = (scope) => actionableAttention().filter(inScope(scope));

  /* 全局页常驻说明条；概览页仅当范围内确有停滞项时出现 */
  function stalledNote(scope = {}) {
    const stalled = stalledAttention().filter(inScope(scope));
    const scoped = Boolean(scope.project || scope.tree);
    if (scoped && !stalled.length) return "";
    return `<div class="stalled-note"><span class="dot st-stalled"></span><span>停滞提醒：${stalled.length ? esc(stalled[0].title) + "。" : ""}仅提示，不代表失败或需要操作。</span>${stalled.length ? `<span class="top-spacer"></span>${btn(isFollowed(stalled[0].item.id) ? "已关注" : "关注", "follow-toggle", { "data-session": stalled[0].item.id }, "btn-subtle")}` : ""}</div>`;
  }

  /* 重点关注行（概览页双列面板用） */
  function followRows(scope = {}) {
    const list = store.followed
      .map(sessionById)
      .filter(Boolean)
      .filter(
        (item) =>
          (!scope.project || item.project === scope.project) &&
          (!scope.tree || item.tree === scope.tree),
      );
    return list.length
      ? list
          .map(
            (item) => `<div class="follow-row">
              <span class="star">${icon("star")}</span>
              ${btn(esc(displayName(item)), isUnavailable(item) ? "view-history" : "open-session", { "data-session": item.id, title: isUnavailable(item) ? "查看记录（不可用会话）" : "打开终端" }, "follow-name")}
              ${chip(stateOf(item))}
              <span class="ops">
                ${btn(icon("more"), "follow-menu", { "data-session": item.id, "aria-label": `${displayName(item)} 关注项操作`, "aria-expanded": "false" }, "icon-btn")}
              </span>
            </div>`,
          )
          .join("")
      : '<div class="empty"><p>还没有重点关注的终端。</p></div>';
  }

  /* v5 概览页分区面板：标题行固定 + 列表体内部滚动 */
  function ovPanel(title, count, bodyHtml, { actions = "", foot = "", label = "" } = {}) {
    return `<section class="panel ov-panel" aria-label="${esc(label || title)}">
      <header class="ov-panel-head"><h2>${esc(title)}${count !== "" && count != null ? `<span class="count">${count}</span>` : ""}</h2>${actions}</header>
      <div class="ov-panel-body">${bodyHtml}</div>
      ${foot ? `<div class="ov-panel-foot">${foot}</div>` : ""}
    </section>`;
  }

  /* ==================== 视图：起始页（工作台，居中窄列） ==================== */
  function viewWorkbench() {
    const resume = sessions().find((s) => s.id === "orbit-claude") || sessions()[0];
    const resumeTree = treeOf(resume);
    const needsCount = actionableAttention().filter((ep) => KIND_STATE[ep.kind] === "needs").length;
    const failedCount = actionableAttention().filter((ep) => KIND_STATE[ep.kind] === "failed").length;

    /* Composer：chip 预选项目/Worktree/Agent，提交只打开预选好的新建终端对话框 */
    const c = ui.composer;
    const cProject = PROJECTS[c.project];
    const cTree = WORKTREES[c.tree];
    const composer = `<form class="composer" data-composer-form aria-label="新建会话">
      <textarea data-composer-text aria-label="描述要开的会话" placeholder="描述要开的会话，或直接选项目开始…" rows="2" maxlength="500">${esc(c.text)}</textarea>
      <div class="composer-row">
        ${btn(`${icon("folder")}<b>${esc(cProject.name)}</b>${icon("chevD")}`, "composer-pick", { "data-kind": "project", "aria-label": "选择项目" }, "composer-chip")}
        ${btn(`${icon("branch")}<b>${esc(cTree?.branch || "选择目录")}</b>${icon("chevD")}`, "composer-pick", { "data-kind": "tree", "aria-label": "选择 Worktree" }, "composer-chip")}
        ${btn(`${icon("spark")}<b>${esc(c.agent)}</b>${icon("chevD")}`, "composer-pick", { "data-kind": "agent", "aria-label": "选择 Agent" }, "composer-chip")}
        <button type="submit" class="composer-send" aria-label="打开新建终端对话框" title="新建终端（预览后确认）">${icon("chevR")}</button>
      </div>
    </form>`;

    const continueRow = `<div class="start-label">继续上次</div>
      <div class="quiet-block">
        ${
          resume
            ? `<button type="button" class="quiet-row" data-action="open-session" data-session="${resume.id}">
                <span class="dot st-${stateOf(resume)}"></span>
                <span class="quiet-name grow">${esc(displayName(resume))}</span>
                <span class="meta">${esc(PROJECTS[resume.project].name)} · ${esc(resumeTree?.branch || "")}</span>
                ${chip(stateOf(resume))}
                <span class="meta">继续 ${icon("chevR")}</span>
              </button>`
            : `<div class="quiet-row placeholder"><span class="quiet-name grow">暂无继续项 · 从上方开始一个新会话</span></div>`
        }
      </div>`;

    const inboxStrip = `<div class="start-label">待处理</div>
      ${
        actionableAttention().length
          ? `<button type="button" class="inbox-strip" data-action="nav" data-route="inbox">
              <span class="dot st-needs"></span>
              <span class="grow">${needsCount ? `${needsCount} 项需要你` : ""}${needsCount && failedCount ? " · " : ""}${failedCount ? `${failedCount} 项失败` : ""}</span>
              <span class="link">查看全部 ${icon("chevR")}</span>
            </button>`
          : `<div class="quiet-row placeholder"><span class="quiet-name grow">暂无待处理项 · 一切正常</span></div>`
      }`;

    /* 最近会话：固定 3 槽位，空槽占位不塌 */
    const recentList = recentSessions().filter(matchesSelectedScope);
    const recent = [0, 1, 2]
      .map((i) => {
        const item = recentList[i];
        if (!item)
          return `<div class="quiet-row placeholder"><span class="quiet-name grow">暂无更多会话</span></div>`;
        return `<button type="button" class="quiet-row" data-action="open-session" data-session="${item.id}">
          ${agentIcon(item.agent)}
          <span class="quiet-name grow">${esc(displayName(item))}</span>
          <span class="meta">${esc(PROJECTS[item.project].name)} · ${esc(item.time)}</span>
          ${chip(stateOf(item))}
        </button>`;
      })
      .join("");

    return `<section class="start">
      <h1 class="start-q">从哪开始？</h1>
      ${composer}
      ${continueRow}
      ${inboxStrip}
      <div class="start-label">最近会话</div>
      <div class="quiet-block">${recent}</div>
    </section>`;
  }

  /* ==================== 视图：待处理（全局唯一队列） ==================== */
  function viewInbox() {
    const filters = [
      ["all", "全部"],
      ["approval", "待确认"],
      ["waiting", "待输入"],
      ["failed", "失败"],
      ["review", "待复核"],
    ];
    const items = actionableAttention().filter(
      (ep) => (ui.inboxFilter === "all" || ep.kind === ui.inboxFilter) && matchesSelectedScope(ep.item),
    );

    return `<section class="page">
      <div class="page-head">
        <div><h1 class="page-title">待处理<span class="count">${actionableAttention().length}</span></h1><p class="page-sub">需要你决定的会话请求，集中在这里处理。</p></div>
        <div class="page-actions">${btn("规则", "attention-rules", {}, "btn")}</div>
      </div>
      <div class="chip-row" role="group" aria-label="待处理筛选">
        ${filters.map(([value, label]) => btn(label, "inbox-filter", { "data-filter": value, "aria-pressed": ui.inboxFilter === value }, `fchip${ui.inboxFilter === value ? " active" : ""}`)).join("")}
      </div>
      <div class="panel inbox-list">${attentionRows(items, "该分类下没有待处理项", "换个筛选，或回到工作台继续当前工作。")}</div>
      ${stalledNote()}
    </section>`;
  }

  /* ==================== 视图：项目总览 / 工作树概览（作用域状态感知） ==================== */
  /* 会话清单行：概览页共用 */
  function sessionRows(list) {
    return list.length
      ? list
          .map((item) => {
            const tree = treeOf(item);
            return `<div class="inbox-row">
              <span class="dot st-${stateOf(item)}"></span>
              <div class="ir-main">
                <div class="ir-title">${esc(displayName(item))}</div>
                <div class="ir-ctx">${esc(item.agent)} · ${esc(tree?.branch || "目录不可用")} · ${esc(item.time)}</div>
              </div>
              ${chip(stateOf(item))}
              ${btn(isUnavailable(item) ? "查看历史" : "打开", isUnavailable(item) ? "view-history" : "open-session", { "data-session": item.id }, "btn")}
            </div>`;
          })
          .join("")
      : `<div class="empty"><b>这里还没有终端</b><p>新建终端会使用这个工作目录，不会创建真实文件。</p></div>`;
  }

  /* 最近活动时间线（项目页/分支页共用）：倒序、相对时间 + agent 图标 + 状态短语；「查看全部」打开只读弹窗 */
  const dayRank = (time) => (time.startsWith("今天") ? 2 : time.startsWith("昨天") ? 1 : 0);
  const verbOf = (s) =>
    stateOf(s) === "running" ? "正在运行"
    : stateOf(s) === "needs" ? "等待你的输入"
    : stateOf(s) === "failed" ? "连接中断"
    : stateOf(s) === "stalled" ? "目录缺失，仅保留历史"
    : "已完成并保留记录";
  const activityEntries = ({ project, tree } = {}) =>
    sessions()
      .filter((item) => isWorkingSession(item) && (!project || item.project === project) && (!tree || item.tree === tree))
      .sort((a, b) => dayRank(b.time) - dayRank(a.time) || b.time.localeCompare(a.time));
  const activityRow = (item, action = "recent") =>
    `<button type="button" class="${action === "activity-open" ? "activity-row" : "brief-row tl-row"}" data-action="${action}" data-session="${item.id}">
      <span class="tl-time">${esc(item.time)}</span>
      <div class="brief-row-main">
        ${agentIcon(item.agent)}
        <div class="ir-main">
          <div class="ir-title">${esc(displayName(item))}</div>
          <div class="ir-ctx">${verbOf(item)}</div>
        </div>
      </div>
      <span class="brief-row-btn brief-row-go">${icon("chevR")}</span>
    </button>`;
  /* 简报槽位：无数据也占一行，区块本身由网格预留高度 */
  const briefSlot = (title, sub = "") =>
    `<div class="brief-row brief-slot">
      <div class="brief-row-main">
        <div class="ir-main">
          <div class="ir-title">${esc(title)}</div>
          ${sub ? `<div class="ir-ctx">${esc(sub)}</div>` : ""}
        </div>
      </div>
    </div>`;
  const briefSec = (kind, titleHtml, bodyHtml) =>
    `<section class="brief-sec brief-${kind}">
      <div class="brief-sec-head">${titleHtml}</div>
      <div class="brief-sec-body">${bodyHtml}</div>
    </section>`;
  const mapFocusRows = (rows) =>
    rows
      .map(
        (r) => `<div class="brief-row">
          <div class="brief-row-main">
            <span class="dot st-${r.state}"></span>
            <div class="ir-main">
              <div class="ir-title">${esc(r.title)}</div>
              <div class="ir-ctx">${esc(r.source)}</div>
            </div>
          </div>
          <span class="chip brief-chip st-${r.state}">${esc(r.badge)}</span>
          ${r.action}
        </div>`,
      )
      .join("");
  /* 进行中 = 运行中 + 待处理（needs/failed）+ 停滞；已结束不进此槽 */
  const isInProgress = (s) => ["running", "needs", "failed", "stalled"].includes(stateOf(s));
  const inProgressBadge = (s) => {
    const st = stateOf(s);
    if (st === "needs") {
      const ep = attentionItems().find((e) => e.session === s.id && e.kind !== "stalled");
      return { state: "needs", label: ep ? KIND_LABEL[ep.kind] : STATE_LABEL.needs };
    }
    return { state: st, label: STATE_LABEL[st] };
  };
  const followRowsFor = (items) =>
    items.map((s) => ({
      key: "follow-" + s.id,
      state: stateOf(s),
      badge: STATE_LABEL[stateOf(s)],
      title: displayName(s),
      source: `${s.agent} · ${treeOf(s)?.branch || "目录不可用"} · ${s.time}`,
      action: btn(isUnavailable(s) ? "查看记录" : "打开", isUnavailable(s) ? "view-history" : "open-session", { "data-session": s.id }, "btn brief-row-btn"),
    }));

  /* ==================== 视图：项目主页 = 项目简报仪表盘（指标带含用量摘要 + 通栏简报） ==================== */
  function viewProject(projectId) {
    const p = PROJECTS[projectId];
    if (!p) return viewWorkbench();
    if (isDeletedProject(projectId)) return viewWorkbench();
    const list = sessions().filter((s) => s.project === projectId && isWorkingSession(s));
    const trees = Object.values(WORKTREES).filter(
      (t) => t.project === projectId && !isRemovedTree(t.id) && !isCatalogGoneTree(t.id) && !isArchivedTree(t.id),
    );
    const agents = [...new Set(list.map((s) => s.agent))];
    const attention = attentionInScope({ project: projectId });
    const usage = usageFor(projectId);
    const hideFocus = ui.briefHideFocus;

    /* 指标条：5 项小计数，数字下加 24h / 7 日 sparkline（v14 恢复） */
    const runningCount = list.filter((s) => stateOf(s) === "running").length;
    const stalledCount = list.filter((s) => stateOf(s) === "stalled").length;
    const followedHere = store.followed.map(sessionById).filter((s) => s && s.project === projectId && isWorkingSession(s));
    const metrics = [
      { n: runningCount, label: "运行中", hint: "近 24h", cls: "st-running", spark: usage.sparks.running24h, fill: true },
      { n: stalledCount, label: "停滞", hint: "近 24h", cls: "st-stalled", spark: usage.sparks.stalled24h, fill: true },
      { n: attention.length, label: "待处理", hint: "近 24h", cls: "st-needs", action: "nav", route: "inbox", spark: usage.sparks.attention24h, fill: true },
      { n: trees.length, label: "工作树", hint: "近 7 日", cls: "", spark: usage.sparks.trees7d, fill: false },
      { n: list.length, label: "会话", hint: "近 7 日", cls: "", spark: usage.sparks.sessions7d, fill: false },
    ];
    const metricCell = (m) => {
      const inner = `<span class="metric-label">${m.label}<i>${m.hint}</i></span><b class="tnum${m.cls ? " " + m.cls : ""}">${m.n}</b><span class="spark-wrap${m.cls ? " " + m.cls : ""}">${sparkline(m.spark, { w: 64, h: 16, fill: m.fill })}</span>`;
      return m.action
        ? `<button type="button" class="metric" data-action="${m.action}" data-route="${m.route}" title="查看全部待处理">${inner}</button>`
        : `<div class="metric">${inner}</div>`;
    };
    /* 指标带：左状态/规模收拢，右用量；标签在上（Stripe/Vercel） */
    const metricStrip = `<div class="metric-strip">
        <div class="metric-group metric-status">${metrics.slice(0, 3).map(metricCell).join("")}</div>
        <div class="metric-group metric-scale">${metrics.slice(3).map(metricCell).join("")}</div>
        ${usagePanel(projectId)}
      </div>`;

    /* 已关注：仅用户星标，与状态无关。槽位恒在。 */
    const focusRows = hideFocus ? [] : followRowsFor(followedHere);
    const focusSection = briefSec(
      "focus",
      `<h2>已关注<span class="count">${focusRows.length}</span></h2>${btn("添加关注", "follow-add", {}, "btn brief-head-btn")}`,
      mapFocusRows(focusRows) || briefSlot("还没有关注的会话", "点添加关注，或在会话上点星标"),
    );

    /* 进行中：运行中 + 待处理 + 停滞的工作树；状态变了仍留在此槽 */
    const activeTrees = trees.filter((t) => list.some((s) => s.tree === t.id && isInProgress(s)));
    const activeSection = briefSec(
      "active",
      `<h2>进行中的工作树</h2>`,
      activeTrees.length
        ? activeTrees
            .map((t) => {
              const live = list.filter((s) => s.tree === t.id && isInProgress(s));
              const lastTime = live.map((s) => s.time).sort().at(-1) || "";
              const st = treeState(t);
              const pendingN = live.filter((s) => stateOf(s) === "needs" || stateOf(s) === "failed").length;
              const runningN = live.filter((s) => stateOf(s) === "running").length;
              const label =
                st === "needs" || pendingN
                  ? `${pendingN} 个待处理`
                  : st === "running"
                    ? `${runningN} 个运行中`
                    : STATE_LABEL[st];
              const chipState = pendingN ? "needs" : st;
              return `<button type="button" class="brief-row brief-tree" data-action="open-tree" data-tree="${t.id}">
                <div class="brief-row-main">
                  <span class="dot st-${chipState}${st === "running" ? " pulse" : ""}"></span>
                  <div class="ir-main">
                    <div class="ir-title mono">${esc(t.branch)}</div>
                    <div class="ir-ctx">${esc(t.path)} · ${esc(lastTime)}</div>
                  </div>
                </div>
                <span class="chip brief-chip st-${chipState}">${esc(label)}</span>
                <span class="brief-row-btn brief-row-go">${icon("chevR")}</span>
              </button>`;
            })
            .join("")
        : briefSlot("当前没有进行中的工作树", "运行中或待处理的工作树会出现在这里"),
    );

    /* 最近活动时间线（替代全量会话清单）；完整列表在弹窗中翻页 */
    const timeline = activityEntries({ project: projectId }).slice(0, 5).map((item) => activityRow(item)).join("");
    const timelineSection = briefSec(
      "timeline",
      `<h2>最近活动</h2>${btn("查看全部", "activity-all", { "data-project": projectId }, "btn brief-head-btn")}`,
      timeline || briefSlot("这个项目还没有活动记录", "会话推进会出现在这里"),
    );

    return `<section class="brief-page">
      <div class="brief-mast">
        <header class="ov-head">
          <div class="ov-head-main">
            <h1 class="page-title">${esc(p.name)}</h1>
            <p class="page-sub"><span class="mono">${esc(p.path)}</span> · ${trees.length} 个工作树 · ${list.length} 个会话</p>
            <div class="ov-tags">${agents.map((a) => `<span class="tag">${esc(a)}</span>`).join("")}</div>
          </div>
          <div class="page-actions">
            ${chip(projectState(projectId))}
            ${isArchivedProject(projectId) ? btn("恢复项目", "catalog-restore", { "data-kind": "project", "data-id": projectId }, "btn btn-primary") : ""}
            ${btn(`${icon("plus")}新建终端`, "open-create", { "data-project": projectId }, "btn btn-primary")}
            ${btn(`${icon("branch")}新建工作树`, "new-tree", { "data-project": projectId }, "btn")}
          </div>
        </header>
        ${isArchivedProject(projectId) ? `<div class="catalog-banner">${icon("archive")}<span>已在 ThreadTerm 中归档，侧栏工作列表会收起此项。与 Agent CLI 无关。</span></div>` : ""}
        ${metricStrip}
      </div>
      <div class="brief-stack">
        ${focusSection}
        ${activeSection}
        ${timelineSection}
      </div>
    </section>`;
  }

  /* ==================== 视图：分支主页 = 与项目页同构的简报（会话粒度，本分支用量） ==================== */
  function branchUsage(treeId) {
    const tree = WORKTREES[treeId];
    const list = sessions().filter((s) => s.tree === treeId && isWorkingSession(s));
    const project = usageFor(tree?.project);
    const treeRow = project.trees.find((row) => row.tree === treeId);
    const rows = list.map((s) => {
      const u = SESSION_USAGE[s.id] || { tokens: 0, hours: 0 };
      return { s, tokens: u.tokens || 0, hours: u.hours || 0 };
    });
    const weekTokens = rows.reduce((sum, r) => sum + r.tokens, 0) || treeRow?.tokens || 0;
    const share = project.weekTokens ? weekTokens / project.weekTokens : 0;
    const weekSeries = (project.weekSeries || []).map((v) => Math.round(v * share));
    const todayTokens = weekSeries[weekSeries.length - 1] || 0;
    const weekCost = (project.weekCost || 0) * share;
    const todayCost = project.weekTokens ? todayTokens * ((project.weekCost || 0) / project.weekTokens) : 0;
    const byAgent = {};
    for (const r of rows) {
      (byAgent[r.s.agent] ||= { tokens: 0, hours: 0 });
      byAgent[r.s.agent].tokens += r.tokens;
      byAgent[r.s.agent].hours += r.hours;
    }
    const agents = Object.entries(byAgent).map(([agent, agg]) =>
      agent === "Shell"
        ? { agent, kind: "hours", hours: Math.round(agg.hours * 10) / 10 }
        : { agent, kind: "tokens", tokens: agg.tokens, cost: project.weekTokens ? agg.tokens * ((project.weekCost || 0) / project.weekTokens) : 0 },
    );
    const sparks = {
      running24h: list.some((s) => stateOf(s) === "running") ? [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] : ZERO_SPARK_24H,
      stalled24h: list.some((s) => stateOf(s) === "stalled") ? [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0] : ZERO_SPARK_24H,
      attention24h: attentionInScope({ tree: treeId }).length ? [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1] : ZERO_SPARK_24H,
      sessions7d: Array(7).fill(list.length || 0),
      follow7d: Array(7).fill(store.followed.filter((id) => sessionById(id)?.tree === treeId).length),
    };
    return { rows, weekTokens, todayTokens, weekCost, todayCost, weekSeries, agents, sparks };
  }

  function branchUsagePanel(treeId) {
    const u = branchUsage(treeId);
    return usageStrip({
      label: "本分支用量",
      todayTokens: u.todayTokens,
      todayCost: u.todayCost,
      weekTokens: u.weekTokens,
      weekCost: u.weekCost,
      weekSeries: u.weekSeries,
    });
  }

  function viewWorktree(treeId) {
    const tree = WORKTREES[treeId];
    if (!tree) return viewWorkbench();
    if (isCatalogGoneTree(treeId)) return viewWorkbench();
    const removed = isRemovedTree(treeId);
    const missing = tree.missing || removed;
    const p = PROJECTS[tree.project];
    const list = sessions().filter((s) => s.tree === treeId && isWorkingSession(s));
    const agents = [...new Set(list.map((s) => s.agent))];
    const available = list.filter((s) => !isUnavailable(s));
    const continueItem = available[0];
    const attention = attentionInScope({ tree: treeId });
    const stateText = removed ? "目录已移除 · 仅历史" : tree.missing ? "目录缺失 · 仅历史" : tree.detail;
    const hideFocus = ui.briefHideFocus;
    const usage = branchUsage(treeId);
    const followedHere = store.followed.map(sessionById).filter((s) => s && s.tree === treeId && isWorkingSession(s));

    /* 指标带：左状态/规模收拢，右用量；标签在上 */
    const runningCount = list.filter((s) => stateOf(s) === "running").length;
    const stalledCount = list.filter((s) => stateOf(s) === "stalled").length;
    const metrics = [
      { n: runningCount, label: "运行中", hint: "近 24h", cls: "st-running", spark: usage.sparks.running24h, fill: true },
      { n: stalledCount, label: "停滞", hint: "近 24h", cls: "st-stalled", spark: usage.sparks.stalled24h, fill: true },
      { n: attention.length, label: "待处理", hint: "近 24h", cls: "st-needs", action: "nav", route: "inbox", spark: usage.sparks.attention24h, fill: true },
      { n: list.length, label: "会话", hint: "近 7 日", cls: "", spark: usage.sparks.sessions7d, fill: false },
      { n: hideFocus ? 0 : followedHere.length, label: "已关注", hint: "近 7 日", cls: "", spark: hideFocus ? Array(7).fill(0) : usage.sparks.follow7d, fill: false },
    ];
    const metricCell = (m) => {
      const inner = `<span class="metric-label">${m.label}<i>${m.hint}</i></span><b class="tnum${m.cls ? " " + m.cls : ""}">${m.n}</b><span class="spark-wrap${m.cls ? " " + m.cls : ""}">${sparkline(m.spark, { w: 64, h: 16, fill: m.fill })}</span>`;
      return m.action
        ? `<button type="button" class="metric" data-action="${m.action}" data-route="${m.route}" title="${m.hint || m.label}">${inner}</button>`
        : `<div class="metric">${inner}</div>`;
    };
    const metricStrip = `<div class="metric-strip">
        <div class="metric-group metric-status">${metrics.slice(0, 3).map(metricCell).join("")}</div>
        <div class="metric-group metric-scale">${metrics.slice(3).map(metricCell).join("")}</div>
        ${branchUsagePanel(treeId)}
      </div>`;

    /* 已关注：仅用户星标。槽位恒在。 */
    const focusRows = hideFocus ? [] : followRowsFor(followedHere);
    const focusSection = briefSec(
      "focus",
      `<h2>已关注<span class="count">${focusRows.length}</span></h2>${btn("添加关注", "follow-add", {}, "btn brief-head-btn")}`,
      mapFocusRows(focusRows) || briefSlot("还没有关注的会话", "点添加关注，或在会话上点星标"),
    );

    /* 进行中：运行中 + 待处理 + 停滞；状态变化不离开此槽 */
    const activeSessions = list.filter(isInProgress);
    const activeSection = briefSec(
      "active",
      `<h2>进行中的会话</h2>`,
      activeSessions.length
        ? activeSessions
            .map((s) => {
              const badge = inProgressBadge(s);
              const go = isUnavailable(s) ? "view-history" : "open-session";
              return `<button type="button" class="brief-row brief-tree" data-action="${go}" data-session="${s.id}">
                <div class="brief-row-main">
                  <span class="dot st-${badge.state}${badge.state === "running" ? " pulse" : ""}"></span>
                  ${agentIcon(s.agent)}
                  <div class="ir-main">
                    <div class="ir-title">${esc(displayName(s))}</div>
                    <div class="ir-ctx">${esc(s.agent)} · ${esc(s.command)} · ${esc(s.time)}</div>
                  </div>
                </div>
                <span class="chip brief-chip st-${badge.state}">${esc(badge.label)}</span>
                <span class="brief-row-btn brief-row-go">${icon("chevR")}</span>
              </button>`;
            })
            .join("")
        : briefSlot("当前没有进行中的会话", "运行中或待处理的会话会出现在这里"),
    );

    /* 最近活动（本分支时间线；查看全部打开只读弹窗） */
    const timeline = activityEntries({ project: tree.project, tree: treeId }).slice(0, 5).map((item) => activityRow(item)).join("");
    const timelineSection = briefSec(
      "timeline",
      `<h2>最近活动</h2>${btn("查看全部", "activity-all", { "data-project": tree.project, "data-tree": treeId }, "btn brief-head-btn")}`,
      timeline || briefSlot("这里还没有活动记录", "会话推进会出现在这里"),
    );

    return `<section class="brief-page">
      <div class="brief-mast">
        <header class="ov-head">
          <div class="ov-head-main">
            <h1 class="page-title">${esc(p.name)} · <span class="mono wt-branch">${esc(tree.branch)}</span></h1>
            <p class="page-sub">目录：<span class="mono">${esc(tree.path)}</span> · ${list.length} 个会话${missing ? ` · ${esc(stateText)}` : ""}</p>
            <div class="ov-tags">${agents.map((a) => `<span class="tag">${esc(a)}</span>`).join("")}</div>
          </div>
          <div class="page-actions">
            ${chip(treeState(tree))}
            ${isArchivedTree(treeId) ? btn("恢复分支", "catalog-restore", { "data-kind": "tree", "data-id": treeId }, "btn btn-primary") : ""}
            ${missing
              ? btn("重新定位工作树", "relocate", { "data-tree": treeId }, "btn btn-primary")
              : `${btn(`继续工作 ${icon("chevR")}`, "continue-tree", { "data-tree": treeId, disabled: !continueItem }, "btn btn-primary")}
                 ${btn(`${icon("plus")}新建终端`, "open-create", { "data-tree": treeId }, "btn")}
                 ${btn("移除工作树", "remove-tree", { "data-tree": treeId }, "btn btn-danger")}`}
          </div>
        </header>
        ${isArchivedTree(treeId) ? `<div class="catalog-banner">${icon("archive")}<span>已在 ThreadTerm 中归档，可从所属项目菜单恢复。与 Agent CLI 无关。</span></div>` : ""}
        ${metricStrip}
      </div>
      <div class="brief-stack">
        ${focusSection}
        ${activeSection}
        ${timelineSection}
      </div>
    </section>`;
  }

  /* ==================== 视图：所有终端 ==================== */
  function viewTerminals() {
    if (ui.tInspect && !sessionById(ui.tInspect)) ui.tInspect = "";
    const f = ui.tFilters;
    // A search, tree, or status filter shows a subset of a saved ordering.
    // Do not let a drag gesture silently rewrite the underlying full list from
    // that subset; project scope is deliberately safe because it has its own
    // complete ordering bucket.
    const orderLocked = Boolean(f.query || f.tree !== "all" || f.status !== "all");
    const visibleTrees = Object.values(WORKTREES).filter(
      (t) => !isRemovedTree(t.id) && !isCatalogGoneTree(t.id) && (f.project === "all" || t.project === f.project),
    );
    const list = sessions().filter((item) => {
      if (isCatalogGoneSession(item)) return false;
      const text = [displayName(item), item.agent, item.summary, PROJECTS[item.project].name, treeOf(item)?.branch]
        .join(" ")
        .toLowerCase();
      return (
        (!f.query || text.includes(f.query.toLowerCase())) &&
        (f.project === "all" || item.project === f.project) &&
        (f.tree === "all" || item.tree === f.tree) &&
        (f.status === "all" || stateOf(item) === f.status)
      );
    });
    const orderScope = f.project === "all" ? "all" : f.project;
    const savedOrder = store.sessionOrder[orderScope] || [];
    const orderedList = [...list].sort((a, b) => {
      const ai = savedOrder.indexOf(a.id), bi = savedOrder.indexOf(b.id);
      const manual = (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
      return manual || activityRank(a) - activityRank(b) || recentSessions().indexOf(a) - recentSessions().indexOf(b);
    });

    const select = (label, key, options) =>
      `<label><span class="filter-label">${label}</span><select data-action="t-filter" data-filter="${key}">${options
        .map(([v, t]) => `<option value="${esc(v)}"${v === f[key] ? " selected" : ""}>${esc(t)}</option>`)
        .join("")}</select></label>`;

    const filterBar = `<div class="t-filters">
      <div class="t-search"><span class="filter-label">搜索</span>
        <div class="input-wrap">${icon("search")}<input data-action="t-search" placeholder="搜索会话、项目或最近输出" value="${esc(f.query)}" aria-label="搜索所有终端"></div>
      </div>
      ${select("项目", "project", [["all", "全部项目"], ...Object.entries(PROJECTS).filter(([id]) => !isDeletedProject(id)).map(([id, p]) => [id, p.name])])}
      ${select("目录", "tree", [["all", "全部工作目录"], ...visibleTrees.map((t) => [t.id, f.project === "all" ? PROJECTS[t.project].name + " · " + t.branch : t.branch])])}
      ${select("状态", "status", [["all", "全部状态"], ...Object.entries(STATE_LABEL).map(([v, l]) => [v, l])])}
      <div><span class="filter-label">显示方式</span>
        <div class="seg" role="group" aria-label="显示方式">
          ${btn("卡片", "t-layout", { "data-layout": "cards", "aria-pressed": f.layout === "cards" }, `seg-btn${f.layout === "cards" ? " active" : ""}`)}
          ${btn("列表", "t-layout", { "data-layout": "list", "aria-pressed": f.layout === "list" }, `seg-btn${f.layout === "list" ? " active" : ""}`)}
        </div>
      </div>
    </div>`;

    const inspectId = ui.tInspect || ui.tHighlight;
    const card = (item) => {
      const tree = treeOf(item);
      const missing = isMissing(item);
      const ended = isEnded(item);
      const recent = [...item.output, ...(ui.logs[item.id] || [])].filter(Boolean).at(-1) || item.summary;
      const primary = missing
        ? btn("查看历史", "view-history", { "data-session": item.id }, "btn btn-primary")
        : ended
          ? btn("已结束", "noop", { disabled: true }, "btn")
          : btn("打开终端", "open-session", { "data-session": item.id }, "btn btn-primary");
      return `<article class="panel t-card${isUnavailable(item) ? " unavailable" : ""}${inspectId === item.id ? " highlight" : ""}" data-action="t-inspect" data-session="${item.id}">
        <div class="tc-head">
          <div class="tc-main minw0">
            <div class="tc-name">${agentIcon(item.agent)}${esc(displayName(item))}</div>
            <div class="tc-sub">${esc(PROJECTS[item.project].name)} · ${esc(tree?.branch || "目录不可用")}</div>
          </div>
          ${chip(stateOf(item), missing ? "停滞" : undefined)}${isArchivedSession(item.id) || isArchivedTree(item.tree) || isArchivedProject(item.project) ? '<span class="chip flat">已归档</span>' : ""}
        </div>
        <p class="tc-out" title="${esc(recent)}">${esc(recent)}</p>
        <details class="tc-details">
          <summary>目录与会话信息</summary>
          <div class="body"><code>${esc(tree?.path || "目录已移除")}</code><span>${esc(item.agent)} · ${esc(item.command)}</span><span>${esc(item.detail)} · ${esc(item.time)}</span></div>
        </details>
        ${missing ? '<small class="card-reason">目录不可用；历史仍可阅读，重新定位后才可继续。</small>' : ""}
        <div class="tc-actions">
          ${primary}
          ${btn(icon("more"), "card-menu", { "data-session": item.id, "aria-label": `${displayName(item)} 更多操作`, "aria-expanded": "false" }, "icon-btn")}
        </div>
      </article>`;
    };

    const reorderNote = orderLocked
      ? '<p class="page-sub t-order-note">搜索、目录或状态筛选中；清除这些筛选后才能调整卡片顺序。</p>'
      : "";
    const result = list.length
      ? `${reorderNote}<div class="t-grid ${f.layout === "list" ? "list" : ""}" data-terminal-grid data-order-scope="${esc(orderScope)}" data-order-locked="${orderLocked}">${orderedList.map(card).join("")}</div>`
      : `<div class="panel empty all-empty"><b>没有匹配终端</b><p>试着清除筛选，或换一个项目和目录。</p>${btn("清除筛选", "t-clear", {}, "btn btn-primary")}</div>`;
    const inspected = inspectId ? sessionById(inspectId) : null;
    const rail = inspected
      ? terminalsInspectRail(inspected)
      : `<aside class="t-rail" data-testid="terminals-rail"><div data-terminals-history></div></aside>`;

    return `<section class="page terminals-page">
      <div class="page-head">
        <div><h1 class="page-title">所有终端</h1><p class="page-sub">按项目、分支和状态筛选。点卡片看右侧摘要；打开终端仍用卡片上的按钮。</p></div>
        <div class="page-actions">${btn(`${icon("archive")}本机历史`, "sessions-history-jump", {}, "btn")}</div>
      </div>
      ${filterBar}
      <div class="t-split">
        <div class="t-main">${result}</div>
        ${rail}
      </div>
    </section>`;
  }
  function terminalsInspectRail(item) {
    const tree = treeOf(item);
    const missing = isMissing(item);
    const ended = isEnded(item);
    const lines = [...(item.output || []), ...(ui.logs[item.id] || [])].filter(Boolean);
    const preview = (lines.slice(-8).join("\n") || item.summary || "尚无输出。").slice(0, 1200);
    const primary = missing
      ? btn("查看历史", "view-history", { "data-session": item.id }, "btn btn-primary")
      : ended
        ? btn("已结束", "noop", { disabled: true }, "btn")
        : btn("打开终端", "open-session", { "data-session": item.id }, "btn btn-primary");
    return `<aside class="t-rail" data-testid="terminals-rail">
      <header class="t-rail-head">
        <div><h2>会话摘要</h2><p>不会打开或恢复进程。</p></div>
        ${btn("本机历史", "sessions-history-jump", {}, "btn")}
      </header>
      <div class="t-inspect" data-testid="terminals-inspect">
        <div class="t-inspect-title">${agentIcon(item.agent)}<strong>${esc(displayName(item))}</strong>${chip(stateOf(item), missing ? "停滞" : undefined)}</div>
        <p class="t-inspect-sub">${esc(PROJECTS[item.project].name)} · ${esc(tree?.branch || "目录不可用")} · ${esc(item.time)}</p>
        <code class="t-inspect-path">${esc(tree?.path || "目录已移除")}</code>
        <pre class="t-inspect-out">${esc(preview)}</pre>
        <div class="t-inspect-actions">
          ${primary}
          ${btn(isFollowed(item.id) ? "已关注" : "关注", "follow-toggle", { "data-session": item.id }, "btn")}
          ${!missing && !ended ? btn("浮窗打开", "float-open", { "data-session": item.id }, "btn") : ""}
        </div>
      </div>
    </aside>`;
  }

  /* ==================== 视图：工作预设 ==================== */
  function viewPresets() {
    const all = [...PRESETS, ...store.savedPresets];
    const cards = all
      .map(
        (item) => `<button type="button" class="panel preset-card" data-action="preset-open" data-id="${esc(item.id)}">
          <div class="preset-head">
            <span class="chip flat${item.pro ? " pro" : ""}">${item.pro ? "Local Pro" : "免费示例"}</span>
            <span>${item.commands.length} 条待审阅命令</span>
          </div>
          ${presetMap(item)}
          <h3 class="preset-title">${esc(item.title)}</h3>
          <p class="preset-sub">${esc(PROJECTS[item.project].name)} · ${esc(LAYOUT_NAME[item.layout])}</p>
          <div class="preset-meta">
            <span class="chip flat">预览后确认</span>
            <span class="chip flat">本地保存</span>
            <span class="preset-open">查看恢复内容 ${icon("chevR")}</span>
          </div>
        </button>`,
      )
      .join("");
    return `<section class="page">
      <div class="page-head">
        <div><h1 class="page-title">工作预设</h1><p class="page-sub">保存项目、布局和命令清单。再次打开时，先看清会恢复什么。</p></div>
        <div class="page-actions">${btn(`${icon("plus")}新建工作预设`, "new-preset", {}, "btn btn-primary")}</div>
      </div>
      <div class="preset-grid">${cards}</div>
      <div class="panel principle">
        ${icon("shield")}
        <div><b>打开预设 ≠ 自动执行</b><p>命令逐条可选，恢复前再次确认。基础会话恢复、历史搜索和书签始终免费。</p></div>
      </div>
    </section>`;
  }

  /* ==================== 视图：Local Pro ==================== */
  function viewPro() {
    const feature = (title, copy) =>
      `<div class="feature"><span class="check">${icon("check")}</span><div><b>${title}</b><p>${copy}</p></div></div>`;
    return `<section class="page">
      <div class="page-head">
        <div><h1 class="page-title">Local Pro</h1><p class="page-sub">免费版负责让你顺畅工作。Local Pro 帮你复用已经搭好的工作方式。</p></div>
      </div>
      <div class="pro-layout">
        <section class="panel pricing">
          <span class="chip flat pro">${store.trial ? "Pro 演示已开启" : "定价验证假设"}</span>
          <h2>Local Pro</h2>
          <p>对经常在多个项目与 AI CLI 间切换的人，把重复的启动准备变成可审阅的工作预设。</p>
          ${presetMap(PRESETS[0])}
          <div class="price">¥199 <small>一次性买断 · 包含 12 个月更新</small></div>
          <p class="note">更新期结束后，已授权版本仍可用；后续更新自愿购买，不自动续费。报价待验证。</p>
          ${btn(`${store.trial ? "再次查看 Pro 演示" : "体验 Local Pro（演示）"} ${icon("chevR")}`, "pro-trial", {}, "btn btn-primary")}
          ${store.trial ? btn("切回免费演示", "pro-free", {}, "btn-subtle") : ""}
          <p class="note">没有付款、账户或联网。当前价格与授权均为产品假设。</p>
        </section>
        <section class="panel features">
          <h3>免费版，一直够你认真工作</h3>
          ${feature("终端、项目与基础恢复", "创建并进入会话，从历史或通知回到准确位置。")}
          ${feature("历史搜索、书签与数据导出", "找回自己的记录，不需要先付款。")}
          ${feature("主题、通知、快捷键与可访问性", "基础控制权不放进付费墙。")}
          <h3 class="feature-section-title">Pro，把重复准备变成个人资产</h3>
          ${feature("保存完整工作预设", "项目、会话、布局、筛选和命令清单一起保存。")}
          ${feature("逐项审阅与选择恢复", "自己决定恢复哪种布局、带回哪些命令。")}
          ${feature("本地复用，不强制订阅", "保留和导出自己的预设；没有云端模型费用。")}
          ${btn(`先看看一个真实例子 ${icon("chevR")}`, "preset-open", { "data-id": "orbit" }, "btn")}
        </section>
      </div>
    </section>`;
  }

  /* ==================== 视图：终端工作区（主角最大化） ==================== */
  /* 文件草稿按工作树隔离（treeId:相对路径），与移除工作树的草稿拦截一致 */
  function fileKey(item, index) {
    return item.tree + ":" + PROJECTS[item.project].files[index];
  }
  function fileValue(item, index) {
    const key = fileKey(item, index);
    if (Object.hasOwn(ui.files, key)) return ui.files[key];
    if (Object.hasOwn(ui.drafts, key)) return ui.drafts[key];
    return index === 0
      ? PROJECTS[item.project].file
      : "// " +
          PROJECTS[item.project].files[1] +
          "\n// Local demonstration content.\n\ndescribe('project behavior', () => {\n  // Review the associated terminal output before changing this test.\n});\n";
  }

  /* 并排格子：仅本工作树，最多 4。空数组 = 只有当前会话一格。 */
  function workspaceTiles(treeId, currentId) {
    let ids = (ui.wsTiles || []).filter((id) => {
      const s = sessionById(id);
      return s?.tree === treeId && isWorkingSession(s);
    });
    if (ids.length <= 1) return currentId ? [currentId] : ids;
    if (currentId && !ids.includes(currentId) && ids.length < 4) ids = [...ids, currentId];
    return [...new Set(ids)].slice(0, 4);
  }
  function unusedTreeSessions(treeId, tiles) {
    const taken = new Set(tiles);
    return sessions().filter((s) => s.tree === treeId && isWorkingSession(s) && !taken.has(s.id));
  }
  function openTilePicker(anchor, { mode, index, treeId, tiles }) {
    const replaceId = mode === "replace" ? tiles[index] : "";
    const list =
      mode === "add"
        ? unusedTreeSessions(treeId, tiles)
        : sessions().filter((s) => s.tree === treeId && isWorkingSession(s) && s.id !== replaceId);
    const html = `<div class="menu-label">${mode === "add" ? "选择要并排的会话 · 仅本工作树" : "更换此格会话 · 仅本工作树"}</div>
      ${list.length
        ? list
            .map((s) => {
              const inOther = tiles.includes(s.id);
              return `<button type="button" class="menu-item" data-action="${mode === "add" ? "tile-add" : "tile-set"}" data-session="${s.id}" data-index="${index ?? ""}">
                ${agentIcon(s.agent)}<span class="grow">${esc(displayName(s))}</span>
                <span class="dim">${esc(STATE_LABEL[stateOf(s)])}${inOther ? " · 已在另一格" : ""}</span>
              </button>`;
            })
            .join("")
        : '<div class="pad page-sub">本工作树没有可并排的其他会话。</div>'}`;
    openPopover(anchor, html, { width: 300 });
  }
  function popTileFromSplit(sessionId, pinned) {
    const item = sessionById(sessionId);
    if (!item) return;
    if (isUnavailable(item)) return toast("此会话不能在浮窗中打开。");
    const tiles = workspaceTiles(item.tree, ui.route.sessionId).filter((id) => id !== sessionId);
    ui.wsTiles = tiles;
    ui.float = { sessionId: item.id, visibility: "open", pinned: Boolean(pinned) };
    closeDialog(false);
    if (ui.route.sessionId === sessionId && tiles[0])
      navigate("#/workspace/" + encodeURIComponent(tiles[0]));
    else render();
    toast(pinned ? "已从并排置顶为浮窗。" : "已从并排弹出为浮窗。");
  }

  function terminalCard(item, secondary = false) {
    /* 用户结束或目录缺失的会话只读 */
    const readonly = isEnded(item) || isMissing(item);
    const lines = [...item.output, ...(ui.logs[item.id] || [])];
    const tree = treeOf(item);
    const out = lines
      .map((line, index) => {
        const cls = line.startsWith("›")
          ? "prompt"
          : line.includes("需要") || line.includes("中断")
            ? "highlight"
            : index === 0
              ? "output"
              : "";
        return `<div class="${cls}">${esc(line) || "<br>"}</div>`;
      })
      .join("");
    return `<div class="term${secondary ? " secondary" : ""}">
      <div class="term-head">
        <b>${esc(displayName(item))}</b>
        <span class="grow demo">${esc(item.agent)} · 演示输出 · 本地会话</span>
        ${readonly ? "" : btn(icon("popout"), "float-open", { "data-session": item.id, "aria-label": "在浮窗打开 " + displayName(item), title: "在浮窗打开" }, "btn-ghost icon-btn")}
        ${btn(isFollowed(item.id) ? "★" : "☆", "follow-toggle", { "data-session": item.id, "aria-label": (isFollowed(item.id) ? "取消关注 " : "关注 ") + displayName(item), "aria-pressed": isFollowed(item.id), title: isFollowed(item.id) ? "已关注" : "关注" }, `btn-ghost icon-btn star${isFollowed(item.id) ? " on" : ""}`)}
        ${secondary ? "" : btn("结束会话", "end-session", { "data-session": item.id }, "btn-ghost btn")}
      </div>
      <div class="term-cmd"><span class="prompt">${esc(PROJECTS[item.project].name)} $</span> ${esc(item.command)}</div>
      <div class="term-out">${out}</div>
      <form class="term-input" data-terminal-form="${esc(item.id)}">
        <span class="prompt">›</span>
        <input aria-label="模拟终端命令" value="${esc(ui.termDrafts[item.id] || "")}" placeholder="${readonly ? "会话已结束或目录缺失；仅可查看记录" : "继续输入；仅记录在原型，不执行命令"}" maxlength="500" autocomplete="off"${readonly ? " disabled" : ""}>
        <span class="hint">${readonly ? "只读历史" : "Enter 发送演示输入"}</span>
      </form>
      ${secondary ? "" : `<div class="term-foot">会话属于 ${esc(PROJECTS[item.project].name)} · ${esc(tree?.branch || "")} · 返回工作台不会关闭它</div>`}
    </div>`;
  }

  /* ==================== 视图：预设布局态工作区（v8） ==================== */
  /* 栏内 mock 差异：entry.view 指向的文件，+/− 行用 Primer 语义色 */
  function diffPane(item, entry) {
    const p = PROJECTS[item.project];
    const viewFile = String(entry.view || "").split(" · ")[1] || p.files[0];
    const del = item.project === "orbit" ? "dialog.focus()" : item.project === "pulse" ? "retryImmediately(response)" : "## Navigation";
    const add = item.project === "orbit" ? "focusFirstReachable(dialog)" : item.project === "pulse" ? "retryWithBackoff(response, retryPolicy)" : "## Start with a project";
    const note = item.project === "orbit" ? "Keep focus inside the active dialog" : item.project === "pulse" ? "Respect retry-after and idempotency" : "Keep the source visible when returning";
    return `<div class="diff pcol-diff">
      <div class="diff-file">${esc(viewFile)} <span>+2 −1 · 演示差异</span></div>
      <span class="line-num">18</span><span class="diff-del">- ${esc(del)}</span><br>
      <span class="line-num">18</span><span class="diff-add">+ ${esc(add)}</span><br>
      <span class="line-num">19</span><span class="diff-add">+ // ${esc(note)}</span>
    </div>`;
  }
  /* 栏内上下文 pane：关联文件 + 该 entry 的待审阅命令（逐条模拟输入到本栏会话） */
  function colContext(item, entry) {
    const p = PROJECTS[item.project];
    const pending = ui.pendingByTree[entry.tree] || entry.commands || [];
    return `<div class="pcol-ctx">
      <div class="pcol-ctx-sec"><b>关联文件</b>
        ${p.files.map((file) => `<span class="file-link as-text">${icon("file")}${esc(file)}</span>`).join("")}
      </div>
      ${
        pending.length
          ? `<div class="pcol-ctx-sec"><b>待审阅命令</b><p class="note">未自动执行。可逐条模拟输入。</p>${pending
              .map((command, index) => `<button type="button" class="cmd-opt" data-action="run-command" data-tree="${esc(entry.tree)}" data-session="${esc(item.id)}" data-index="${index}">${esc(command)}</button>`)
              .join("")}</div>`
          : ""
      }
    </div>`;
  }
  function viewPresetWorkspace() {
    const layout = ui.presetLayout;
    const cols = layout.entries
      .map((entry) => {
        const item = sessionById(entry.session);
        if (!item) return "";
        const tree = WORKTREES[entry.tree];
        const body =
          entry.layout === "focus"
            ? `<div class="pcol-body"><div class="pcol-term">${terminalCard(item)}</div></div>`
            : entry.layout === "review"
              ? `<div class="pcol-body"><div class="pcol-diffwrap">${diffPane(item, entry)}</div>${colContext(item, entry)}</div>`
              : `<div class="pcol-body"><div class="pcol-term">${terminalCard(item)}</div>${colContext(item, entry)}</div>`;
        return `<section class="preset-col" aria-label="${esc(tree?.branch || "")} 栏">
          <header class="pcol-head">
            ${icon("branch")}<span class="mono pcol-branch">${esc(tree?.branch || entry.tree)}</span>
            <span class="chip flat pcol-sess">${agentIcon(item.agent)}${esc(displayName(item))}</span>
            ${chip(stateOf(item))}
          </header>
          ${body}
        </section>`;
      })
      .join("");
    return `<section class="ws" aria-label="预设布局工作区">
      <header class="ws-top">
        ${btn(`${icon("back")}<span>返回${esc(ui.origin?.label || "起始页")}</span>`, "back", {}, "ws-back")}
        <span class="ws-chip">${icon("layers")}来自工作预设 · ${esc(layout.title)}</span>
        <div class="top-spacer"></div>
        ${btn("退出预设布局", "exit-preset", {}, "btn")}
      </header>
      <div class="ws-body"><div class="ws-center">
        <div class="ws-content preset-mode"><div class="preset-cols">${cols}</div></div>
      </div></div>
    </section>`;
  }

  function viewWorkspace() {
    const item = sessionById(ui.route.sessionId) || sessions()[0];
    /* v8：预设布局态接管工作区（隐藏全局 segmented tab 与右侧抽屉，每栏自包含） */
    if (ui.presetLayout) return viewPresetWorkspace();
    const p = PROJECTS[item.project];
    const tree = treeOf(item);
    const ended = isEnded(item);
    const originLabel = ui.origin?.label || "工作台";
    const treeSessions = sessions().filter((s) => s.tree === item.tree && (isWorkingSession(s) || s.id === item.id));
    const tiles = workspaceTiles(item.tree, item.id);
    ui.wsTiles = tiles;
    const unused = unusedTreeSessions(item.tree, tiles);

    /* 内容 tab：终端 | 文件 | 差异 */
    const fileName = p.files[ui.wsFile].split("/").at(-1);
    const draftDirty = Object.hasOwn(ui.drafts, fileKey(item, ui.wsFile));
    const tabs = [
      ["terminal", tr("终端", "Terminal"), "terminal"],
      ["file", fileName + (draftDirty ? " · 未保存" : ""), "file"],
      ["diff", isEnglish() ? `${p.files.length} changes` : `${p.files.length} 个差异`, "branch"],
    ]
      .map(
        ([tab, label, glyph]) =>
          `<button type="button" class="tab${ui.wsTab === tab ? " active" : ""}" data-action="ws-tab" data-tab="${tab}" aria-pressed="${ui.wsTab === tab}">${icon(glyph)}${esc(label)}</button>`,
      )
      .join("");

    /* 会话条：chip 切焦点；并排只加本工作树会话，最多 4 格 */
    const splitBtns =
      tiles.length < 2
        ? treeSessions.length > 1
          ? btn(icon("split") + "并排查看", "tile-open-add", { "aria-expanded": "false", title: "选择本工作树的另一个会话并排" }, "btn btn-ghost")
          : ""
        : `${tiles.length < 4 && unused.length ? btn(icon("plus") + "添加并排", "tile-open-add", { "aria-expanded": "false", title: "再加一格，最多 2×2" }, "btn btn-ghost") : ""}
          ${btn("退出并排", "tile-exit", { title: "只留当前会话" }, "btn btn-ghost")}`;
    const strip = `<div class="ws-strip">
      ${treeSessions
        .map(
          (s) =>
            `<button type="button" class="sess-chip${s.id === item.id ? " active" : ""}${tiles.includes(s.id) && tiles.length > 1 ? " tiled" : ""}" data-action="open-session" data-session="${s.id}">${agentIcon(s.agent)}${esc(s.agent)} · ${esc(displayName(s))}</button>`,
        )
        .join("")}
      ${splitBtns}
      <div class="top-spacer"></div>
      ${btn(`切换会话 ${icon("chevD")}`, "ws-switcher", { "aria-expanded": "false", "aria-label": "切换会话，含搜索与筛选" }, "btn btn-ghost")}
    </div>`;

    let content;
    if (ui.wsTab === "file") {
      content = `<div class="file-bar">
          <span class="path">${esc(p.files[ui.wsFile])}</span><span class="dim">本地演示草稿</span>
          <span class="grow"></span>
          ${btn("保存草稿", "ws-save-file", {}, "btn")}
          ${btn(icon("close"), "ws-close-file", { "aria-label": "关闭文件" }, "icon-btn")}
        </div>
        <textarea class="code-editor" aria-label="模拟文件编辑器" spellcheck="false" data-editor>${esc(fileValue(item, ui.wsFile))}</textarea>`;
    } else if (ui.wsTab === "diff") {
      const del = item.project === "orbit" ? "dialog.focus()" : item.project === "pulse" ? "retryImmediately(response)" : "## Navigation";
      const add = item.project === "orbit" ? "focusFirstReachable(dialog)" : item.project === "pulse" ? "retryWithBackoff(response, retryPolicy)" : "## Start with a project";
      const note = item.project === "orbit" ? "Keep focus inside the active dialog" : item.project === "pulse" ? "Respect retry-after and idempotency" : "Keep the source visible when returning";
      content = `<div class="diff">
        <div class="diff-file">${esc(p.files[0])} <span>+3 −1 · 演示差异</span></div>
        <span class="line-num">18</span><span class="diff-del">- ${esc(del)}</span><br>
        <span class="line-num">18</span><span class="diff-add">+ ${esc(add)}</span><br>
        <span class="line-num">19</span><span class="diff-add">+ // ${esc(note)}</span>
        <div class="diff-file">${esc(p.files[1])}</div>
        <span class="line-num">42</span><span class="diff-add">+ // Verify the project-specific behavior</span>
      </div>`;
    } else {
      const tileCards = tiles
        .map((id, index) => {
          const sess = sessionById(id);
          if (!sess) return "";
          const focused = sess.id === item.id;
          return `<div class="ws-tile${focused ? " focused" : ""}" data-action="tile-focus" data-session="${sess.id}" data-tile-index="${index}" title="${focused ? "当前窗口" : "点击切换到此窗口"}">
            <div class="ws-tile-bar" draggable="true" title="拖到其他格子换位置">
              <span class="ws-tile-grip" aria-hidden="true">${icon("more")}</span>
              ${agentIcon(sess.agent)}
              <span class="ws-tile-name">${esc(displayName(sess))}</span>
              ${focused ? '<span class="ws-tile-current">当前</span>' : ""}
              <span class="grow"></span>
              ${btn("换会话", "tile-open-set", { "data-index": String(index), "aria-expanded": "false", title: "更换此格会话，仅本工作树" }, "btn-ghost btn")}
              ${isUnavailable(sess) ? "" : btn("置顶", "tile-pin", { "data-session": sess.id, title: "从并排弹出并置顶为浮窗" }, "btn-ghost btn")}
              ${isUnavailable(sess) ? "" : btn(icon("popout"), "tile-pop", { "data-session": sess.id, "aria-label": "从并排弹出为浮窗", title: "从并排弹出为浮窗" }, "btn-ghost icon-btn")}
              ${tiles.length > 1 ? btn(icon("close"), "tile-close", { "data-index": String(index), "aria-label": "关闭此格", title: "关闭此格" }, "btn-ghost icon-btn") : ""}
            </div>
            ${terminalCard(sess, !focused)}
          </div>`;
        })
        .join("");
      content = `<div class="term-grid tiles-${tiles.length}">${tileCards}</div>`;
    }

    const replacement = renderContentSlot(ui.wsTab, {
      item,
      project: p,
      tree,
      path: p.files[ui.wsFile],
      fileIndex: ui.wsFile,
      tab: ui.wsTab,
      ui,
      value: fileValue(item, ui.wsFile),
      draft: ui.drafts[fileKey(item, ui.wsFile)],
    });
    if (replacement != null) content = replacement;

    /* 抽屉：作为内容网格中与终端卡同行的卡片（v6）；"文件"标题行与 term-head 水平对齐 */
    const sessionAttention = attentionItems().filter((ep) => ep.session === item.id && ep.kind !== "stalled");
    const pending = ui.pendingByTree[item.tree] || [];
    const inspector = ui.wsInspector
      ? `<aside class="inspector" aria-label="会话详情面板">
        <div class="ins-head">文件</div>
        <div class="ins-scroll">
        <div class="ins-block">
          <div class="input-wrap ins-filter">${icon("search")}<input data-ins-filter placeholder="筛选关联文件" aria-label="筛选关联文件"></div>
          ${p.files.map((file, index) => `<button type="button" class="file-link" data-action="ws-file" data-index="${index}">${icon("file")}${esc(file)}</button>`).join("")}
        </div>
        <div class="ins-block">
          <h3>会话信息</h3>
          ${chip(stateOf(item))}
          <p>${esc(item.summary)}</p>
          <p class="mono dim-s">${esc(tree?.path || p.path)}</p>
          ${sessionAttention.length ? `<p><b class="small-b">等待确认事项</b></p>` + sessionAttention.map((ep) => `<p>· ${esc(ep.title)}：${esc(ep.reason)}</p>`).join("") : ""}
        </div>
        ${
          pending.length
            ? `<div class="ins-block"><h3>待审阅命令</h3><p>未自动执行。可逐条模拟输入。</p>${pending
                .map((command, index) => `<button type="button" class="cmd-opt" data-action="run-command" data-tree="${esc(item.tree)}" data-index="${index}">${esc(command)}</button>`)
                .join("")}</div>`
            : ""
        }
        <div class="ins-block">
          <h3>恢复来源</h3>
          <p>${esc(ui.origin?.label || "起始页")}</p>
        </div>
        <div class="ins-block">
          <h3>重点关注</h3>
          ${btn(icon("star") + (isFollowed(item.id) ? "已关注 · 点击取消" : "关注此会话"), "follow-toggle", { "data-session": item.id, "aria-pressed": isFollowed(item.id) }, "btn")}
          ${isFollowed(item.id) ? btn("重命名关注项", "follow-rename", { "data-session": item.id }, "btn") : ""}
        </div>
        <div class="ins-block">
          ${btn(icon("bookmark") + (store.bookmarks.includes(item.id) ? "已加入书签" : "添加书签"), "bookmark", { "data-session": item.id }, "btn")}
          ${btn(icon("layers") + "保存为工作预设", "new-preset", {}, "btn")}
        </div>
        </div>
      </aside>`
      : "";

    return `<section class="ws" aria-label="终端工作区">
      <header class="ws-top">
        ${btn(`${icon("back")}<span>返回${esc(originLabel)}</span>`, "back", {}, "ws-back")}
        ${btn("网格", "ws-grid", { title: "回到当前项目的终端网格" }, "btn btn-ghost")}
        ${btn("上一个", "ws-prev", { title: "上一个同工作树会话（Alt ←）" }, "btn btn-ghost")}
        ${btn("下一个", "ws-next", { title: "下一个同工作树会话（Alt →）" }, "btn btn-ghost")}
        <button type="button" class="ws-chip" data-action="open-project" data-project="${item.project}" title="打开项目总览"><span class="dot ${p.color}"></span>${esc(p.name)}</button>
        <button type="button" class="ws-chip branch" data-action="open-tree" data-tree="${item.tree}" title="打开工作树概览">${icon("branch")}${esc(tree?.branch || "")}</button>
        <div class="top-spacer"></div>
        ${chip(stateOf(item), ended ? "已结束" : undefined)}
        ${btn(icon("panel"), "inspector-toggle", { "aria-label": ui.wsInspector ? "收起详情面板" : "展开详情面板", "aria-pressed": ui.wsInspector, title: "详情面板" }, "icon-btn")}
      </header>
      <div class="ws-body">
        <div class="ws-center">
          <nav class="ws-tabrow" aria-label="工作区内容"><div class="segctrl">${tabs}</div></nav>
          ${strip}
          <div class="ws-content${ui.wsInspector ? " with-drawer" : ""}"><div class="ws-pane">${content}</div>${inspector}</div>
        </div>
      </div>
    </section>`;
  }

  /* ==================== 浮动终端层（页面内真浮层） ==================== */
  function floatLayer() {
    if (ui.float.visibility === "closed") return "";
    const item = sessionById(ui.float.sessionId);
    if (!item) return "";
    const tree = treeOf(item);
    const readonly = isEnded(item) || isMissing(item);
    if (ui.float.visibility === "hidden")
      return `<div class="float-resume-wrap">
        ${btn(
          `${icon("terminal")}恢复浮窗 · ${esc(displayName(item))}`,
          "float-resume",
          { "aria-label": "恢复浮窗 " + displayName(item) },
          "btn float-resume",
        )}
        ${btn(icon("close"), "float-close", { "aria-label": "关闭已收起的浮窗", title: "关闭浮窗，不结束会话" }, "icon-btn float-resume-close")}
      </div>`;
    const lines = [...item.output, ...(ui.logs[item.id] || [])];
    return `<section class="float-term${ui.float.pinned ? " pinned" : ""}" aria-label="浮动终端">
      <header class="float-head">
        <div class="float-title"><b>${esc(displayName(item))}</b><small>${esc(PROJECTS[item.project].name)} · ${esc(tree?.branch || "目录不可用")}</small></div>
        ${btn(isFollowed(item.id) ? "★" : "☆", "follow-toggle", { "data-session": item.id, "aria-label": (isFollowed(item.id) ? "取消关注 " : "关注 ") + displayName(item), "aria-pressed": isFollowed(item.id), title: isFollowed(item.id) ? "已关注" : "关注" }, `btn-ghost icon-btn star${isFollowed(item.id) ? " on" : ""}`)}
        ${btn(ui.float.pinned ? "取消置顶" : "置顶", "float-pin", { "aria-pressed": ui.float.pinned, title: "置顶演示" }, "btn btn-ghost")}
        ${btn("收起", "float-hide", { title: "最小化到角落，会话继续运行" }, "btn btn-ghost")}
        ${btn(icon("close"), "float-close", { "aria-label": "关闭浮窗", title: "关闭浮窗，不结束会话" }, "icon-btn")}
      </header>
      <div class="float-cwd">${chip(stateOf(item))}<code>${esc(tree?.path || "目录已移除")}</code></div>
      <div class="float-out term-out">${lines.map((line) => `<div class="${line.startsWith("›") ? "prompt" : line.includes("需要") || line.includes("中断") ? "highlight" : ""}">${esc(line) || "<br>"}</div>`).join("")}</div>
      <form class="term-input float-input" data-float-form="${esc(item.id)}">
        <span class="prompt">›</span>
        <input aria-label="浮动终端输入" value="${esc(ui.termDrafts[item.id] || "")}" placeholder="${readonly ? "会话已结束；仅可查看记录" : "输入仅记录在原型中"}" maxlength="500" autocomplete="off"${readonly ? " disabled" : ""}>
        <span class="hint">${readonly ? "只读历史" : "Enter 发送演示输入"}</span>
      </form>
      <footer class="float-foot">
        ${btn("回主窗口", "float-main", {}, "btn btn-primary")}
        ${readonly ? "" : btn("结束会话", "end-session", { "data-session": item.id }, "btn btn-danger")}
      </footer>
    </section>`;
  }

  /* ==================== 浮层基础设施 ==================== */
  let toastTimer;
  function toast(message) {
    if (popover?.root.classList.contains("notification-popover")) {
      $("#live").textContent = message;
      return;
    }
    clearTimeout(toastTimer);
    $(".toast")?.remove();
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    $("#layers").append(node);
    $("#live").textContent = message;
    toastTimer = setTimeout(() => node.remove(), 3200);
  }

  let modal = null; // { root, invoker }
  function activeElements(root) {
    return [...root.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(
      (el) => !el.disabled && el.getClientRects().length,
    );
  }
  function openDialog(title, subtitle, body, footer = "", options = {}) {
    const invoker = options.invoker instanceof HTMLElement ? options.invoker : document.activeElement;
    closeDialog(false);
    closePopover();
    const root = document.createElement("div");
    const sheet = options.sheet;
    root.className = sheet ? "overlay sheet-overlay" : "overlay";
    const dialogClass = [
      "dialog",
      options.wide || sheet === "wide" ? "wide" : "",
      sheet ? "sheet" : "",
      sheet === "sm" ? "sheet-sm" : "",
      sheet === "md" ? "sheet-md" : "",
      options.variant === "create" ? "create-dlg" : "",
      options.palette ? "palette" : "",
    ].filter(Boolean).join(" ");
    const headIcon = options.icon
      ? `<span class="sheet-icon sheet-icon-${esc(options.tone || "primary")}">${icon(options.icon)}</span>`
      : "";
    const head = sheet || options.variant === "create"
      ? `<header class="dlg-head ${sheet ? "sheet-head" : "create-head"}">
          ${headIcon}
          <span class="sheet-head-text">
            <span class="sheet-head-row"><h2 id="dlg-title">${esc(title)}</h2>${options.count != null ? `<span class="sheet-count">${esc(options.count)}</span>` : ""}</span>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
          </span>
          ${options.palette ? "" : btn(icon("close"), "close-dialog", { "aria-label": "关闭" + title }, "icon-btn")}
        </header>`
      : `<header class="dlg-head">
          <div><h2 id="dlg-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>
          ${options.palette ? "" : btn(icon("close"), "close-dialog", { "aria-label": "关闭" + title }, "icon-btn")}
        </header>`;
    root.innerHTML = `<section class="${dialogClass}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      ${head}
      <div class="dlg-body">${body}</div>
      ${footer ? `<footer class="dlg-foot">${footer}</footer>` : ""}
    </section>`;
    $("#layers").append(root);
    modal = { root, invoker };
    root.addEventListener("click", (event) => {
      if (event.target === root) closeDialog();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
      }
      if (event.key !== "Tab") return;
      const els = activeElements(root);
      if (!els.length) return;
      const first = els[0], last = els.at(-1);
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (options.palette ? $("input", root) : activeElements(root)[0])?.focus();
    return root;
  }
  function closeDialog(restore = true) {
    if (!modal) return;
    const invoker = modal.invoker;
    modal.root.remove();
    modal = null;
    if (restore && invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
  }

  let popover = null; // { root, anchor }
  function stageRect() {
    const stage = document.querySelector(".app-stage");
    return (stage || document.documentElement).getBoundingClientRect();
  }
  function openPopover(anchor, html, options = {}) {
    closePopover();
    const root = document.createElement("div");
    root.className = "popover" + (options.cls ? " " + options.cls : "");
    root.innerHTML = html;
    $("#layers").append(root);
    popover = { root, anchor };
    const stage = stageRect();
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(options.width || 280, Math.max(160, stage.width - 16));
    root.style.minWidth = Math.min(options.width || 280, 420) + "px";
    let left = (options.align === "right" ? rect.right - width : rect.left) - stage.left;
    left = Math.max(8, Math.min(left, stage.width - width - 8));
    let top = rect.bottom - stage.top + 4;
    root.style.left = left + "px";
    root.style.top = top + "px";
    root.style.minWidth = width + "px";
    const box = root.getBoundingClientRect();
    if (box.bottom > stage.bottom - 24) {
      root.style.top = Math.max(8, rect.top - stage.top - box.height - 4) + "px";
    }
    return root;
  }
  function closePopover() {
    if (!popover) return;
    if (popover.anchor instanceof HTMLElement) popover.anchor.setAttribute("aria-expanded", "false");
    popover.root.remove();
    popover = null;
  }
  document.addEventListener("pointerdown", (event) => {
    if (!popover) return;
    if (popover.root.contains(event.target) || popover.anchor?.contains(event.target)) return;
    closePopover();
  });

  /* ==================== 浮层：命令面板（Ctrl+K，合并切换终端） ==================== */
  function openPalette(invoker) {
    const actions = [
      { id: "act-create", group: "动作", label: "新建终端", hint: "创建后直达会话", glyph: "plus", run: () => openCreate() },
      { id: "act-inbox", group: "动作", label: "打开待处理队列", hint: `${inboxCount()} 项`, glyph: "inbox", run: () => navigate("#/inbox") },
      { id: "act-history", group: "动作", label: "打开所有终端", hint: "查找会话与记录", glyph: "terminal", run: () => navigate("#/terminals") },
      { id: "act-presets", group: "动作", label: "打开工作预设", hint: "预览后恢复", glyph: "layers", run: () => navigate("#/presets") },
      { id: "act-theme", group: "动作", label: store.theme === "dark" ? "切换到浅色外观" : "切换到深色外观", hint: "外观", glyph: "sun", run: () => setTheme(store.theme === "dark" ? "light" : "dark") },
      ...Object.entries(PROJECTS)
        .filter(([pid]) => !isDeletedProject(pid))
        .map(([pid, p]) => ({
        id: "proj-" + pid, group: "项目", label: p.name, hint: `${p.path} · ${isArchivedProject(pid) ? "已归档 · " : ""}项目总览`, glyph: "folder",
        run: () => navigate("#/project/" + encodeURIComponent(pid)),
      })),
      ...pinnedSessions().map((item) => ({
        id: "pinned-" + item.id, group: "快捷选择", label: `${PROJECTS[item.project].name} · ${item.agent} · ${displayName(item)}`,
        hint: "已固定 · 快捷选择", glyph: "star", agent: item.agent, disabled: isUnavailable(item),
        run: () => openSession(item.id),
      })),
      ...sessions()
        .filter((item) => !isCatalogGoneSession(item))
        .map((item) => ({
        id: item.id, group: "会话", label: `${PROJECTS[item.project].name} · ${item.agent} · ${displayName(item)}`,
        hint: (isArchivedSession(item.id) ? "已归档 · " : "") + STATE_LABEL[stateOf(item)], glyph: "terminal", agent: item.agent,
        disabled: isUnavailable(item),
        floatable: !isUnavailable(item),
        run: () => openSession(item.id),
      })),
    ];
    const body = `<input class="palette-input" aria-label="搜索命令" placeholder="搜索命令、项目、会话，或切换终端…">
      <div class="palette-results"></div>
      <div class="palette-foot"><span>↑ ↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></div>`;
    const root = openDialog("命令面板", "", body, "", { invoker, palette: true });
    const input = $("input", root);
    let filtered = actions, selected = 0;
    const paint = () => {
      let lastGroup = "";
      $(".palette-results", root).innerHTML = filtered.length
        ? filtered
            .map((command, index) => {
              const group = command.group !== lastGroup ? `<div class="cmd-group">${command.group}</div>` : "";
              lastGroup = command.group;
              const row = `<button type="button" class="cmd-row${index === selected ? " active" : ""}" data-cmd="${esc(command.id)}"${command.disabled ? " disabled" : ""}>${command.agent ? agentIcon(command.agent) : icon(command.glyph)}<b>${esc(command.label)}</b><span>${esc(command.hint)}</span></button>`;
              /* 会话行附「在浮窗打开」快捷钮 */
              const floatBtn = command.floatable
                ? `<button type="button" class="icon-btn cmd-float" data-cmd-float="${esc(command.id)}" aria-label="在浮窗打开 ${esc(command.label)}" title="在浮窗打开">${icon("popout")}</button>`
                : "";
              return group + (floatBtn ? `<div class="cmd-wrap">${row}${floatBtn}</div>` : row);
            })
            .join("")
        : `<div class="empty"><b>没有匹配命令</b><p>试试项目名或会话名。</p></div>`;
      root.querySelectorAll("[data-cmd]").forEach((el) =>
        el.addEventListener("click", () => {
          const command = actions.find((c) => c.id === el.dataset.cmd);
          closeDialog(false);
          command?.run();
        }),
      );
      root.querySelectorAll("[data-cmd-float]").forEach((el) =>
        el.addEventListener("click", () => {
          const item = sessionById(el.dataset.cmdFloat);
          if (!item || isUnavailable(item)) return;
          ui.float = { sessionId: item.id, visibility: "open", pinned: false };
          closeDialog(false);
          render();
          $("[data-float-form] input")?.focus();
        }),
      );
    };
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      filtered = actions.filter((c) => (c.label + " " + c.hint).toLowerCase().includes(q));
      selected = 0;
      paint();
    });
    input.addEventListener("keydown", (event) => {
      const enabled = filtered.filter((c) => !c.disabled);
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % (filtered.length || 1);
        paint();
        $(".cmd-row.active", root)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[selected] && !filtered[selected].disabled ? filtered[selected] : enabled[0];
        if (command) {
          closeDialog(false);
          command.run();
        }
      }
    });
    paint();
  }

  /* ==================== 浮层：新建终端 ==================== */
  const AGENT_COMMAND = { Claude: "claude", Codex: "codex", Gemini: "gemini", Shell: "pnpm dev" };
  function openCreate(invoker, preferredTree = "", preferredProject = "", preferredAgent = "", preferredName = "") {
    if (creatorExtension)
      return creatorExtension({ invoker, preferredTree, preferredProject, preferredAgent, preferredName });
    const alive = (t) => t && !t.missing && isSidebarTree(t.id);
    const firstTree = (pid) =>
      Object.values(WORKTREES).find((t) => t.project === pid && alive(t))?.id || "";
    const initialTree =
      WORKTREES[preferredTree] && alive(WORKTREES[preferredTree])
        ? preferredTree
        : firstTree(PROJECTS[preferredProject] ? preferredProject : "orbit") || firstTree("orbit");
    const initialProject = WORKTREES[initialTree]?.project || preferredProject || "orbit";
    const initialAgent = AGENTS.includes(preferredAgent) ? preferredAgent : "Claude";
    const treeOptions = (pid) =>
      Object.values(WORKTREES)
        .filter((t) => t.project === pid && alive(t))
        .map((t) => `<option value="${t.id}"${t.id === initialTree && t.project === pid ? " selected" : ""}>${esc(t.branch)} · ${esc(t.path)}</option>`)
        .join("");
    const body = `<form id="create-form">
      <div class="field"><label for="c-project">项目 <small>演示项目，不访问文件系统</small></label>
        <select id="c-project">${Object.entries(PROJECTS).filter(([id]) => isSidebarProject(id) || id === initialProject).map(([id, p]) => `<option value="${id}"${id === initialProject ? " selected" : ""}>${esc(p.name)} · ${esc(p.path)}</option>`).join("")}</select></div>
      <div class="field"><label for="c-tree">Worktree <small id="c-cwd"></small></label>
        <select id="c-tree">${treeOptions(initialProject)}</select></div>
      <div class="field"><label for="c-agent">Agent</label>
        <select id="c-agent">${AGENTS.map((a) => `<option${a === initialAgent ? " selected" : ""}>${a}</option>`).join("")}</select></div>
      <div class="field"><label for="c-dir">目录 <small>跟随所选 worktree</small></label>
        <input id="c-dir" readonly tabindex="-1" aria-label="工作目录"></div>
      <div class="field"><label for="c-name">会话名称</label><input id="c-name" value="${esc(preferredName || "开发会话")}" maxlength="60" required></div>
      <div class="field"><label for="c-command">命令预览 <small>仅演示，不会执行</small></label><input id="c-command" value="${esc(AGENT_COMMAND[initialAgent])}" maxlength="500" required></div>
      <div class="form-note">${icon("shield")}创建后直接进入新会话；返回不会关闭它。</div>
    </form>`;
    const root = openDialog("新建终端", "选项目，开会话，然后直接开始。", body,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="create-form">创建 ${icon("chevR")}</button>`,
      { invoker });
    const syncDir = () => {
      const tree = WORKTREES[$("#c-tree", root).value];
      $("#c-dir", root).value = tree?.path || "当前项目没有可用工作树";
      $("#c-cwd", root).textContent = tree ? "将在 " + tree.path + " 中创建" : "";
    };
    $("#c-project", root).addEventListener("change", (event) => {
      $("#c-tree", root).innerHTML = treeOptions(event.target.value);
      syncDir();
    });
    $("#c-tree", root).addEventListener("change", syncDir);
    $("#c-agent", root).addEventListener("change", (event) => {
      $("#c-command", root).value = AGENT_COMMAND[event.target.value] || "pnpm dev";
    });
    syncDir();
    $("#create-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("#c-name", root).value.trim();
      const command = $("#c-command", root).value.trim();
      const tree = WORKTREES[$("#c-tree", root).value];
      const agent = $("#c-agent", root).value;
      if (!name || !command || !tree) return;
      const id = "demo-" + Date.now();
      store.userSessions.push({
        id, project: tree.project, tree: tree.id, name, command, agent,
        state: "running", detail: "运行中", time: "刚刚",
        summary: "你刚创建的本地演示会话。",
        output: [
          `${agent} · ${PROJECTS[tree.project].name}`,
          "› " + command,
          "",
          "会话创建成功。你现在就在新会话里。",
          "所有输入只记录在原型，不执行 Shell 或 AI 请求。",
        ],
      });
      save();
      closeDialog(false);
      openSession(id);
      toast("已创建 " + name + "，直接进入对应会话。");
    });
  }

  /* ==================== 浮层：通知 / 设置菜单 / 场景菜单 ==================== */
  function openScopePicker(anchor) {
    const choices = [["all", tr("全部项目", "All projects")], ...orderedProjectIds().map((id) => [`project:${id}`, PROJECTS[id].name]), ...Object.values(WORKTREES).filter((tree) => isSidebarTree(tree.id)).map((tree) => [tree.id, `${PROJECTS[tree.project].name} · ${tree.branch}`])];
    openPopover(anchor, `<div class="menu-label">${tr("项目范围", "Project scope")}</div>${choices.map(([id, label]) => `<button type="button" class="menu-item" data-action="scope-set" data-scope="${esc(id)}">${esc(label)}<span class="dim">${ui.sidebarScope === id ? "✓" : ""}</span></button>`).join("")}<div class="menu-note">筛选侧栏、最近会话、待处理和终端列表；保留当前页面。</div>`, { width: 280 });
  }
  function openNotifications(anchor) {
    const items = actionableAttention();
    const html = `<div class="menu-label">通知 · 需要你处理的事项</div>
      ${items.length
        ? items
            .map((ep) => {
              const unread = !store.notifRead.includes(ep.id);
              return `<button type="button" class="notif-item" data-action="notif-open" data-episode="${ep.id}">
                <span class="${unread ? "unread-dot" : "read-dot"}"></span>
                <span><b>${esc(ep.title)}</b><p>${esc(displayName(ep.item))} · ${esc(ep.reason)}</p></span>
              </button>`;
            })
            .join("")
        : '<div class="pad page-sub">暂时没有需要处理的事项。</div>'}
      <div class="menu-sep"></div>
      <button type="button" class="menu-item" data-action="nav" data-route="inbox">查看全部待处理<span class="dim">${items.length}</span></button>
      ${appendMenuExtensions("notification", { anchor, items })}`;
    openPopover(anchor, html, { width: 320, align: "right", cls: "notification-popover" });
  }

  function openSettingsMenu(anchor) {
    const html = `<div class="menu-label">${tr("外观", "Appearance")}</div>
      <button type="button" class="menu-item" data-action="theme-set" data-theme="light">${icon("sun")}${tr("浅色（暖米）", "Light (warm)")}<span class="dim">${store.theme === "light" ? "✓" : ""}</span></button>
      <button type="button" class="menu-item" data-action="theme-set" data-theme="dark">${icon("moon")}${tr("深色（炭黑）", "Dark (charcoal)")}<span class="dim">${store.theme === "dark" ? "✓" : ""}</span></button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item" data-action="new-directory-project">${icon("folder")}${tr("添加本地目录", "Add local directory")}</button>
      <button type="button" class="menu-item" data-action="nav" data-route="pro">${icon("spark")}Local Pro${store.trial ? '<span class="dim">演示中</span>' : ""}</button>
      <button type="button" class="menu-item" data-action="about">${icon("info")}${tr("关于这个原型", "About this prototype")}</button>
      ${appendMenuExtensions("settings", { anchor })}`;
    /* 侧栏底部用户行弹出：向左对齐并自动上翻 */
    openPopover(anchor, html, { width: 220 });
  }

  function openScenarioMenu(anchor) {
    const scenes = [
      ["daily", "home", "日常继续工作", "工作台 → 会话 → 返回"],
      ["return", "bell", "被打断后返回", "通知 → 待处理队列"],
      ["next", "layers", "第二天恢复", "预设 → 审阅 → 确认"],
      ["pro", "spark", "看看免费与 Pro", "核心体验免费，增强主动选择"],
      ["welcome", "home", "首次启动引导", "重看欢迎与产品定位"],
      ["project", "folder", "项目主页 · 有关注", "简报：指标 + 需要关注"],
      ["project-quiet", "folder", "项目主页 · 关注为空", "关注区整块收起"],
      ["worktree", "branch", "分支主页 · 有关注", "会话粒度 + 本分支用量"],
      ["worktree-quiet", "branch", "分支主页 · 关注为空", "关注收起，用量仍在"],
    ];
    const html = `<div class="menu-label">原型导览 · 选择一个使用时刻</div>
      ${scenes.map(([id, glyph, label, hint]) => `<button type="button" class="menu-item" data-action="scenario-pick" data-scene="${id}">${icon(glyph)}${label}<span class="dim">${hint}</span></button>`).join("")}
      ${appendMenuExtensions("scenario", { anchor, scenes: [...scenes] })}`;
    openPopover(anchor, html, { width: 320 });
  }

  /* ==================== 浮层：起始页 composer 的预选菜单 ==================== */
  function openComposerPick(anchor, kind) {
    const c = ui.composer;
    let options, current;
    if (kind === "project") {
      options = Object.entries(PROJECTS).filter(([id]) => isSidebarProject(id)).map(([id, p]) => [id, p.name]);
      current = c.project;
    } else if (kind === "tree") {
      options = Object.values(WORKTREES)
        .filter((t) => t.project === c.project && !t.missing && isSidebarTree(t.id))
        .map((t) => [t.id, t.branch]);
      current = c.tree;
    } else {
      options = AGENTS.map((a) => [a, a]);
      current = c.agent;
    }
    const label = { project: "项目", tree: "Worktree", agent: "Agent" }[kind];
    const html = `<div class="menu-label">${label}</div>
      ${options.map(([value, text]) => `<button type="button" class="menu-item" data-action="composer-set" data-kind="${kind}" data-value="${esc(value)}">${esc(text)}<span class="dim">${value === current ? "✓" : ""}</span></button>`).join("")}`;
    openPopover(anchor, html, { width: 240 });
  }

  /* ==================== 浮层：待处理详情 / 规则 / 重点关注 ==================== */
  function openAttentionDetail(episodeId, invoker) {
    const ep = attentionSource().find((e) => e.id === episodeId);
    const item = ep && sessionById(ep.session);
    if (!ep || !item) return toast("这条需要处理的信息已不可用。");
    openDialog(ep.title, "这是浏览器内的演示信息，不会批准请求或执行命令。",
      `<p class="dlg-text">${esc(ep.reason)}</p>
       <dl class="kv mt16">
         <dt>终端</dt><dd>${esc(displayName(item))} · ${esc(PROJECTS[item.project].name)}</dd>
         <dt>类型</dt><dd>${esc(KIND_LABEL[ep.kind])}</dd>
         <dt>下一步</dt><dd>先查看该终端的上下文，再决定是否标为已处理。</dd>
       </dl>`,
      btn("取消", "close-dialog", {}, "btn") +
        btn("打开终端", "attention-open", { "data-session": item.id }, "btn") +
        btn("标为已处理", "attention-resolve", { "data-episode": ep.id }, "btn btn-primary"),
      { invoker });
  }

  function openInboxRowMenu(anchor, episodeId) {
    const ep = attentionSource().find((e) => e.id === episodeId);
    if (!ep) return;
    const followed = isFollowed(ep.session);
    const html = `
      <button type="button" class="menu-item" data-action="follow-toggle" data-session="${esc(ep.session)}">${icon("star")}${followed ? "取消关注" : "关注"}</button>
      <button type="button" class="menu-item" data-action="attention-resolve" data-episode="${esc(ep.id)}">${icon("check")}标为已处理</button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item" data-action="attention-ignore" data-episode="${esc(ep.id)}">${icon("close")}忽略此项</button>`;
    openPopover(anchor, html, { width: 200, align: "right" });
  }

  function openStalledRules(invoker) {
    const rule = store.stalledRule;
    const body = `<form id="stalled-form">
      <label class="checkline"><input type="checkbox" name="enabled"${rule.enabled ? " checked" : ""}> 启用停滞提醒</label>
      <div class="field mt12"><label for="stalled-minutes">无输出分钟数</label>
        <input type="number" id="stalled-minutes" name="threshold" min="5" max="240" value="${rule.thresholdMinutes}"></div>
      <p class="note">默认 30 分钟。演示中的开发服务器会依据此规则单独提示，不计入需要处理项。它不等同失败，也不会自动结束或执行命令。</p>
    </form>`;
    const root = openDialog("停滞提醒规则", "仅当会话长时间无输出时提示。", body,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="stalled-form">保存规则</button>`, { invoker });
    $("#stalled-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      store.stalledRule = {
        enabled: form.get("enabled") === "on",
        thresholdMinutes: Math.max(5, Math.min(240, Number(form.get("threshold")) || 30)),
      };
      save();
      closeDialog(false);
      render();
      toast("已保存本地停滞提醒规则。");
    });
  }

  /* ==================== 浮层：重点关注管理（添加关注 / 重命名 / 关注项菜单） ==================== */
  function openFollowAdd(invoker) {
    const list = sessions().filter((item) => !isCatalogGoneSession(item));
    /* 临时集合：确认才写入 store，取消不改变现有关注 */
    const picked = new Set(store.followed);
    const alreadyFollowed = new Set(store.followed);
    const body = `<form id="follow-add-form" class="sheet-form">
      <div class="sheet-filters">
        <label class="sheet-search">${icon("search")}<input type="text" name="follow-search" placeholder="搜索终端：名称或项目" aria-label="搜索终端"></label>
      </div>
      <div class="sheet-scroll" data-follow-options>
        ${list
          .map((item) => {
            const already = alreadyFollowed.has(item.id);
            return `<label class="follow-manage-row sheet-card${already ? " is-followed" : ""}">
              <input type="checkbox" data-follow-pick value="${esc(item.id)}"${picked.has(item.id) ? " checked" : ""}${already ? " disabled" : ""}>
              <span class="sheet-card-icon">${agentIcon(item.agent)}</span>
              <span class="sheet-card-main">
                <strong>${esc(displayName(item))}</strong>
                <small>${esc(PROJECTS[item.project].name)} · ${esc(treeOf(item)?.branch || "目录不可用")} · ${esc(STATE_LABEL[stateOf(item)])}</small>
              </span>
              ${already ? `<span class="sheet-card-tag">${icon("check")}已关注</span>` : ""}
            </label>`;
          })
          .join("")}
      </div>
    </form>`;
    const root = openDialog("添加关注", "选择要放在工作台重点关注里的终端。确认后生效，取消不改变现有集合。", body,
      `<span class="sheet-foot-meta" data-follow-count></span>${btn("取消", "close-dialog", {}, "btn")}<button class="btn btn-primary" type="submit" form="follow-add-form">确认</button>`,
      { invoker, sheet: "md", icon: "star", tone: "primary" });
    const syncCount = () => {
      const count = [...picked].filter((id) => !alreadyFollowed.has(id)).length;
      const node = $("[data-follow-count]", root);
      if (node) node.textContent = count ? `新选 ${count} 项` : "未选择新终端";
    };
    $("[name='follow-search']", root).addEventListener("input", (event) =>
      root.querySelectorAll(".follow-manage-row").forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(event.target.value.toLowerCase());
      }),
    );
    root.querySelectorAll("[data-follow-pick]").forEach((input) =>
      input.addEventListener("change", () => {
        if (input.checked) picked.add(input.value);
        else picked.delete(input.value);
        syncCount();
      }),
    );
    syncCount();
    $("#follow-add-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      store.followed = [...picked];
      save();
      closeDialog(false);
      render();
      toast("已更新重点关注。");
    });
  }

  function openFollowMenu(anchor, sessionId) {
    const item = sessionById(sessionId);
    if (!item) return;
    const unavailable = isUnavailable(item);
    const html = `
      <button type="button" class="menu-item" data-action="${unavailable ? "view-history" : "open-session"}" data-session="${esc(item.id)}">${icon("terminal")}${unavailable ? "查看记录" : "打开"}</button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item" data-action="follow-rename" data-session="${esc(item.id)}">${icon("file")}重命名</button>
      <button type="button" class="menu-item" data-action="follow-toggle" data-session="${esc(item.id)}">${icon("close")}取消关注</button>`;
    openPopover(anchor, html, { width: 200, align: "right" });
  }

  function openRename(invoker, sessionId) {
    const item = sessionById(sessionId);
    if (!item) return;
    const body = `<form id="rename-form">
      <div class="field"><label for="rename-input">显示名称</label>
        <input id="rename-input" value="${esc(displayName(item))}" maxlength="60" required></div>
      <p class="note">名称只在本原型显示，所有入口同步；不改变会话或工作树身份。输入会话原名（${esc(item.name)}）可恢复默认。</p>
    </form>`;
    const root = openDialog("重命名关注项", item.name, body,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="rename-form">保存</button>`, { invoker });
    $("#rename-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("#rename-input", root).value.trim().slice(0, 60);
      if (!name) return;
      if (name === item.name) delete store.aliases[item.id];
      else store.aliases[item.id] = name;
      save();
      closeDialog(false);
      render();
      toast("已重命名；所有入口同步新名称。");
    });
  }

  /* ==================== 浮层：工作预设预览 / 新建 ==================== */
  function presetById(id) {
    return [...PRESETS, ...store.savedPresets].find((p) => p.id === id);
  }
  function openPresetPreview(id, invoker) {
    const preset = presetById(id);
    if (!preset) return toast("没有找到这个演示预设。");
    const entries = preset.entries
      .map((entry, index) => {
        const tree = WORKTREES[entry.tree];
        const session = sessionById(entry.session);
        const blocked = !tree || tree.missing || (session && isEnded(session));
        return `<section class="preset-entry">
          <label class="checkline">
            <input type="checkbox" data-preset-entry="${index}"${blocked ? " disabled" : " checked"}>
            <b>${esc(tree?.branch || entry.tree)}</b>
            <span class="dim-s">${blocked ? "不可用 · 仅历史" : "选择恢复此工作树"}</span>
          </label>
          <dl class="kv mt8">
            <dt>目录</dt><dd><code>${esc(tree?.path || "保存的工作树已无法解析")}</code></dd>
            <dt>会话</dt><dd>${esc(session ? displayName(session) : "不可用")}</dd>
            <dt>视图</dt><dd>${esc(entry.view)} · ${esc(LAYOUT_NAME[entry.layout])}</dd>
          </dl>
          ${
            entry.commands.length
              ? `<b class="small-b">待审阅命令</b>` +
                entry.commands
                  .map((command, ci) => `<label class="cmd-check"><input type="checkbox" data-entry-command="${index}:${ci}" checked${blocked ? " disabled" : ""}><code>${esc(command)}</code></label>`)
                  .join("")
              : '<p class="note">此工作树没有待审阅命令。</p>'
          }
        </section>`;
      })
      .join("");
    const body = `<div class="field"><label>布局示意 <small>只渲染勾选的工作树</small></label><div data-preset-map></div></div>
      <dl class="kv">
        <dt>项目</dt><dd>${esc(PROJECTS[preset.project].name)}</dd>
        <dt>保存范围</dt><dd>${preset.entries.length} 棵工作树</dd>
        <dt>安全边界</dt><dd>只恢复视图与待审阅命令；不覆盖文件草稿或终端输入</dd>
      </dl>
      ${entries}
      <p class="note">只带回你勾选的命令。恢复布局不会执行它们。</p>
      <p class="error-text" role="alert"></p>`;
    const root = openDialog("预览工作预设 · " + preset.title, "逐棵选择工作树与命令；确认前不会修改工作区。", body,
      btn("取消", "close-dialog", {}, "btn") + btn(`确认并恢复 ${icon("chevR")}`, "preset-confirm", { "data-id": esc(id) }, "btn btn-primary"),
      { invoker, wide: true });
    const sync = () => {
      /* 取消勾选工作树时，顶部布局示意联动减少一栏 */
      const checked = [...root.querySelectorAll("[data-preset-entry]:checked:not(:disabled)")].map(
        (input) => preset.entries[Number(input.dataset.presetEntry)],
      );
      $("[data-preset-map]", root).innerHTML = presetMap(preset, { entries: checked, large: true });
      const any = checked.length > 0;
      $(".error-text", root).textContent = any ? "" : "至少选择一棵可用工作树，才能确认恢复。";
      $('[data-action="preset-confirm"]', root).disabled = !any;
    };
    root.querySelectorAll("[data-preset-entry]").forEach((input) => input.addEventListener("change", sync));
    sync();
  }

  function confirmPreset(id) {
    const preset = presetById(id);
    if (!preset || !modal) return;
    const root = modal.root;
    const chosen = [...root.querySelectorAll("[data-preset-entry]:checked:not(:disabled)")].map((input) =>
      preset.entries[Number(input.dataset.presetEntry)],
    );
    if (!chosen.length) return;
    for (const [index, entry] of chosen.entries()) {
      const entryIndex = preset.entries.indexOf(entry);
      const commands = [...root.querySelectorAll(`[data-entry-command^="${entryIndex}:"]:checked`)]
        .map((input) => entry.commands[Number(input.dataset.entryCommand.split(":")[1])])
        .filter(Boolean);
      ui.pendingByTree[entry.tree] = commands;
      if (index === 0) ui.pendingFirst = entry;
    }
    /* v8：恢复 = 真正恢复布局——按勾选的 entries 进入预设布局态（N 栏并排） */
    ui.presetLayout = {
      title: preset.title,
      entries: chosen.map((entry) => ({ ...entry })),
    };
    const first = chosen[0];
    closeDialog(false);
    if (sessionById(first.session) && !isUnavailable(sessionById(first.session))) {
      openSession(first.session);
    } else {
      navigate("#/workbench");
    }
    toast(`已恢复 ${chosen.length} 棵工作树的预设布局。命令清单已带回，未自动执行。`);
  }

  function openNewPreset(invoker) {
    /* 预览与保存共用同一合成 entry：项目第一个可用工作树 + 其第一个会话 */
    const synthPreset = (project, layout) => {
      const tree = Object.values(WORKTREES).find((t) => t.project === project && !t.missing && !isRemovedTree(t.id));
      const session = sessions().find((s) => s.tree === tree?.id);
      return {
        project,
        entries: [{ tree: tree?.id || "", session: session?.id || "", view: "终端", layout, commands: [] }],
      };
    };
    const body = `<form id="preset-form">
      <div class="field"><label for="p-name">预设名称</label><input id="p-name" value="我的工作上下文" maxlength="60" required></div>
      <div class="field"><label for="p-project">项目</label>
        <select id="p-project">${Object.entries(PROJECTS).map(([id, p]) => `<option value="${id}">${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="p-layout">工作区默认布局</label>
        <select id="p-layout">${Object.entries(LAYOUT_NAME).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div>
      <div class="field"><label>布局示意 <small>跟随项目与布局联动</small></label><div data-preset-map></div></div>
      <div class="field"><label for="p-commands">通用待审阅命令 <small>每行一条</small></label>
        <textarea id="p-commands" rows="4" maxlength="3000">git status --short
git diff</textarea></div>
      <div class="field"><label for="p-filter">恢复时保留的历史筛选</label>
        <select id="p-filter"><option value="all">全部</option><option value="needs">需要处理</option><option value="bookmarks">书签</option></select></div>
      <p class="note">保存与打开均不会执行命令，也不会保存文件草稿或终端未发送输入。</p>
      ${store.trial ? "" : '<p class="note">保存预设是 Pro 增强。点击下方按钮将明确开启本地演示授权；没有付款或联网。</p>'}
    </form>`;
    const root = openDialog("保存工作预设", "把重复的工作准备保存下来。", body,
      btn("取消", "close-dialog", {}, "btn") +
        `<button class="btn btn-primary" type="submit" form="preset-form">${store.trial ? "保存预设" : "开启 Pro 演示并保存"}</button>`,
      { invoker });
    const syncMap = () => {
      $("[data-preset-map]", root).innerHTML = presetMap(
        synthPreset($("#p-project", root).value, $("#p-layout", root).value),
        { large: true },
      );
    };
    $("#p-project", root).addEventListener("change", syncMap);
    $("#p-layout", root).addEventListener("change", syncMap);
    syncMap();
    $("#preset-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const title = $("#p-name", root).value.trim();
      if (!title) return;
      const project = $("#p-project", root).value;
      const layout = $("#p-layout", root).value;
      const commands = $("#p-commands", root).value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20);
      const tree = Object.values(WORKTREES).find((t) => t.project === project && !t.missing);
      const session = sessions().find((s) => s.tree === tree?.id);
      store.savedPresets.push({
        id: "saved-" + Date.now(),
        title, project, layout, pro: true,
        filter: $("#p-filter", root).value,
        commands,
        entries: [{ tree: tree?.id || "", session: session?.id || "", view: "终端", layout, commands }],
      });
      store.trial = true;
      save();
      closeDialog(false);
      navigate("#/presets");
      render();
      toast(`已保存「${title}」。下次仍可预览后恢复。`);
    });
  }

  /* ==================== 浮层：结束会话 / 重新定位 / 关于 ==================== */
  function openEndSession(sessionId, invoker) {
    const item = sessionById(sessionId);
    if (!item) return;
    const tree = treeOf(item);
    openDialog(`结束「${displayName(item)}」？`, "结束后保留输出和历史，但不能继续输入。",
      `<dl class="kv"><dt>目标</dt><dd>${esc(PROJECTS[item.project].name)} · ${esc(tree?.branch || "")}</dd><dt>目录</dt><dd><code>${esc(tree?.path || "")}</code></dd></dl>
       <p class="dlg-text">不会关闭真实终端，也不会执行系统命令。</p>`,
      btn("取消", "close-dialog", {}, "btn") + btn("确认结束", "end-session-confirm", { "data-session": item.id }, "btn btn-danger"),
      { invoker });
  }

  function openRelocate(treeId, invoker) {
    const tree = WORKTREES[treeId];
    if (!tree) return;
    const body = `<form id="relocate-form">
      <div class="field"><label for="relocate-path">新目录</label><input id="relocate-path" required maxlength="300" placeholder="D:/demo/orbit-web-legacy"></div>
      <p class="note">历史保持只读，直到你明确提供一个未冲突目录。仅模拟，不访问文件系统。</p>
    </form>`;
    const root = openDialog("重新定位缺失工作树", "为 " + tree.branch + " 指定一个新目录。", body,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="relocate-form">确认重新定位</button>`, { invoker });
    $("#relocate-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const path = $("#relocate-path", root).value.trim();
      if (!/^(?:[a-z]:[\\/]|\/)/i.test(path) || path.includes("..")) return toast("请输入不含 .. 的绝对目录。");
      if (Object.values(WORKTREES).some((other) => other.id !== treeId && !isRemovedTree(other.id) && other.path.toLowerCase() === path.toLowerCase()))
        return toast("该目录已属于另一工作树；不会覆盖身份。");
      tree.path = path;
      tree.missing = false;
      tree.detail = "已重新定位 · 仅历史";
      store.removedTrees = store.removedTrees.filter((id) => id !== treeId);
      save();
      const item = sessions().find((s) => s.tree === treeId);
      if (item && item.state === "stalled") {
        item.state = "ended";
        item.detail = "已重新定位 · 仅历史";
      }
      closeDialog(false);
      render();
      toast("已重新定位。请从历史明确选择会话继续。");
    });
  }

  /* ==================== 浮层：新建 / 移除工作树 ==================== */
  function openNewTree(invoker, projectId) {
    const project = PROJECTS[projectId] ? projectId : "orbit";
    const p = PROJECTS[project];
    const body = `<form id="tree-form">
      <div class="field"><label for="tree-branch">分支名</label>
        <input id="tree-branch" required maxlength="120" placeholder="feature/my-change"></div>
      <div class="field"><label for="tree-path">目录预览 <small>仅模拟，不创建真实目录</small></label>
        <input id="tree-path" readonly tabindex="-1" aria-label="目录预览"></div>
      <p class="note">会建立空工作树；请再明确创建第一个会话。</p>
    </form>`;
    const root = openDialog("新建模拟工作树", "不运行 Git，不访问文件系统。", body,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="tree-form">创建工作树</button>`, { invoker });
    const syncPath = () => {
      const branch = $("#tree-branch", root).value.trim();
      const slug = (branch.split("/").pop() || "my-change").replace(/[^\w.-]+/g, "-") || "my-change";
      $("#tree-path", root).value = p.path + "-" + slug;
    };
    $("#tree-branch", root).addEventListener("input", syncPath);
    syncPath();
    $("#tree-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const branch = $("#tree-branch", root).value.trim();
      const path = $("#tree-path", root).value.trim();
      if (!/^(?:[\w.-]+\/)*[\w.-]+$/.test(branch)) return toast("请输入有效分支名（如 feature/my-change）。");
      const conflict = Object.values(WORKTREES).some(
        (t) => !isRemovedTree(t.id) && t.project === project &&
          (t.branch.toLowerCase() === branch.toLowerCase() || t.path.toLowerCase() === path.toLowerCase()),
      );
      if (conflict) return toast("分支或目录已属于这个项目的另一工作树；不会覆盖其身份。");
      const id = project + "-user-" + Date.now();
      const tree = { id, project, branch, path, detail: "空工作树", user: true };
      WORKTREES[id] = tree;
      store.userTrees.push({ id, project, branch, path, detail: "空工作树" });
      save();
      closeDialog(false);
      navigate("#/worktree/" + encodeURIComponent(id));
      render();
      toast("已创建空的模拟工作树。现在可在此目录新建终端。");
    });
  }

  function openRemoveTree(invoker, treeId) {
    const tree = WORKTREES[treeId];
    if (!tree) return;
    const reasons = removeTreeReasons(tree);
    if (reasons.length)
      return openDialog("不能移除工作树", "保留身份和历史，避免误删上下文。",
        `<ul class="dlg-text">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`,
        btn("知道了", "close-dialog", {}, "btn btn-primary"), { invoker });
    openDialog(`移除「${tree.branch}」？`, "历史会保留为只读，不会删除真实目录。",
      `<p><code>${esc(tree.path)}</code></p>`,
      btn("取消", "close-dialog", {}, "btn") + btn("确认移除", "confirm-remove-tree", { "data-tree": treeId }, "btn btn-danger"),
      { invoker });
  }

  /* ==================== 本应用目录：归档 / 删除 / 恢复（与 Agent CLI 无关） ==================== */
  function catalogArchiveCopy(kind) {
    if (kind === "project")
      return {
        title: "归档项目",
        sub: "从侧栏工作列表收起，可在「已归档项目」中恢复。",
        extra: "其下分支和会话仍留在本应用里。",
      };
    if (kind === "tree")
      return {
        title: "归档分支",
        sub: "从侧栏收起该工作树，可在所属项目的菜单中恢复。",
        extra: "该分支下的会话会随分支一起离开工作列表，但不会被删除。",
      };
    return {
      title: "归档会话",
      sub: "从侧栏收起该会话，可在所属分支的菜单中恢复。",
      extra: "输出仍可在所有终端中阅读。",
    };
  }
  function catalogDeleteCopy(kind, id) {
    if (kind === "project") {
      const trees = Object.values(WORKTREES).filter((t) => t.project === id && !isDeletedTree(t.id)).length;
      const sess = sessions().filter((s) => s.project === id && !isDeletedSession(s.id)).length;
      return {
        extra: `将同时从本应用移除 ${trees} 个分支、${sess} 个会话记录。`,
      };
    }
    if (kind === "tree") {
      const sess = sessions().filter((s) => s.tree === id && !isDeletedSession(s.id)).length;
      return { extra: `将同时从本应用移除该分支下 ${sess} 个会话记录。` };
    }
    return { extra: "会话记录会从本应用的工作列表中移除。" };
  }
  function openCatalogArchive(kind, id, invoker) {
    const name = catalogLabel(kind, id);
    const copy = catalogArchiveCopy(kind);
    openDialog(`${copy.title}「${name}」？`, copy.sub,
      `<p class="dlg-text">${esc(copy.extra)}</p><p class="note">${esc(CATALOG_SCOPE)}</p>`,
      btn("取消", "close-dialog", {}, "btn") +
        btn("确认归档", "catalog-archive-confirm", { "data-kind": kind, "data-id": id }, "btn btn-primary"),
      { invoker });
  }
  function openCatalogDelete(kind, id, invoker) {
    const name = catalogLabel(kind, id);
    const copy = catalogDeleteCopy(kind, id);
    openDialog(`从 ThreadTerm 删除「${name}」？`, "此操作在本原型中不能从菜单恢复。",
      `<p class="dlg-text">${esc(copy.extra)}</p><p class="note">${esc(CATALOG_SCOPE)}</p>`,
      btn("取消", "close-dialog", {}, "btn") +
        btn("确认删除", "catalog-delete-confirm", { "data-kind": kind, "data-id": id }, "btn btn-danger"),
      { invoker });
  }
  function catalogRestoreRows(kind, items) {
    if (!items.length)
      return `<div class="pad page-sub">${kind === "tree" ? "没有归档的分支" : "没有归档的会话"}</div>`;
    return items
      .map((row) => {
        const id = row.id;
        const label = kind === "tree" ? row.branch : displayName(row);
        const hint = kind === "tree" ? (row.detail || "分支") : STATE_LABEL[stateOf(row)];
        return `<button type="button" class="menu-item" data-action="catalog-restore" data-kind="${kind}" data-id="${esc(id)}">
          ${kind === "tree" ? icon("branch") : agentIcon(row.agent)}<span class="grow">${esc(label)}</span>
          <span class="dim">${esc(hint)} · 恢复</span>
        </button>`;
      })
      .join("");
  }
  function openProjectMenu(anchor, projectId) {
    const p = PROJECTS[projectId];
    if (!p) return;
    const archived = isArchivedProject(projectId);
    const trees = archivedTreesOf(projectId);
    const html = `<div class="menu-label">${esc(p.name)}</div>
      <button type="button" class="menu-item" data-action="copy-path" data-path="${esc(p.path)}">${icon("file")}复制目录路径</button>
      <button type="button" class="menu-item" data-action="directory-preview" data-path="${esc(p.path)}" data-label="${esc(p.name)}">${icon("folder")}查看目录（演示）</button>
      <button type="button" class="menu-item" data-action="directory-refresh" data-label="${esc(p.name)}">${icon("spark")}刷新目录状态（演示）</button>
      <button type="button" class="menu-item" data-action="discover-tree" data-project="${esc(projectId)}">${icon("branch")}发现已有分支工作树（演示）</button>
      <button type="button" class="menu-item" data-action="project-rename" data-project="${esc(projectId)}">${icon("file")}重命名项目</button>
      <button type="button" class="menu-item" data-action="project-pin" data-project="${esc(projectId)}">${icon("star")}${store.pinnedProjects.includes(projectId) ? "取消置顶" : "置顶项目"}</button>
      <button type="button" class="menu-item" data-action="project-move" data-project="${esc(projectId)}" data-direction="up">${icon("chevD")}向上移动</button>
      <button type="button" class="menu-item" data-action="project-move" data-project="${esc(projectId)}" data-direction="down">${icon("chevD")}向下移动</button>
      <div class="menu-sep"></div>
      ${archived
        ? `<button type="button" class="menu-item" data-action="catalog-restore" data-kind="project" data-id="${esc(projectId)}">${icon("archive")}恢复项目</button>`
        : `<button type="button" class="menu-item" data-action="catalog-archive" data-kind="project" data-id="${esc(projectId)}">${icon("archive")}归档</button>`}
      <button type="button" class="menu-item danger" data-action="catalog-delete" data-kind="project" data-id="${esc(projectId)}">${icon("trash")}删除</button>
      <div class="menu-sep"></div>
      <div class="menu-label">归档的分支</div>
      ${catalogRestoreRows("tree", trees)}
      ${appendMenuExtensions("project", { anchor, projectId, project: p })}
      <div class="menu-note">仅本应用归档，不影响 Agent CLI</div>`;
    openPopover(anchor, html, { width: 280 });
  }
  function openDirectoryPreview(path, label, invoker) {
    openDialog(`目录预览 · ${label || "演示目录"}`, "这是合成预览；不会读取或打开你的文件系统。",
      `<p class="dlg-text"><code>${esc(path || "未提供目录")}</code></p><p class="note">可通过“复制目录路径”把该演示路径交给其他工具；本原型不会启动文件管理器。</p>`,
      btn("关闭", "close-dialog", {}, "btn btn-primary"), { invoker });
  }
  function openDiscoveredTree(invoker, projectId) {
    const project = PROJECTS[projectId];
    if (!project) return;
    const choices = Object.values(WORKTREES).filter((tree) => tree.project === projectId && !isRemovedTree(tree.id));
    openDialog("发现已有分支工作树", "模拟读取已有 Git 工作树；选择后复用其身份，再明确创建会话。",
      `<div class="menu-list">${choices.map((tree) => `<button type="button" class="menu-item" data-action="discover-tree-select" data-tree="${esc(tree.id)}">${icon("branch")}<span class="grow">${esc(tree.branch)}</span><span class="dim">${esc(tree.path)}</span></button>`).join("")}</div>`,
      btn("取消", "close-dialog", {}, "btn"), { invoker, wide: true });
  }
  function openProjectRename(projectId, invoker) {
    const project = PROJECTS[projectId];
    if (!project) return;
    const root = openDialog("重命名项目", "只更新 ThreadTerm 中的显示名称，不会改动目录。",
      `<form id="project-rename-form"><div class="field"><label for="project-rename-input">显示名称</label><input id="project-rename-input" value="${esc(project.name)}" maxlength="60" required></div></form>`,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="project-rename-form">保存</button>`,
      { invoker });
    $("#project-rename-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("#project-rename-input", root).value.trim().slice(0, 60);
      if (!name) return;
      project.name = name;
      store.projectNames[projectId] = name;
      save();
      closeDialog(false);
      render();
      toast("已更新项目显示名称；目录没有改变。");
    });
  }
  function openNewDirectoryProject(invoker) {
    const root = openDialog("添加本地目录", "创建一个非 Git 的本地演示项目；不会访问或创建真实目录。",
      `<form id="directory-project-form"><div class="field"><label for="directory-project-name">显示名称</label><input id="directory-project-name" maxlength="60" required placeholder="my-local-notes"></div><div class="field"><label for="directory-project-path">目录路径</label><input id="directory-project-path" maxlength="180" required placeholder="D:/demo/my-local-notes"></div><p class="note">非 Git 目录没有分支操作；仍可创建会话、保存本地草稿并查看概览。</p></form>`,
      btn("取消", "close-dialog", {}, "btn") + `<button class="btn btn-primary" type="submit" form="directory-project-form">添加目录</button>`, { invoker });
    $("#directory-project-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("#directory-project-name", root).value.trim().slice(0, 60);
      const path = $("#directory-project-path", root).value.trim().slice(0, 180);
      if (!name || !/^(?:[a-zA-Z]:[\\/]|\/)/.test(path)) return toast("请输入绝对目录路径；此原型不会验证磁盘。");
      if (Object.values(PROJECTS).some((project) => project.path === path)) return toast("这个演示目录已在项目列表中。");
      const id = `directory-${Date.now()}`;
      const tree = { id: `${id}-main`, project: id, branch: "本地目录", path, detail: "非 Git 目录" };
      const project = { id, name, path, color: "blue", files: ["README.md"], file: `# ${name}\n\nThis is synthetic prototype content.\n`, nonGit: true, user: true };
      PROJECTS[id] = project;
      WORKTREES[tree.id] = { ...tree, user: true };
      store.userProjects.push(project);
      store.userTrees.push({ ...tree, user: true });
      store.expanded[id] = true;
      save();
      closeDialog(false);
      navigate("#/project/" + encodeURIComponent(id));
      toast("已添加非 Git 演示目录；没有读取磁盘。");
    });
  }
  function openTreeMenu(anchor, treeId) {
    const tree = WORKTREES[treeId];
    if (!tree) return;
    const archived = isArchivedTree(treeId);
    const sess = archivedSessionsOf(treeId);
    const html = `<div class="menu-label">${esc(tree.branch)}</div>
      <button type="button" class="menu-item" data-action="copy-path" data-path="${esc(tree.path)}">${icon("file")}复制目录路径</button>
      <button type="button" class="menu-item" data-action="directory-preview" data-path="${esc(tree.path)}" data-label="${esc(tree.branch)}">${icon("folder")}查看目录（演示）</button>
      <button type="button" class="menu-item" data-action="directory-refresh" data-label="${esc(tree.branch)}">${icon("spark")}刷新目录状态（演示）</button>
      ${archived
        ? `<button type="button" class="menu-item" data-action="catalog-restore" data-kind="tree" data-id="${esc(treeId)}">${icon("archive")}恢复分支</button>`
        : `<button type="button" class="menu-item" data-action="catalog-archive" data-kind="tree" data-id="${esc(treeId)}">${icon("archive")}归档</button>`}
      <button type="button" class="menu-item danger" data-action="catalog-delete" data-kind="tree" data-id="${esc(treeId)}">${icon("trash")}删除</button>
      <div class="menu-sep"></div>
      <div class="menu-label">归档的会话</div>
      ${catalogRestoreRows("session", sess)}
      ${appendMenuExtensions("tree", { anchor, treeId, tree })}
      <div class="menu-note">仅本应用归档，不影响 Agent CLI</div>`;
    openPopover(anchor, html, { width: 280 });
  }
  function openSessionMenu(anchor, sessionId) {
    const item = sessionById(sessionId);
    if (!item) return;
    const archived = isArchivedSession(sessionId);
    const html = `<div class="menu-label">${esc(displayName(item))}</div>
      <button type="button" class="menu-item" data-action="copy-path" data-path="${esc(treeOf(item)?.path || "")}">${icon("file")}复制目录路径</button>
      <button type="button" class="menu-item" data-action="directory-preview" data-path="${esc(treeOf(item)?.path || "")}" data-label="${esc(displayName(item))}">${icon("folder")}查看目录（演示）</button>
      <button type="button" class="menu-item" data-action="session-pin" data-session="${esc(sessionId)}">${icon("star")}${store.pinnedSessionIds.includes(sessionId) ? "取消固定快捷选择" : "固定到快捷选择"}</button>
      ${archived
        ? `<button type="button" class="menu-item" data-action="catalog-restore" data-kind="session" data-id="${esc(sessionId)}">${icon("archive")}恢复会话</button>`
        : `<button type="button" class="menu-item" data-action="catalog-archive" data-kind="session" data-id="${esc(sessionId)}">${icon("archive")}归档</button>`}
      <button type="button" class="menu-item danger" data-action="catalog-delete" data-kind="session" data-id="${esc(sessionId)}">${icon("trash")}删除</button>
      ${appendMenuExtensions("session", { anchor, sessionId, session: item })}
      <div class="menu-note">仅本应用归档，不影响 Agent CLI</div>`;
    openPopover(anchor, html, { width: 240 });
  }
  function ensureComposerAlive() {
    if (!isSidebarProject(ui.composer.project)) {
      const pid = Object.keys(PROJECTS).find(isSidebarProject) || Object.keys(PROJECTS)[0];
      ui.composer.project = pid;
      ui.composer.tree =
        Object.values(WORKTREES).find((t) => t.project === pid && isSidebarTree(t.id))?.id || "";
    } else if (!isSidebarTree(ui.composer.tree)) {
      ui.composer.tree =
        Object.values(WORKTREES).find((t) => t.project === ui.composer.project && isSidebarTree(t.id))?.id || "";
    }
  }
  function leaveCatalogTarget(kind, id) {
    const route = ui.route;
    const sess = sessionById(route.sessionId);
    if (kind === "session") {
      if (route.name === "workspace" && route.sessionId === id) {
        const item = sessionById(id);
        if (item && !isCatalogGoneTree(item.tree) && !isArchivedTree(item.tree))
          navigate("#/worktree/" + encodeURIComponent(item.tree));
        else if (item && PROJECTS[item.project] && !isDeletedProject(item.project))
          navigate("#/project/" + encodeURIComponent(item.project));
        else navigate("#/workbench");
        return true;
      }
      return false;
    }
    if (kind === "tree") {
      const onTree = route.name === "worktree" && route.treeId === id;
      const onSess = route.name === "workspace" && sess?.tree === id;
      if (onTree || onSess) {
        const tree = WORKTREES[id];
        if (tree && !isDeletedProject(tree.project))
          navigate("#/project/" + encodeURIComponent(tree.project));
        else navigate("#/workbench");
        return true;
      }
      return false;
    }
    const onProj = route.name === "project" && route.projectId === id;
    const onTree = route.name === "worktree" && WORKTREES[route.treeId]?.project === id;
    const onSess = route.name === "workspace" && sess?.project === id;
    if (onProj || onTree || onSess) {
      navigate("#/workbench");
      return true;
    }
    return false;
  }
  function applyCatalogChange(kind, id, toastText) {
    if (kind === "session") {
      ui.wsTiles = (ui.wsTiles || []).filter((tid) => tid !== id);
      if (ui.float.sessionId === id) ui.float.visibility = "closed";
    } else if (kind === "tree") {
      ui.wsTiles = (ui.wsTiles || []).filter((tid) => sessionById(tid)?.tree !== id);
      if (sessionById(ui.float.sessionId)?.tree === id) ui.float.visibility = "closed";
    } else if (kind === "project") {
      ui.wsTiles = (ui.wsTiles || []).filter((tid) => sessionById(tid)?.project !== id);
      if (sessionById(ui.float.sessionId)?.project === id) ui.float.visibility = "closed";
    }
    ensureComposerAlive();
    save();
    closeDialog(false);
    toast(toastText);
    if (!leaveCatalogTarget(kind, id)) render();
  }
  function confirmCatalogArchive(kind, id) {
    if (kind === "project" && PROJECTS[id])
      store.archivedProjects = [...new Set([...store.archivedProjects, id])];
    else if (kind === "tree" && WORKTREES[id])
      store.archivedTrees = [...new Set([...store.archivedTrees, id])];
    else if (kind === "session" && sessionById(id))
      store.archivedSessions = [...new Set([...store.archivedSessions, id])];
    else return;
    applyCatalogChange(kind, id, `已在 ThreadTerm 中归档「${catalogLabel(kind, id)}」。可从上级菜单恢复。`);
  }
  function confirmCatalogDelete(kind, id) {
    if (kind === "project" && PROJECTS[id]) {
      store.deletedProjects = [...new Set([...store.deletedProjects, id])];
      store.archivedProjects = store.archivedProjects.filter((v) => v !== id);
    } else if (kind === "tree" && WORKTREES[id]) {
      store.deletedTrees = [...new Set([...store.deletedTrees, id])];
      store.archivedTrees = store.archivedTrees.filter((v) => v !== id);
      sessions()
        .filter((s) => s.tree === id)
        .forEach((s) => {
          if (!store.deletedSessions.includes(s.id)) store.deletedSessions.push(s.id);
        });
    } else if (kind === "session" && sessionById(id)) {
      store.deletedSessions = [...new Set([...store.deletedSessions, id])];
      store.archivedSessions = store.archivedSessions.filter((v) => v !== id);
    } else return;
    applyCatalogChange(kind, id, `已从 ThreadTerm 删除「${catalogLabel(kind, id)}」。未改动磁盘或 CLI。`);
  }
  function restoreCatalog(kind, id) {
    if (kind === "project") store.archivedProjects = store.archivedProjects.filter((v) => v !== id);
    else if (kind === "tree") store.archivedTrees = store.archivedTrees.filter((v) => v !== id);
    else if (kind === "session") store.archivedSessions = store.archivedSessions.filter((v) => v !== id);
    else return;
    save();
    toast(`已恢复「${catalogLabel(kind, id)}」。`);
    render();
  }

  /* ==================== 浮层：首次启动欢迎 ==================== */
  function openWelcome() {
    /* 打开即标记：之后不再自动出现，可从「演示数据 ▾」重看 */
    store.welcomeSeen = true;
    save();
    const feats = [
      ["terminal", "多 agent 并排", "Claude / Codex / Gemini / Shell，各就各位。"],
      ["branch", "worktree 树与状态", "每个工作目录一行，需要你的一眼可见。"],
      ["inbox", "待处理与关注", "需要你决定的请求，集中在一个队列里。"],
    ];
    openDialog("ThreadTerm", "从上次停下的地方继续。",
      `<div class="welcome-feats">${feats
        .map(([glyph, title, copy]) => `<div class="row"><span class="wico">${icon(glyph)}</span><div><b>${esc(title)}</b><p>${esc(copy)}</p></div></div>`)
        .join("")}</div>
      <p class="note">当前为交互原型，全部使用演示数据，不连接真实终端。</p>`,
      btn(`开始体验 ${icon("chevR")}`, "close-dialog", {}, "btn btn-primary"));
  }

  function openAbout(invoker) {
    openDialog("关于这个原型", "ThreadTerm · 消费级应用原型 / 2026.09",
      `<div class="preview">界面：HTML / CSS / JavaScript（无构建、无依赖）
运行：完全本地，不需要账户
数据：合成内容，不是你的真实项目
真实文件访问：无
AI / Shell / 支付连接：无</div>
      <p class="note">本原型用于体验产品方向。所有交互均为本地演示，不执行真实命令。</p>`,
      btn("知道了", "close-dialog", {}, "btn btn-primary"), { invoker });
  }

  /* ==================== 浮层：所有终端卡片 ⋯ 菜单 / 工作区切换会话 ==================== */
  function openCardMenu(anchor, sessionId) {
    const item = sessionById(sessionId);
    if (!item) return;
    const unavailable = isUnavailable(item);
    const archived = isArchivedSession(item.id);
    const html = `
      <button type="button" class="menu-item" data-action="float-open" data-session="${esc(item.id)}"${unavailable ? " disabled" : ""}>${icon("popout")}在浮窗打开</button>
      <button type="button" class="menu-item" data-action="session-pin" data-session="${esc(item.id)}">${icon("star")}${store.pinnedSessionIds.includes(item.id) ? "取消固定快捷选择" : "固定到快捷选择"}</button>
      <button type="button" class="menu-item" data-action="follow-toggle" data-session="${esc(item.id)}">${icon("star")}${isFollowed(item.id) ? "已关注 · 点击取消" : "关注"}</button>
      <button type="button" class="menu-item" data-action="view-history" data-session="${esc(item.id)}">${icon("terminal")}在所有终端中查看</button>
      <div class="menu-sep"></div>
      ${archived
        ? `<button type="button" class="menu-item" data-action="catalog-restore" data-kind="session" data-id="${esc(item.id)}">${icon("archive")}从应用中恢复</button>`
        : `<button type="button" class="menu-item" data-action="catalog-archive" data-kind="session" data-id="${esc(item.id)}">${icon("archive")}归档</button>`}
      <button type="button" class="menu-item danger" data-action="catalog-delete" data-kind="session" data-id="${esc(item.id)}">${icon("trash")}删除</button>
      <div class="menu-note">仅 ThreadTerm 列表，不影响 CLI</div>`;
    openPopover(anchor, html, { width: 220, align: "right" });
  }

  function openWorkspaceSwitcher(anchor, currentId) {
    const item = sessionById(currentId);
    if (!item) return;
    const f = ui.switchFilter;
    const html = `<div class="switcher">
      <div class="tools">
        <div class="input-wrap">${icon("search")}<input data-switch-search placeholder="搜索终端：名称或类型" value="${esc(f.query)}" aria-label="搜索终端"></div>
        <select data-switch-status aria-label="全部状态">
          ${[["all", "全部状态"], ...Object.entries(STATE_LABEL).map(([v, l]) => [v, l])].map(([v, l]) => `<option value="${v}"${f.status === v ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <label class="checkline"><input type="checkbox" data-switch-needs${f.needs ? " checked" : ""}> 仅需处理</label>
      </div>
      <div class="switcher-list"></div>
    </div>`;
    const root = openPopover(anchor, html, { width: 320, align: "right" });
    const treeSessions = sessions().filter((s) => s.tree === item.tree && isWorkingSession(s));
    const paint = () => {
      const list = treeSessions.filter(
        (s) =>
          (!f.query || (displayName(s) + " " + s.agent).toLowerCase().includes(f.query.toLowerCase())) &&
          (f.status === "all" || stateOf(s) === f.status) &&
          (!f.needs || ["needs", "failed"].includes(stateOf(s))),
      );
      $(".switcher-list", root).innerHTML = list.length
        ? list
            .map(
              (s) => `<button type="button" class="switcher-row" data-action="open-session" data-session="${s.id}">
                <span class="dot st-${stateOf(s)}"></span>${esc(s.agent)} · ${esc(displayName(s))}<small>${esc(STATE_LABEL[stateOf(s)])}</small>
              </button>`,
            )
            .join("")
        : `<div class="pad page-sub">没有匹配终端。<button type="button" class="btn-subtle" data-action="ws-filter-clear">清除筛选</button></div>`;
    };
    $("[data-switch-search]", root).addEventListener("input", (event) => {
      f.query = event.target.value;
      paint();
    });
    $("[data-switch-status]", root).addEventListener("change", (event) => {
      f.status = event.target.value;
      paint();
    });
    $("[data-switch-needs]", root).addEventListener("change", (event) => {
      f.needs = event.target.checked;
      paint();
    });
    paint();
    $("[data-switch-search]", root).focus();
  }

  /* ==================== 路由与渲染 ==================== */
  function parseHash() {
    const hash = location.hash || "#/workbench";
    const parts = hash.replace(/^#\/?/, "").split("/");
    if (parts[0] === "history") return { name: "terminals" };
    const name = ROUTES.includes(parts[0]) ? parts[0] : "workbench";
    const param = decodeURIComponent(parts.slice(1).join("/") || "");
    if (name === "workspace") {
      const item = sessionById(param);
      if (!item || isCatalogGoneSession(item)) return { name: "workbench" };
      return { name, sessionId: item.id };
    }
    if (name === "project") {
      if (!PROJECTS[param] || isDeletedProject(param)) return { name: "workbench" };
      return { name, projectId: param };
    }
    if (name === "worktree") {
      if (!WORKTREES[param] || isCatalogGoneTree(param)) return { name: "workbench" };
      return { name, treeId: param };
    }
    if (name === "history") return { name: "terminals" };
    return { name };
  }
  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash; // hashchange 触发 render
  }
  function openTerminals({ sessionId = "", project = "all", tree = "all", status = "all" } = {}) {
    ui.tFilters = { ...ui.tFilters, query: "", project, tree, status };
    ui.tHighlight = sessionId;
    ui.tInspect = sessionId || "";
    navigate("#/terminals");
  }
  /* 进入工作区前的位置（含概览页参数），用于「返回」与「恢复来源」 */
  function originOf(route) {
    const label =
      route.name === "project" ? "项目总览"
      : route.name === "worktree" ? "工作树概览"
      : ROUTE_TITLE[route.name] || "工作台";
    return { name: route.name, label, param: route.projectId || route.treeId || "" };
  }
  function openSession(id) {
    const item = sessionById(id);
    if (!item) return toast("没有找到该演示会话。");
    if (isUnavailable(item)) {
      openTerminals({ sessionId: id, project: item.project, tree: item.tree });
      return toast(isEnded(item) ? "此演示会话已结束，可在所有终端中查看记录。" : "此会话所在目录不可用，可在所有终端中查看记录。");
    }
    recordVisit(id);
    if (ui.route.name !== "workspace") ui.origin = originOf(ui.route);
    /* 切到预设布局之外的会话 = 离开布局态（手动并排查看不受影响） */
    if (ui.presetLayout && !ui.presetLayout.entries.some((e) => e.session === id))
      ui.presetLayout = null;
    const prev = sessionById(ui.route.sessionId);
    if (prev && prev.tree !== item.tree) ui.wsTiles = [item.id];
    else if ((ui.wsTiles || []).length > 1) {
      if (!ui.wsTiles.includes(item.id)) {
        if (ui.wsTiles.length < 4) ui.wsTiles = [...ui.wsTiles, item.id];
        else {
          const idx = Math.max(0, ui.wsTiles.indexOf(prev?.id));
          const next = ui.wsTiles.slice();
          next[idx] = item.id;
          ui.wsTiles = next;
        }
      }
    } else ui.wsTiles = [item.id];
    if (ui.route.sessionId !== id) {
      ui.wsTab = "terminal";
      ui.wsFile = 0;
    }
    navigate("#/workspace/" + encodeURIComponent(id));
  }
  function setTheme(theme) {
    store.theme = theme;
    save();
    render();
  }

  let compositionTarget = null;
  let renderAfterComposition = false;
  let compositionFrame = 0;
  function finishComposition() {
    compositionTarget = null;
    if (!renderAfterComposition || compositionFrame) return;
    // Let the browser and CodeMirror commit the final input transaction first.
    compositionFrame = requestAnimationFrame(() => {
      compositionFrame = 0;
      if (compositionTarget) return;
      renderAfterComposition = false;
      render();
    });
  }
  function moveWorkspaceSession(delta) {
    const current = sessionById(ui.route.sessionId);
    if (!current) return;
    const list = sessions().filter((item) => item.tree === current.tree && isWorkingSession(item));
    if (list.length < 2) return toast("这个工作树没有其他可切换会话。");
    const next = list[(list.indexOf(current) + delta + list.length) % list.length];
    openSession(next.id);
  }

  function render() {
    if (compositionTarget?.isConnected && $("#app").contains(compositionTarget)) {
      renderAfterComposition = true;
      return;
    }
    compositionTarget = null;
    renderAfterComposition = false;
    /* 记录焦点，重渲染后恢复（搜索输入不打断打字） */
    const active = document.activeElement;
    const mark =
      active instanceof HTMLElement && $("#app").contains(active) && active.dataset.action
        ? { dataset: { ...active.dataset }, pos: typeof active.selectionStart === "number" ? active.selectionStart : null }
        : null;
    const renderContext = { store, ui, projects: PROJECTS, trees: WORKTREES, route: ui.route, app: $("#app") };
    beforeRenderHooks.forEach((callback) => safelyRun(callback, renderContext));
    ui.route = parseHash();
    /* 离开工作区即退出预设布局态（会话保留，布局不保留） */
    if (ui.route.name !== "workspace") ui.presetLayout = null;
    /* 换项目/分支时收起「关注为空」演示态 */
    if (ui.route.name === "project") {
      if (ui.briefProjectId && ui.briefProjectId !== ui.route.projectId) ui.briefHideFocus = false;
      ui.briefProjectId = ui.route.projectId;
    }
    if (ui.route.name === "worktree") {
      if (ui.briefTreeId && ui.briefTreeId !== ui.route.treeId) ui.briefHideFocus = false;
      ui.briefTreeId = ui.route.treeId;
    }
    document.documentElement.dataset.theme = store.theme;
    const views = {
      workbench: viewWorkbench,
      inbox: viewInbox,
      terminals: viewTerminals,
      history: viewTerminals,
      presets: viewPresets,
      pro: viewPro,
      workspace: viewWorkspace,
      project: () => viewProject(ui.route.projectId),
      worktree: () => viewWorktree(ui.route.treeId),
    };
    const flush = ui.route.name === "workspace" || ui.route.name === "project" || ui.route.name === "worktree" || ui.route.name === "terminals";
    $("#app").innerHTML = `<div class="shell">${sidebar()}<main class="main${flush ? " flush" : ""}">${views[ui.route.name]()}</main>${floatLayer()}${statusbar()}</div>`;
    wireInputs();
    wireTiles();
    wireTerminalCards();
    renderContext.route = ui.route;
    renderContext.app = $("#app");
    renderHooks.forEach((callback) => safelyRun(callback, renderContext));
    if (ui.route.name === "terminals" && ui.tHighlight)
      document.querySelector(".t-card.highlight")?.scrollIntoView({ block: "nearest" });
    if (mark) {
      const next = [...document.querySelectorAll("#app [data-action]")].find((el) =>
        Object.entries(mark.dataset).every(([k, v]) => el.dataset[k] === v),
      );
      if (next) {
        next.focus({ preventScroll: true });
        if (mark.pos != null && typeof next.setSelectionRange === "function") {
          try { next.setSelectionRange(mark.pos, mark.pos); } catch { /* 非文本控件 */ }
        }
      }
    }
  }

  function wireTiles() {
    const grid = $(".term-grid");
    if (!grid || !grid.querySelector(".ws-tile")) return;
    let from = null;
    grid.querySelectorAll(".ws-tile").forEach((tile) => {
      const bar = $(".ws-tile-bar", tile);
      if (!bar) return;
      bar.addEventListener("dragstart", (event) => {
        from = Number(tile.dataset.tileIndex);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tile.dataset.session || "");
        tile.classList.add("dragging");
      });
      bar.addEventListener("dragend", () => {
        from = null;
        tile.classList.remove("dragging");
        grid.querySelectorAll(".ws-tile").forEach((el) => el.classList.remove("drag-over"));
      });
      tile.addEventListener("dragover", (event) => {
        event.preventDefault();
        tile.classList.add("drag-over");
      });
      tile.addEventListener("dragleave", () => tile.classList.remove("drag-over"));
      tile.addEventListener("drop", (event) => {
        event.preventDefault();
        tile.classList.remove("drag-over");
        const to = Number(tile.dataset.tileIndex);
        if (from == null || from === to) return;
        const item = sessionById(ui.route.sessionId);
        if (!item) return;
        const tiles = workspaceTiles(item.tree, item.id);
        if (from < 0 || from >= tiles.length || to < 0 || to >= tiles.length) return;
        const [moved] = tiles.splice(from, 1);
        tiles.splice(to, 0, moved);
        ui.wsTiles = tiles;
        render();
      });
    });
  }

  function wireTerminalCards() {
    const grid = $("[data-terminal-grid]");
    if (!grid || grid.classList.contains("list")) return;
    if (grid.dataset.orderLocked === "true") return;
    let from = "";
    grid.querySelectorAll(".t-card[data-session]").forEach((card) => {
      card.draggable = true;
      card.addEventListener("dragstart", (event) => {
        from = card.dataset.session;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", from);
      });
      card.addEventListener("dragover", (event) => event.preventDefault());
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        const to = card.dataset.session;
        if (!from || !to || from === to) return;
        const scope = grid.dataset.orderScope;
        const visible = [...grid.querySelectorAll(".t-card[data-session]")].map((node) => node.dataset.session);
        const existing = (store.sessionOrder[scope] || []).filter((id) => sessions().some((item) => item.id === id));
        const ordered = [...existing, ...visible.filter((id) => !existing.includes(id))];
        const start = ordered.indexOf(from), target = ordered.indexOf(to);
        if (start < 0 || target < 0) return;
        ordered.splice(start, 1); ordered.splice(target, 0, from);
        store.sessionOrder[scope] = ordered;
        save(); render(); toast("已保存当前范围的会话卡片顺序。");
      });
    });
  }

  /* 需要重渲染时保留插入点的输入框 */
  function keepCaret(input, apply) {
    const pos = input.selectionStart;
    apply(input.value);
    render();
    const next = $(`[data-action="${input.dataset.action}"]`);
    if (next) {
      next.focus();
      try { next.setSelectionRange(pos, pos); } catch { /* ignore */ }
    }
  }

  function wireInputs() {
    const tSearch = $('[data-action="t-search"]');
    if (tSearch)
      tSearch.addEventListener("input", (event) =>
        keepCaret(event.target, (value) => (ui.tFilters.query = value)),
      );

    /* 终端输入条：仅记录演示输入；草稿随会话保留 */
    document.querySelectorAll("[data-terminal-form]").forEach((form) => {
      const input = $("input", form);
      input.addEventListener("input", (event) => {
        ui.termDrafts[form.dataset.terminalForm] = event.target.value;
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const command = input.value.trim();
        if (!command) return;
        addCommand(command, form.dataset.terminalForm);
        ui.termDrafts[form.dataset.terminalForm] = "";
        render();
        $(`[data-terminal-form="${form.dataset.terminalForm}"] input`)?.focus();
      });
    });
    /* 浮动终端输入条：草稿独立保留，收起再展开不丢 */
    const floatForm = $("[data-float-form]");
    if (floatForm) {
      const input = $("input", floatForm);
      input.addEventListener("input", (event) => {
        ui.termDrafts[floatForm.dataset.floatForm] = event.target.value;
      });
      floatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const command = input.value.trim();
        if (!command) return;
        addCommand(command, floatForm.dataset.floatForm);
        ui.termDrafts[floatForm.dataset.floatForm] = "";
        render();
        $(`[data-float-form] input`)?.focus();
      });
    }
    const editor = $("[data-editor]");
    if (editor)
      editor.addEventListener("input", (event) => {
        const item = sessionById(ui.route.sessionId);
        if (!item) return;
        ui.drafts[fileKey(item, ui.wsFile)] = event.target.value;
        const tab = $('[data-action="ws-tab"][data-tab="file"]');
        if (tab && !tab.textContent.includes("未保存")) tab.append(" · 未保存");
      });
    /* 起始页 composer：Enter 提交 = 打开预选好的新建终端对话框（不执行） */
    const composerForm = $("[data-composer-form]");
    if (composerForm) {
      const textarea = $("[data-composer-text]", composerForm);
      textarea.addEventListener("input", (event) => {
        ui.composer.text = event.target.value;
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          composerForm.requestSubmit();
        }
      });
      composerForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const c = ui.composer;
        openCreate(textarea, c.tree, c.project, c.agent, c.text.trim());
      });
    }
    /* 抽屉「文件」分区的筛选框：就地过滤，不重渲染 */
    const insFilter = $("[data-ins-filter]");
    if (insFilter)
      insFilter.addEventListener("input", (event) => {
        const q = event.target.value.toLowerCase();
        document.querySelectorAll(".inspector .file-link").forEach((link) => {
          link.hidden = q !== "" && !link.textContent.toLowerCase().includes(q);
        });
      });
  }

  function addCommand(command, sessionId) {
    const item = sessionById(sessionId);
    if (!item || isUnavailable(item)) return toast("此会话现在只能查看记录，不能再输入。");
    ui.logs[sessionId] = [
      ...(ui.logs[sessionId] || []),
      "",
      "› " + command,
      "[演示] 输入已记录；未执行系统命令，也未发送 AI 请求。",
    ].slice(-30);
  }

  function exportData() {
    const payload = {
      format: "ThreadTerm App Prototype / DEMO ONLY",
      sessions: sessions(),
      bookmarks: store.bookmarks,
      presets: [...PRESETS, ...store.savedPresets],
      preferences: { theme: store.theme, followed: store.followed, trial: store.trial },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "threadterm-demo-export.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("已导出本原型的演示数据。");
  }

  /* ==================== 动作分发 ==================== */
  function syncAppWindowChrome() {
    const maxed = Boolean(document.querySelector(".app-window")?.classList.contains("is-max"));
    document.querySelector(".desktop")?.classList.toggle("is-max", maxed);
    const btn = document.querySelector('[data-action="app-window-toggle"]');
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(maxed));
    btn.setAttribute("aria-label", maxed ? "还原窗口" : "放大窗口");
    btn.title = maxed ? "还原" : "放大";
  }
  function toggleAppWindow() {
    document.querySelector(".app-window")?.classList.toggle("is-max");
    syncAppWindowChrome();
  }

  const ACTIONS = {
    noop: () => {},
    "app-window-toggle": () => toggleAppWindow(),
    nav: (el) => navigate("#/" + el.dataset.route),
    "toggle-project": (el) => {
      store.expanded[el.dataset.project] = store.expanded[el.dataset.project] === false;
      save();
      render();
    },
    "open-tree": (el) => {
      if (!WORKTREES[el.dataset.tree]) return;
      navigate("#/worktree/" + encodeURIComponent(el.dataset.tree));
    },
    "open-project": (el) => {
      if (!PROJECTS[el.dataset.project] || isDeletedProject(el.dataset.project)) return;
      if (el.dataset.project !== ui.route.projectId) ui.briefHideFocus = false;
      navigate("#/project/" + encodeURIComponent(el.dataset.project));
    },
    "project-menu": (el) => {
      el.setAttribute("aria-expanded", "true");
      openProjectMenu(el, el.dataset.project);
    },
    "project-rename": (el) => openProjectRename(el.dataset.project, el),
    "copy-path": async (el) => {
      const path = el.dataset.path || "";
      if (!path) return toast("没有可复制的目录路径。");
      try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(path); toast("已复制演示目录路径。"); }
      catch {
        const root = openDialog("复制目录路径", "浏览器未提供剪贴板权限，可使用 Ctrl/Cmd+C 复制。", `<input readonly aria-label="目录路径" value="${esc(path)}">`, btn("关闭", "close-dialog"));
        const input = $("input", root); input.focus(); input.select();
      }
    },
    "directory-preview": (el) => openDirectoryPreview(el.dataset.path, el.dataset.label, el),
    "directory-refresh": (el) => {
      const label = el.dataset.label || "目录";
      const scans = (store.featureStates.directoryScans ||= {});
      scans[label] = { at: new Date().toISOString(), status: "已同步合成目录状态" };
      save();
      openDialog(`刷新完成 · ${label}`, "从本地演示模型重新读取；没有访问文件系统。", `<p data-testid="directory-refresh-receipt">${esc(scans[label].status)} · ${esc(scans[label].at)}</p><p>可用工作目录 ${Object.values(WORKTREES).filter((tree) => isSidebarTree(tree.id)).length} 个；会话记录 ${sessions().length} 条。</p>`, btn("关闭", "close-dialog"));
    },
    "discover-tree": (el) => openDiscoveredTree(el, el.dataset.project),
    "discover-tree-select": (el) => {
      const tree = WORKTREES[el.dataset.tree];
      if (!tree) return;
      closeDialog(false); openCreate(el, tree.id, tree.project);
      toast(`已复用「${tree.branch}」的演示工作树身份；请确认新会话。`);
    },
    "project-pin": (el) => {
      const id = el.dataset.project;
      if (!PROJECTS[id]) return;
      store.pinnedProjects = store.pinnedProjects.includes(id)
        ? store.pinnedProjects.filter((value) => value !== id)
        : [...store.pinnedProjects, id];
      save();
      render();
      toast(store.pinnedProjects.includes(id) ? "项目已置顶。" : "项目已取消置顶。");
    },
    "project-move": (el) => {
      const id = el.dataset.project;
      const ids = orderedProjectIds();
      const index = ids.indexOf(id);
      const delta = el.dataset.direction === "up" ? -1 : 1;
      if (index < 0 || !ids[index + delta]) return toast("已经在此顺序的边界。");
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      store.projectOrder = ids;
      save();
      render();
      toast("已调整项目顺序。");
    },
    "tree-menu": (el) => {
      el.setAttribute("aria-expanded", "true");
      openTreeMenu(el, el.dataset.tree);
    },
    "session-menu": (el) => {
      el.setAttribute("aria-expanded", "true");
      openSessionMenu(el, el.dataset.session);
    },
    "catalog-archive": (el) => openCatalogArchive(el.dataset.kind, el.dataset.id, el),
    "catalog-delete": (el) => openCatalogDelete(el.dataset.kind, el.dataset.id, el),
    "catalog-archive-confirm": (el) => confirmCatalogArchive(el.dataset.kind, el.dataset.id),
    "catalog-delete-confirm": (el) => confirmCatalogDelete(el.dataset.kind, el.dataset.id),
    "catalog-restore": (el) => restoreCatalog(el.dataset.kind, el.dataset.id),
    "continue-tree": (el) => {
      const tree = WORKTREES[el.dataset.tree];
      if (!tree || tree.missing || isRemovedTree(tree.id) || isArchivedTree(tree.id) || isCatalogGoneTree(tree.id))
        return toast("这个工作目录目前不能继续；可以先查看历史记录。");
      const target = sessions().find((s) => s.tree === tree.id && isWorkingSession(s) && !isUnavailable(s));
      if (!target) return toast("这里没有可继续的终端；请新建终端或查看历史记录。");
      openSession(target.id);
    },
    "new-tree": (el) => openNewTree(el, el.dataset.project || "orbit"),
    "remove-tree": (el) => openRemoveTree(el, el.dataset.tree),
    "confirm-remove-tree": (el) => {
      const treeId = el.dataset.tree;
      const tree = WORKTREES[treeId];
      if (!tree) return closeDialog();
      store.removedTrees = [...new Set([...store.removedTrees, treeId])];
      save();
      closeDialog(false);
      if (ui.route.name === "worktree" && ui.route.treeId === treeId)
        navigate("#/project/" + encodeURIComponent(tree.project));
      else render();
      toast("已移除该演示工作树；历史记录仍可阅读。");
    },
    "open-palette": (el) => openPalette(el),
    "open-create": (el) => openCreate(el, el.dataset.tree || "", el.dataset.project || ""),
    "open-notifications": (el) => {
      el.setAttribute("aria-expanded", "true");
      openNotifications(el);
    },
    "open-settings": (el) => {
      el.setAttribute("aria-expanded", "true");
      openSettingsMenu(el);
    },
    "scope-open": (el) => openScopePicker(el),
    "scope-set": (el) => {
      ui.sidebarScope = el.dataset.scope || "all";
      const scope = selectedScope();
      ui.tFilters.project = scope.project || "all"; ui.tFilters.tree = scope.tree || "all";
      if (scope.project) { ui.composer.project = scope.project; ui.composer.tree = scope.tree || Object.values(WORKTREES).find((tree) => tree.project === scope.project && isSidebarTree(tree.id))?.id || ""; }
      render();
    },
    "branch-list-toggle": (el) => { const lists = (store.featureStates.sidebarLists ||= {}); lists[el.dataset.project] = !lists[el.dataset.project]; save(); render(); },
    "new-directory-project": (el) => openNewDirectoryProject(el),
    "open-scenarios": (el) => {
      el.setAttribute("aria-expanded", "true");
      openScenarioMenu(el);
    },
    "composer-pick": (el) => openComposerPick(el, el.dataset.kind),
    "composer-set": (el) => {
      const { kind, value } = el.dataset;
      ui.composer[kind] = value;
      if (kind === "project") {
        /* 换项目后预选该项目第一个可用 worktree */
        const first = Object.values(WORKTREES).find((t) => t.project === value && !t.missing && isSidebarTree(t.id));
        ui.composer.tree = first?.id || "";
      }
      render();
    },
    "scenario-pick": (el) => {
      const scene = el.dataset.scene;
      if (scene === "welcome") return openWelcome();
      if (scene === "project" || scene === "project-quiet") {
        ui.briefHideFocus = scene === "project-quiet";
        navigate("#/project/orbit");
        return;
      }
      if (scene === "worktree" || scene === "worktree-quiet") {
        ui.briefHideFocus = scene === "worktree-quiet";
        navigate("#/worktree/orbit-checkout");
        return;
      }
      if (scene === "return") {
        render();
        openNotifications($('[data-action="open-notifications"]'));
      } else {
        navigate(scene === "next" ? "#/presets" : scene === "pro" ? "#/pro" : "#/workbench");
      }
    },
    "brief-focus-demo": (el) => {
      ui.briefHideFocus = el.dataset.mode === "hide";
      render();
      $("#live").textContent = ui.briefHideFocus ? "简报：关注项已收起，用量仍在。" : "简报：显示需要关注的事项。";
    },
    "theme-set": (el) => setTheme(el.dataset.theme),
    about: (el) => openAbout(el),
    "inbox-filter": (el) => {
      ui.inboxFilter = el.dataset.filter;
      render();
    },
    "attention-view": (el) => openAttentionDetail(el.dataset.episode, el),
    "attention-open": (el) => {
      closeDialog(false);
      openSession(el.dataset.session);
    },
    "attention-resolve": (el) => {
      store.resolved = [...new Set([...store.resolved, el.dataset.episode])];
      save();
      closeDialog(false);
      render();
      toast("已标为演示中已处理；没有执行终端命令。");
    },
    "attention-ignore": (el) => {
      store.ignored = [...new Set([...store.ignored, el.dataset.episode])];
      save();
      render();
      toast("已忽略这一项；不会影响其他请求或关注状态。");
    },
    "attention-rules": (el) => openStalledRules(el),
    "row-menu": (el) => openInboxRowMenu(el, el.dataset.episode),
    "card-menu": (el) => openCardMenu(el, el.dataset.session),
    "follow-toggle": (el) => {
      const id = el.dataset.session;
      if (!sessionById(id)) return;
      store.followed = isFollowed(id) ? store.followed.filter((v) => v !== id) : [...store.followed, id];
      save();
      render();
    },
    "session-pin": (el) => {
      const id = el.dataset.session;
      if (!sessionById(id)) return;
      if (store.pinnedSessionIds.includes(id)) {
        store.pinnedSessionIds = store.pinnedSessionIds.filter((value) => value !== id);
        save(); render(); return toast("已从快捷选择取消固定。");
      }
      if (store.pinnedSessionIds.length >= 6) return toast("快捷选择最多固定 6 个终端。");
      store.pinnedSessionIds = [...store.pinnedSessionIds, id];
      save(); render(); toast("已固定到快捷选择；它不等同关注或书签。");
    },
    "follow-add": (el) => openFollowAdd(el),
    "follow-menu": (el) => openFollowMenu(el, el.dataset.session),
    "follow-rename": (el) => openRename(el, el.dataset.session),
    bookmark: (el) => {
      const id = el.dataset.session;
      store.bookmarks = store.bookmarks.includes(id)
        ? store.bookmarks.filter((v) => v !== id)
        : [...store.bookmarks, id];
      save();
      closeDialog(false);
      render();
      toast(store.bookmarks.includes(id) ? "已加入本地书签。" : "已移除这条书签。");
    },
    "history-needs": () => navigate("#/inbox"),
    recent: (el) => {
      const s = sessionById(el.dataset.session);
      if (!s) return;
      openTerminals({ sessionId: s.id, project: s.project, tree: s.tree });
    },
    "view-history": (el) => {
      const s = sessionById(el.dataset.session);
      if (!s) return;
      openTerminals({ sessionId: s.id, project: s.project, tree: s.tree });
    },
    "restore-history": (el) => openSession(el.dataset.session),
    "open-terminals": (el) => {
      openTerminals({
        project: el.dataset.project || "all",
        tree: el.dataset.tree || "all",
      });
    },
    "activity-all": (el) => openActivityAll({ project: el.dataset.project, tree: el.dataset.tree }, el),
    "activity-open": (el) => {
      const item = sessionById(el.dataset.session);
      if (!item) return;
      closeDialog(false);
      if (isUnavailable(item)) openTerminals({ sessionId: item.id, project: item.project, tree: item.tree });
      else openSession(item.id);
    },
    "usage-details": (el) => openUsageDetails(el.dataset.project, el),
    relocate: (el) => openRelocate(el.dataset.tree, el),
    export: () => exportData(),
    "t-layout": (el) => {
      ui.tFilters.layout = el.dataset.layout;
      render();
    },
    "t-inspect": (el) => {
      const id = el.dataset.session;
      if (!id || ui.tInspect === id) return;
      ui.tInspect = id;
      ui.tHighlight = id;
      render();
    },
    "t-clear": () => {
      ui.tFilters = { query: "", project: "all", tree: "all", status: "all", layout: ui.tFilters.layout };
      ui.tHighlight = "";
      ui.tInspect = "";
      render();
    },
    "project-card": (el) => navigate("#/project/" + encodeURIComponent(el.dataset.project)),
    "open-session": (el) => openSession(el.dataset.session),
    /* 浮动终端：页面内真浮层 */
    "float-open": (el) => {
      const item = sessionById(el.dataset.session);
      if (!item) return;
      if (isUnavailable(item)) return toast("此会话不能在浮窗中打开。");
      ui.float = { sessionId: item.id, visibility: "open", pinned: false };
      closeDialog(false);
      render();
      $("[data-float-form] input")?.focus();
    },
    "float-hide": () => {
      ui.float.visibility = "hidden";
      render();
      toast("浮窗已最小化到角落；会话仍在运行。点关闭可真正收回。");
    },
    "float-resume": () => {
      ui.float.visibility = "open";
      render();
      $("[data-float-form] input")?.focus();
    },
    "float-close": () => {
      ui.float = { sessionId: "", visibility: "closed", pinned: false };
      render();
      toast("浮窗已关闭；会话仍在运行。");
    },
    "float-pin": () => {
      ui.float.pinned = !ui.float.pinned;
      render();
      toast(ui.float.pinned ? "已模拟置顶；这不是系统窗口。" : "已取消置顶演示。");
    },
    "float-main": () => {
      const item = sessionById(ui.float.sessionId);
      ui.float.visibility = "closed";
      if (item && !isUnavailable(item)) openSession(item.id);
      else render();
    },
    "preset-open": (el) => openPresetPreview(el.dataset.id, el),
    "preset-confirm": (el) => confirmPreset(el.dataset.id),
    "new-preset": (el) => openNewPreset(el),
    "pro-trial": () => {
      store.trial = true;
      save();
      render();
      toast("Pro 演示已开启。到工作预设中保存一个属于你的工作环境。");
    },
    "pro-free": () => {
      store.trial = false;
      save();
      render();
      toast("已切回免费演示。已有记录和预设不会被删除。");
    },
    "ws-tab": (el) => {
      ui.wsTab = el.dataset.tab;
      render();
    },
    "ws-file": (el) => {
      ui.wsFile = Number(el.dataset.index) || 0;
      ui.wsTab = "file";
      render();
    },
    "ws-save-file": () => {
      const item = sessionById(ui.route.sessionId);
      if (!item) return;
      const key = fileKey(item, ui.wsFile);
      const editor = $("[data-editor]");
      if (editor) ui.files[key] = editor.value;
      delete ui.drafts[key];
      render();
      toast("演示草稿已保存在本原型；未写入真实文件。");
    },
    "ws-close-file": (el) => {
      const item = sessionById(ui.route.sessionId);
      if (!item) return;
      if (!Object.hasOwn(ui.drafts, fileKey(item, ui.wsFile))) {
        ui.wsTab = "terminal";
        return render();
      }
      openDialog("保留这份演示草稿吗？", "关闭文件前，先决定如何处理修改。",
        '<p class="dlg-text">草稿仅属于本原型，不会写入你的项目文件。</p>',
        btn("取消", "close-dialog", {}, "btn") +
          btn("放弃修改", "discard-file", {}, "btn btn-danger") +
          btn("保存并关闭", "save-close-file", {}, "btn btn-primary"),
        { invoker: el });
    },
    "discard-file": () => {
      const item = sessionById(ui.route.sessionId);
      if (item) delete ui.drafts[fileKey(item, ui.wsFile)];
      closeDialog(false);
      ui.wsTab = "terminal";
      render();
    },
    "save-close-file": () => {
      const item = sessionById(ui.route.sessionId);
      if (item) {
        const key = fileKey(item, ui.wsFile);
        const editor = $("[data-editor]");
        if (editor) ui.files[key] = editor.value;
        delete ui.drafts[key];
      }
      closeDialog(false);
      ui.wsTab = "terminal";
      render();
    },
    "tile-open-add": (el) => {
      const item = sessionById(ui.route.sessionId);
      if (!item) return;
      const tiles = workspaceTiles(item.tree, item.id);
      if (tiles.length >= 4) return toast("并排最多 2×2 四格。");
      openTilePicker(el, { mode: "add", treeId: item.tree, tiles });
    },
    "tile-open-set": (el) => {
      const item = sessionById(ui.route.sessionId);
      if (!item) return;
      const tiles = workspaceTiles(item.tree, item.id);
      openTilePicker(el, { mode: "replace", index: Number(el.dataset.index), treeId: item.tree, tiles });
    },
    "tile-add": (el) => {
      const item = sessionById(ui.route.sessionId);
      const add = sessionById(el.dataset.session);
      if (!item || !add || add.tree !== item.tree) return toast("只能并排本工作树的会话。");
      const tiles = workspaceTiles(item.tree, item.id);
      if (tiles.includes(add.id)) return;
      if (tiles.length >= 4) return toast("并排最多 2×2 四格。");
      ui.wsTiles = [...tiles, add.id];
      render();
      toast(`已并排 ${displayName(add)}。`);
    },
    "tile-set": (el) => {
      const item = sessionById(ui.route.sessionId);
      const next = sessionById(el.dataset.session);
      const index = Number(el.dataset.index);
      if (!item || !next || next.tree !== item.tree) return toast("只能并排本工作树的会话。");
      const tiles = workspaceTiles(item.tree, item.id);
      if (!Number.isInteger(index) || index < 0 || index >= tiles.length) return;
      const wasFocus = tiles[index] === ui.route.sessionId;
      const already = tiles.indexOf(next.id);
      if (already === index) return;
      if (already >= 0) {
        const swap = tiles[index];
        tiles[already] = swap;
        tiles[index] = next.id;
      } else tiles[index] = next.id;
      ui.wsTiles = tiles;
      if (wasFocus) navigate("#/workspace/" + encodeURIComponent(next.id));
      else render();
    },
    "tile-close": (el) => {
      const item = sessionById(ui.route.sessionId);
      if (!item) return;
      const tiles = workspaceTiles(item.tree, item.id);
      const index = Number(el.dataset.index);
      if (tiles.length <= 1) return;
      const removed = tiles.splice(index, 1)[0];
      ui.wsTiles = tiles;
      if (ui.route.sessionId === removed)
        navigate("#/workspace/" + encodeURIComponent(tiles[0]));
      else render();
    },
    "tile-exit": () => {
      const item = sessionById(ui.route.sessionId);
      ui.wsTiles = item ? [item.id] : [];
      render();
      toast("已退出并排，只留当前会话。");
    },
    "tile-focus": (el, event) => {
      const id = el.dataset.session;
      if (!id || id === ui.route.sessionId) return;
      const wantInput = event?.target?.closest("input, textarea");
      openSession(id);
      if (wantInput) {
        requestAnimationFrame(() => $(`[data-terminal-form="${id}"] input`)?.focus());
      }
    },
    "tile-pop": (el) => popTileFromSplit(el.dataset.session, false),
    "tile-pin": (el) => popTileFromSplit(el.dataset.session, true),
    "ws-split": (el) => {
      /* 兼容旧入口：视为添加并排 */
      ACTIONS["tile-open-add"](el);
    },
    "ws-switcher": (el) => openWorkspaceSwitcher(el, ui.route.sessionId),
    "ws-filter-clear": () => {
      ui.switchFilter = { query: "", status: "all", needs: false };
    },
    "inspector-toggle": () => {
      ui.wsInspector = !ui.wsInspector;
      render();
    },
    "end-session": (el) => terminatorExtension
      ? terminatorExtension({ sessionId: el.dataset.session, invoker: el })
      : openEndSession(el.dataset.session, el),
    "end-session-confirm": (el) => {
      const id = el.dataset.session;
      store.ended = [...new Set([...store.ended, id])];
      ui.wsTiles = (ui.wsTiles || []).filter((tid) => tid !== id);
      if (ui.float.sessionId === id) ui.float.visibility = "closed"; // 浮窗随之关闭
      save();
      closeDialog(false);
      render();
      toast("演示会话已结束；历史和输出仍可查看。");
    },
    back: () =>
      navigate(
        "#/" + (ui.origin?.name || "workbench") +
          (ui.origin?.param ? "/" + encodeURIComponent(ui.origin.param) : ""),
      ),
    "ws-grid": () => {
      const item = sessionById(ui.route.sessionId);
      if (item) openTerminals({ project: item.project, tree: item.tree });
    },
    "ws-prev": () => moveWorkspaceSession(-1),
    "ws-next": () => moveWorkspaceSession(1),
    "run-command": (el) => {
      const pending = ui.pendingByTree[el.dataset.tree] || [];
      const command = pending[Number(el.dataset.index)];
      if (!command) return;
      /* 预设布局态下命令输入到所在栏的会话 */
      addCommand(command, el.dataset.session || ui.route.sessionId);
      ui.wsTab = "terminal";
      render();
      toast("仅模拟输入了选中的命令。");
    },
    "exit-preset": () => {
      /* 退出预设布局态：回到普通单会话工作区，会话保留 */
      ui.presetLayout = null;
      render();
      toast("已退出预设布局；会话仍在运行。");
    },
    "notif-open": (el) => {
      if (!store.notifRead.includes(el.dataset.episode)) store.notifRead.push(el.dataset.episode);
      save();
      navigate("#/inbox");
    },
    "close-dialog": () => closeDialog(),
  };

  /* Public, deliberately small extension host.  Feature scripts are classic
     scripts loaded after app.js, so this assignment is complete before they run. */
  const copyDefaults = (value) => {
    if (value == null || typeof value !== "object") return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return Array.isArray(value) ? [...value] : { ...value }; }
  };
  const featureState = (name, defaults = {}) => {
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/i.test(name))
      throw new TypeError("featureState name must be a non-empty identifier");
    const current = store.featureStates[name];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      store.featureStates[name] = copyDefaults(defaults) || {};
      save();
    } else if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      for (const [key, value] of Object.entries(defaults))
        if (current[key] === undefined) current[key] = copyDefaults(value);
    }
    return store.featureStates[name];
  };
  const registerActions = (extensionActions) => {
    if (!extensionActions || typeof extensionActions !== "object")
      throw new TypeError("registerActions expects an action map");
    const names = Object.keys(extensionActions);
    for (const name of names) {
      if (!/^[a-z][a-z0-9-]*$/i.test(name) || typeof extensionActions[name] !== "function")
        throw new TypeError("action names must be identifiers with function values");
      if (Object.hasOwn(ACTIONS, name)) throw new Error(`action already registered: ${name}`);
    }
    Object.assign(ACTIONS, extensionActions);
    return () => names.forEach((name) => { if (ACTIONS[name] === extensionActions[name]) delete ACTIONS[name]; });
  };
  const extendMenu = (kind, callback) => {
    if (!["project", "tree", "session", "settings", "scenario", "notification"].includes(kind))
      throw new Error(`unsupported menu extension: ${kind}`);
    if (typeof callback !== "function") throw new TypeError("extendMenu callback must be a function");
    const callbacks = menuExtensions.get(kind) || new Set();
    callbacks.add(callback);
    menuExtensions.set(kind, callbacks);
    return () => callbacks.delete(callback);
  };
  const registerContentSlot = (kind, callback) => {
    if (!["file", "diff", "terminal"].includes(kind))
      throw new Error(`unsupported content slot: ${kind}`);
    if (typeof callback !== "function") throw new TypeError("content slot callback must be a function");
    const callbacks = contentSlots.get(kind) || new Set();
    callbacks.add(callback);
    contentSlots.set(kind, callbacks);
    return () => callbacks.delete(callback);
  };
  const registerCreator = (callback) => {
    if (typeof callback !== "function") throw new TypeError("creator callback must be a function");
    if (creatorExtension) throw new Error("a session creator is already registered");
    creatorExtension = callback;
    return () => { if (creatorExtension === callback) creatorExtension = null; };
  };
  const registerTerminator = (callback) => {
    if (typeof callback !== "function") throw new TypeError("terminator callback must be a function");
    if (terminatorExtension) throw new Error("a session terminator is already registered");
    terminatorExtension = callback;
    return () => { if (terminatorExtension === callback) terminatorExtension = null; };
  };
  window.ThreadTermPrototype = Object.freeze({
    version: "3.0.0",
    store,
    ui,
    projects: PROJECTS,
    trees: WORKTREES,
    sessions,
    sessionById,
    displayName,
    stateOf,
    isEnded,
    isMissing,
    isUnavailable,
    fileKey,
    fileValue,
    save,
    render,
    navigate,
    setTheme,
    openSession,
    openDialog,
    closeDialog,
    openPopover,
    closePopover,
    toast,
    publishAttention,
    esc,
    icon,
    agentIcon,
    btn,
    baseActions: Object.freeze({ ...ACTIONS }),
    registerActions,
    onBeforeRender: (callback) => addHook(beforeRenderHooks, callback),
    onRender: (callback) => addHook(renderHooks, callback),
    onReset: (callback) => addHook(resetHooks, callback),
    resetPrototype,
    extendMenu,
    registerContentSlot,
    registerCreator,
    registerTerminator,
    featureState,
  });

  document.addEventListener("compositionstart", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && $("#app").contains(target) &&
        (target.isContentEditable || target.matches("input, textarea"))) compositionTarget = target;
  }, true);
  document.addEventListener("compositionend", finishComposition, true);
  document.addEventListener("focusout", (event) => {
    if (compositionTarget && (event.target === compositionTarget || compositionTarget.contains(event.target)))
      finishComposition();
  }, true);
  window.addEventListener("blur", finishComposition);

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el || el.disabled) return;
    /* 弹出层内的动作点击后收起菜单 */
    if (popover && popover.root.contains(el)) closePopover();
    ACTIONS[el.dataset.action]?.(el, event);
  });

  /* select 的 change 事件（所有终端筛选） */
  document.addEventListener("change", (event) => {
    const el = event.target.closest('select[data-action="t-filter"]');
    if (!el) return;
    ui.tFilters[el.dataset.filter] = el.value;
    if (el.dataset.filter === "project" && ui.tFilters.tree !== "all" && WORKTREES[ui.tFilters.tree]?.project !== el.value)
      ui.tFilters.tree = "all";
    if (["project", "tree"].includes(el.dataset.filter))
      ui.sidebarScope = ui.tFilters.tree !== "all" ? ui.tFilters.tree : ui.tFilters.project !== "all" ? `project:${ui.tFilters.project}` : "all";
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.isComposing || compositionTarget) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!modal) openPalette(document.activeElement);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (!modal) openCreate(document.activeElement);
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && ui.route.name === "workspace" &&
        ["ArrowLeft", "ArrowRight"].includes(event.key) &&
        !document.activeElement?.matches("input, textarea, [contenteditable='true']")) {
      event.preventDefault();
      moveWorkspaceSession(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key === "Escape" && !modal && popover) closePopover();
  });

  window.addEventListener("hashchange", () => {
    closePopover();
    render();
  });

  /* ==================== 启动 ==================== */
  if (!location.hash) history.replaceState(null, "", "#/workbench");
  const tickDesktopClock = () => {
    const el = document.querySelector("[data-desktop-clock]");
    if (!el) return;
    el.textContent = new Date().toLocaleString("zh-CN", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };
  tickDesktopClock();
  setInterval(tickDesktopClock, 30000);
  document.querySelector(".app-chrome")?.addEventListener("dblclick", (event) => {
    if (event.target.closest(".app-dot, button, a")) return;
    toggleAppWindow();
  });
  render();
  /* 首次启动欢迎浮层：仅自动出现一次，可从「演示数据 ▾」重看 */
  if (!store.welcomeSeen) openWelcome();
})();
