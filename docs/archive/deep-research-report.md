# ThreadTerm 产品定位与路线深度研究

## 核心判断

基于 `main` 分支当前可见实现，我的结论很明确：ThreadTerm 的差异化应该继续收束到“多项目终端上下文管理 + AI CLI 会话编排 + 本地优先工作流”，而不是扩散成一个更通用的终端管理器，或者再造一个 AI 聊天应用。仓库里的 README 与 ROADMAP 已经把它定义为面向长期项目工作与 AI CLI 会话的 command center；而当前主干代码又已经把 card、block、workflow、notification、auto restart、AI export、supervisor 这些能力接到了同一套会话运行时模型上。换句话说，ThreadTerm 目前最有价值的不是“开一个终端”，而是把那些原本最容易丢失、最难恢复、最难交接的开发上下文，变成可组织、可返回、可导出的对象。fileciteturn9file0L1-L1 fileciteturn11file0L1-L1 fileciteturn33file0L1-L1 fileciteturn24file0L1-L1 fileciteturn38file0L1-L1

这个判断也符合外部格局。外部参照里，entity["company","Warp","terminal software company"] 正在把 typed blocks 延展到 inline agent 会话与 ADE；entity["company","Anthropic","ai company"]、entity["company","OpenAI","ai company"] 和 entity["company","Google","technology company"] 则分别把项目级命令、审批/权限、工作区配置、上下文文件、hooks、trusted folders、checkpointing 等能力深植到各自 CLI 里。也就是说，“单个 agent 在单个 repo 里怎么工作”这层，越来越被 provider 直接占据；ThreadTerm 真正仍然空着的位置，是“多个 provider、多个项目、多个长期会话如何被统一编排、提醒、恢复、沉淀和交接”。我据此判断，ThreadTerm 最该争夺的是一个本地优先的 AI CLI control plane，而不是通用终端渲染或通用聊天入口。citeturn1search0turn1search3turn0search0turn5search2turn5search3turn5search0turn2search0turn6search0turn6search1turn6search4turn7search3

## 当前主线的真实资产

ThreadTerm 当前最硬的资产，是“会话控制平面”已经基本成形。README 已经确认它把终端会话组织为 project-bound persistent cards，支持项目分组、focused terminal view、global selector 和 floating terminal；而后端 `provider_sessions.rs` 又已经实现了 provider-native recent session discovery，用于按项目路径定位最近的 Claude/Codex 会话并支持延续。这里也暴露了一个非常具体、而且和你目标用户直接相关的现实差距：当前 provider session discovery 在代码里只处理 `claude` 和 `codex`，对其他 provider 会直接返回 unsupported，这意味着“Gemini 作为一等 AI CLI 会话”的恢复语义目前仍不对称。这个差距不是抽象产品讨论，而是 `main` 分支上一个很明确的 P0 缺口。fileciteturn9file0L1-L1 fileciteturn37file0L1-L1 fileciteturn33file0L1-L1

第二个真实资产，是 ThreadTerm 已经不是“流式终端 buffer”思维，而是明显进入了 block-aware 语义层。`Block` 已包含 `cwd`、`command`、开始结束时间、退出码、buffer 边界与 `output` 快照；Block Inspector、跨会话搜索、书签、AI explain、AI thread export 都是建立在这个块级语义之上。尤其值得强调的是，当前 `ai_explain` 不是把 AI 混进 PTY 流，而是通过单独的 Tauri command 启一个本机 CLI 子进程，以 30 秒 timeout、8KB prompt cap 的 side-channel 方式返回结果，并明确“不碰用户 PTY card”。这是一个非常有价值的产品边界：它让“AI 辅助”成为会话上下文之上的附属能力，而不是污染终端本体。这个边界，恰恰是 ThreadTerm 避免滑向“泛 AI chat app”的关键。fileciteturn33file0L1-L1 fileciteturn36file0L1-L1 fileciteturn35file0L1-L1

第三个真实资产，是本地优先的数据 IO 和工作流模型已经有了很强的“可分享但不泄密”基础。设置导出不是 raw localStorage dump，而是白名单 bundle：只导出 `theme`、`customThemes`、`terminal`、`overlay`、`workflows` 五类 section；UI 还明确写着 bridge tokens、paired devices、provider keys、cards、terminal output 都不会被导出。工作流侧则已经实现了本地/项目两级目录发现、项目覆盖全局、单文件 256KB 上限、Warp-compatible YAML schema，并只额外扩展 `intent` 与 `cwd` 两个字段。也就是说，ThreadTerm 已经具备了一个很有竞争力的“本地可移植开发环境包”雏形，只是现在这个雏形还没有被上升成更强的产品叙事。fileciteturn24file0L1-L1 fileciteturn32file0L1-L1 fileciteturn40file0L1-L1 fileciteturn41file0L1-L1

第四个真实资产，是注意力路由已经不是概念验证，而是正在形成系统。`autoRestart.ts` 已实现 opt-in、最大重试次数、指数退避和历史记录；`supervisor.rs` 则已经是一个规则化的 attention notifier：只监听 watched pinned cards，基于 block-finished 与 idle tick 触发，内置 8 个规则、60 秒 cooldown、sample text 裁剪；前端 `supervisorStore` 还做了二次 dedup、50 条 FIFO 上限和 `triggered / clicked / acted` 三个会话级 telemetry 计数。这一整层其实已经说明，ThreadTerm 的自然演化方向是“后台会话注意力编排”，而不是“在终端旁边塞一个聊天面板”。fileciteturn25file0L1-L1 fileciteturn38file0L1-L1 fileciteturn39file0L1-L1 fileciteturn42file0L1-L1

## 外部格局与 ThreadTerm 应占的位置

和 Warp 的关系，最好理解成“借势而不对打”。Warp 的公开说明已经把 block model 讲得非常清楚：它的 viewport 是有类型的 block list，不再只是字符网格，而且它现在已经把 rich content 与 agent conversation 直接塞进同一条滚动流里；同时，Warp 的 workflow 体系已经从 YAML 支持延伸到了带编辑器、搜索、团队同步的 Warp Drive，并明确提到团队编辑依赖联网和即时同步。在这种情况下，ThreadTerm 没必要去和 Warp 争“最强 block-native terminal”或“最完整云端 workflow hub”。ThreadTerm 真正聪明的做法，是继续兼容 Warp 的 YAML 资产，把它吸纳成配置与预设输入，然后把价值放在 Warp 没有强占、而且更适合 local-first 的那层：多项目、多 provider、可恢复、可通知、可导出的会话编排。citeturn1search0turn1search2turn1search3 fileciteturn41file0L1-L1

和 provider CLI 的关系，也应该是“编排其上，而不是复刻其内”。Claude Code 官方文档已经把 `.claude/settings.json`、`.claude/settings.local.json`、`.claude/commands/`、hooks、CLAUDE.md 等体系做得很完整；Codex CLI 官方资料强调它是本地运行的 coding agent，具有 Suggest / Auto Edit / Full Auto 等审批模式；Gemini CLI 也已经有工作区级 `.gemini/settings.json`、`GEMINI.md`、custom commands、checkpointing、trusted folders 与 MCP 扩展。也就是说，这些 CLI 自己正在形成“项目本地 agent 规范栈”。ThreadTerm 如果再去做一层通用聊天侧栏、通用提示词中心、通用 agent DSL，很容易变成与这些 provider 正面重叠、又做不出比它们更深的那一层。相反，ThreadTerm 应当做它们的容器、索引器、调度器和产物层：谁在跑、跑在哪个项目、什么时候需要我回来、结果如何沉淀，这才是它最值得拥有的产品位置。citeturn0search0turn5search2turn5search3turn5search0turn2search0turn5search1turn6search0turn6search1turn6search4turn7search3

如果把这句话压缩成一句新的定位文案，我会建议是：**ThreadTerm 不是“会回答问题的终端”，而是“知道哪个项目、哪个会话、哪个 agent 现在值得你回来处理的本地控制平面”。** 这个定位既尊重现有代码的重心，也能把 card / block / workflow / notification / export / supervisor 这些看似分散的能力重新拉回一条主线。fileciteturn9file0L1-L1 fileciteturn11file0L1-L1 fileciteturn33file0L1-L1

## 概念组织与信息架构

你现在最需要警惕的，不是功能不够多，而是概念太平行。当前模型里同时存在 terminal cards、threads、blocks、projects、workflows、AI explain、supervisor、export；如果把这些都作为并列名词推到前台，用户很容易需要先学“系统内世界观”，才能开始工作。我的建议是把前台概念压缩成三个层次：**项目**是容器，负责聚合路径、预设、workflow、AI 资产和导出物；**会话**是主操作单元，card 应继续作为最主要的用户名词；**证据与产物**则收纳 block、bookmarks、notifications、AI explain、AI thread 与 export。也就是说，`block` 应该更多出现在 focused view、search、inspector 与 export 里，而不是一上来就变成新用户的第一层心智；`thread` 也更适合作为 AI 回复流的内部结构，而不是和 card 平起平坐的顶层对象。fileciteturn33file0L1-L1 fileciteturn35file0L1-L1 fileciteturn9file0L1-L1

同理，workflow 和 supervisor 不应该是与 project/card 并列的“世界观名词”，而应该是两类后台能力：workflow 属于项目资产和启动动作，supervisor 属于注意力路由和回流机制。当前代码实际上已经天然支持这种表达：workflow 来自目录发现、palette 与 chip 入口，supervisor 则完全依附于 pinned cards、notification funnel 和 telemetry。换句话说，ThreadTerm 不需要再新增更多一级导航名词，它需要做的是把现有模型收拢成一个更自然的问题流：**我在哪个项目？我该回到哪个会话？我要带走什么结果？** 只要这个问题流顺，底层有多少模型并不会成为用户负担。fileciteturn40file0L1-L1 fileciteturn34file0L1-L1 fileciteturn42file0L1-L1

## AI Supervisor 的演化路径

当前 v0.1 的形态其实相当健康。后端只在 feature enabled 时持有监听，不开则零 watcher 状态；规则集是封闭枚举，当前共有 8 个稳定 rule id；触发逻辑既支持 `pty://block-finished` 也支持 idle rescan；同一 `(cardId, ruleId)` 60 秒内抑制重复；前端再次做 60 秒 dedup，并把 alert 队列限制在 50 条，同时记录 `triggered / clicked / acted` 三类会话内指标。这种设计说明作者已经把它当成“价值验证中的注意力系统”，而不是“会自动替你操作的 agent”。这条路线是对的。fileciteturn38file0L1-L1 fileciteturn39file0L1-L1

下一步的重点，不应该是盲目增加更多 regex，而应该是提高相关性和可控性。具体来说，v0.2 最值得做的是三件事：其一，加入**按 provider / 项目 / terminalType 的 rule profile**，因为不同 CLI 的 prompt 语义和噪音特征不同；其二，给每条告警增加**轻量反馈动作**，例如 mute this rule、snooze 10 min、在此项目禁用、标记为误报；其三，引入**稳定提示门槛**，例如在同一 rule 命中后等待几秒确认 prompt 仍未解决再发通知，从而压掉闪烁式临时输出。这些演化都可以直接复用现有 `ruleId`、`sampleText`、notification funnel、cooldown 和 telemetry，不需要变成 agentic 自动操作。这个方向也和 provider 自己的安全模型一致：Codex 强调审批模式，Claude Code 强调 hooks/permissions，Gemini CLI 强调 trusted folders 和安全模式——执行权和权限边界最好继续留在 provider CLI 自己手里，ThreadTerm 负责路由注意力，而不是接管执行。fileciteturn38file0L1-L1 fileciteturn39file0L1-L1 citeturn5search0turn5search3turn5search1turn6search0

再下一步，v0.3 最有价值的不是“更自动”，而是“更可学习”。你们当前已经有 `clicked` 和 `acted within 60s` 的雏形，这意味着完全可以把 supervisor 做成一个**闭环验证系统**：哪些规则点击率高、哪些规则误报多、哪些项目最常打断、哪些 provider 最需要 attention。等这些数据跑出形态之后，再决定要不要引入一个很薄的本地语义层，例如用户点开某条告警后，用本机 AI CLI 解释“为什么它触发、用户通常接下来要做什么”，而不是让系统替用户输入。这样既符合 local-first 约束，也避免 supervisor 从“提醒系统”滑向“高噪音自动代理”。fileciteturn39file0L1-L1 fileciteturn36file0L1-L1

## Export、Workflow 与团队入口

AI Markdown export 已经具备了升级为“产物系统”的最低骨架。当前 `renderAiSessionMarkdown` 输出的不是裸聊天记录，而是带有 user intent、provider、session id、开始结束时间、source context、project/path/cwd/command/launch command 等元数据的 Markdown；当没有消息时，它也会明确写出 `_No prompt or reply content is available for this session._`。这说明它天生就不是单纯 transcript，而是一个可沉淀、可归档、可发给他人的 artifact 容器。因此，我非常认同你提出的方向：它完全可以往三类产物发展——**research archive**、**debugging report**、**handoff artifact**。你们不需要发明一个新系统，只需要在现有 export source 上，再拼接选定的 block 输出、关联 notification timeline、触发时的 workflow/preset 信息，以及最后的“下一步建议”。fileciteturn35file0L1-L1 fileciteturn33file0L1-L1

这里最值得做的新增能力，我认为不是“更多导出格式”，而是一个**项目 AI 资产索引**。具体说，针对每个项目根目录，ThreadTerm 应主动探测并在项目侧边栏、命令面板、file explorer 或 focused card 入口里显式暴露这些资产：`.threadterm/workflows/`、`.claude/settings.json`、`.claude/commands/`、`.gemini/settings.json`、`.gemini/commands/`、`GEMINI.md`、`AGENTS.md`。因为从 provider 官方文档看，Anthropic 已经把项目设置和 project commands 放在 `.claude/`，Gemini CLI 把工作区设置、`GEMINI.md` 和 project custom commands 放在 `.gemini/`，而 OpenAI 又在推进 `AGENTS.md` 这样的开放格式。ThreadTerm 最聪明的产品动作，不是再造这些格式，而是把它们 index 出来、和当前项目卡片、workflow preset、export artifact 连起来，然后提供诸如“按当前 intent 启动某 provider 会话”“把项目上下文文件打包进 explain/export”“查看本项目 agent 入口清单”这样的操作。这样做既极其 local-first，又高度复用现有 `project / workflow / export / file explorer` 模型。citeturn0search0turn5search2turn6search0turn6search1turn6search4turn7search3 fileciteturn40file0L1-L1

Workflow/preset 这条线，也完全可以成为团队共享开发环境的入口，但前提是坚持 **Git-first，而不是 cloud-first**。当前实现已经支持本地全局目录、项目目录、项目覆盖全局、Warp-compatible schema、仅附加 `intent / cwd` 两个扩展字段，这让 `.threadterm/workflows/` 非常适合被视为“项目启动 runbook”。README 也已经鼓励在需要团队共享时提交该目录，不共享时加入 `.gitignore`。与 Warp Drive 那种偏云端协作、在线编辑与即时同步的路线不同，ThreadTerm 更适合的位置是：让团队把本地 workflow、项目级 AI context 文件、导出模板与预设视为和 `.editorconfig`、`AGENTS.md` 一样可评审、可提交、可回滚的 repo 资产。这个方向非常符合 power user 和 local-first 开发团队的品味。fileciteturn9file0L1-L1 fileciteturn40file0L1-L1 fileciteturn41file0L1-L1 citeturn1search3turn6search4

## 优先级判断

**最值得立刻投入的 P0，是“统一 AI CLI 会话语义”。** 现有代码层面，provider-native recent session discovery 只支持 Claude/Codex，而产品目标用户又明确覆盖 Gemini 高频用户；这意味着 ThreadTerm 在“AI CLI session manager”这条主叙事上还存在核心不一致。优先级最高的动作，应当是补齐 Gemini 的 native session discovery / resume-ready 语义，并统一三类 provider 的会话状态表达，比如 running、waiting、reply-ready、resume-available、needs-approval、failed、auto-retrying。这个能力一旦统一，global selector、notification、floating terminal、auto restart、supervisor 才会真正形成“跨 provider 会话控制平面”。fileciteturn37file0L1-L1 fileciteturn33file0L1-L1 citeturn5search0turn2search0

**第二个 P0，是“项目 AI 资产索引 + 上下文打包”。** 这件事的产品收益非常高，但技术代价并不大，因为 provider 已经把项目级上下文与命令资产标准化到了本地文件结构里。ThreadTerm 只要把这些文件扫描、索引、可视化，并和当前的 project cards、workflow presets、AI explain、Markdown export 连接起来，就会立刻获得一个别人很难复制的优势：它不是在替代 provider CLI，而是在把多个 provider 的项目级上下文重新编排为一个统一入口。对多项目开发者来说，这个价值比新增一个“聊天侧栏”大得多，也更符合你们的 local-first 约束。citeturn0search0turn5search2turn6search0turn6search1turn6search4turn7search3 fileciteturn40file0L1-L1

**P1 我会放在“产物化”和“注意力系统提纯”。** 前者包括把现有 AI Markdown export 拓展成 debugging report / research archive / handoff artifact 三个模板，并补上 block、workflow、notification 维度；后者则是把 supervisor 做出 per-rule mute、provider profile、稳定性门槛和误报反馈，而不是立刻追求更多规则或者更自动的代理行为。这两条都几乎不要求新增基础模型，只要求把现有模型组织得更有产品感。fileciteturn35file0L1-L1 fileciteturn39file0L1-L1 fileciteturn38file0L1-L1

**Floating terminal / global selector 的正确扩展方向，是“跨应用 re-entry surface”，而不是第二个完整工作台”。** 现有实现已经支持全局快捷键和独立浮窗，当前技术栈本身也适合多窗口与全局快捷键工作流；因此你们完全可以让 overlay 显示更丰富但仍然轻量的状态，例如 last alert、reply ready、auto-retry countdown、quick open，而不必把它扩成能完整配置工作流、管理导出、编辑提示词的完整 UI。Overlay 的职责应该是“把你拉回正确会话”，不是“在另一个窗口里重新管理一遍所有抽象”。fileciteturn9file0L1-L1 citeturn4search0turn4search1turn3search2

**当前最该暂缓的，是那些会把 ThreadTerm 拉回泛工具定位的方向。** 我会明确延后四类东西：通用 AI chat sidebar、自建 API key/agent 配置中心、云同步团队协作平台、以及沿着“更像 Warp”去做的重渲染/重工作流编辑器路径。原因不是这些方向没市场，而是 Warp 和各 provider CLI 都已经在各自强项上投入极深；而 ThreadTerm 自己的 README、ROADMAP 和当前主干实现，已经给出了一条更锋利也更可信的主线：做一个本地优先、项目绑定、可恢复、可提醒、可导出的 AI CLI 会话控制平面。继续沿这条线打深，ThreadTerm 才会越来越像一个独立品类，而不是“终端 + 一点 AI + 一点工作流”的集合。fileciteturn9file0L1-L1 fileciteturn11file0L1-L1 citeturn1search0turn1search3turn5search0turn2search0