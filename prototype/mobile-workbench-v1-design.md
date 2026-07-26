# ThreadTerm 移动端工作台 V1 设计说明

配套原型：[`mobile-workbench-v1.html`](./mobile-workbench-v1.html)

## 1. 交付定位

这是一个“去掉真实后端后的完整移动端前端 UI”，不是几张静态关键页面。

原型不加载生产 Store、Bridge、PTY、系统权限或外部依赖，但完整表达：

- 配对和连接；
- 工作台、通知与注意力规则；
- 终端列表、新建、管理、详情和输入；
- 设置、权限、通知、外观、语言、诊断与关于；
- 空状态、搜索无结果、离线快照、只读、校验、确认、toast 和返回栈。

所有可见按钮都有纯前端行为。真实能力缺失时，界面使用“模拟”“只读”或
“需要桌面端处理”明确标识，不把概念能力伪装成已实现功能。

## 2. 已确定的产品决策

### 2.1 三个一级入口

```text
App Shell
├─ 工作台（默认）
├─ 终端
└─ 设置
```

不增加第四个“实例”入口。当前移动端的 TerminalHome 和 Instances 都展示会话列表，
新增工作台后继续保留两套列表会造成职责重复。V1 将它们合并：

- 工作台：发现、判断、定位；
- 终端：创建、浏览、接管和管理；
- 设置：连接、权限和偏好。

终端画布、事项详情、执行上下文详情、新建终端等都是全屏二级页面；底部导航在
二级页面中隐藏。

### 2.2 工作台只读

工作台是确定性信号的投影视图，不是任务编排器：

- 不推测任务进度、成本、测试数或依赖关系；
- 不把执行上下文称为“任务”；
- 不在卡片或详情中直接批准、拒绝、输入、重启或写文件；
- 唯一主动作是打开对应终端；
- 结构化审批在 Bridge 未支持前明确提示“需要桌面端确认”。

### 2.3 执行上下文的分组键

执行上下文按：

```text
projectPath + effectiveWorktreePath
```

聚合。同一项目的两个 Worktree 必须是两个上下文，不能沿用当前移动端仅按
`projectPath` 的分组方式。

### 2.4 摘要数字不是互斥桶

“需要处理 / 正常运行 / 待复核 / 异常”是不同观察维度。“异常”和“待复核”可能
同时属于“需要处理”，因此不能做成占比图，也不能暗示四个数字可以相加。

## 3. 页面地图

```text
配对门禁
├─ 二维码
├─ 手动地址
├─ 一次性配对码
└─ 校验 / 连接反馈

工作台
├─ 连接状态
├─ 项目与 Worktree scope
├─ 搜索
├─ 通知中心
├─ 2×2 摘要
├─ 事项分类与列表
├─ 执行上下文列表
├─ 事项详情
├─ 执行上下文详情
└─ 注意力规则

终端
├─ 活跃 / 已归档
├─ 搜索与 scope
├─ 项目 + Worktree 分组
├─ 新建终端
├─ 重命名
├─ 置顶
├─ 归档 / 恢复
├─ 关闭并删除确认
└─ 终端详情
   ├─ 输出
   ├─ 快捷键
   ├─ 输入与发送
   └─ 离线 / 只读状态

设置
├─ 连接与配对
├─ 设备权限
├─ 通知设置
├─ 注意力规则
├─ 外观
├─ 语言
├─ 连接诊断
└─ 关于 / 原型说明 / 开源许可
```

## 4. 关键任务流

### 4.1 发现并处理事项

```text
工作台摘要
→ 事项分类
→ 事项详情
→ 查看来源、原因、上下文和活动证据
→ 打开对应终端
→ 返回事项详情
→ 返回原工作台 scope / filter / search / scroll
```

### 4.2 从执行上下文接管终端

```text
执行上下文
→ 项目 + Worktree 详情
→ 查看相关事项和组内终端
→ 选择具体终端
→ 返回上下文详情
```

### 4.3 新建终端

```text
终端
→ 新建
→ 名称 / 项目路径 / Worktree
→ 终端类型
→ 新会话或恢复历史
→ 表单校验
→ 创建模拟终端
→ 终端详情
```

空工作区也走同一路径；创建后新终端会同时出现在终端列表和工作台执行上下文中。

### 4.4 配对与断开

```text
设置 → 连接与配对
→ 查看桌面设备、延迟、快照和权限
→ 重新连接 / 复制地址 / 配对另一台设备

断开并移除
→ 危险操作确认
→ 配对门禁
→ 二维码或手动连接
→ 地址与 6 位配对码校验
→ 返回工作台
```

## 5. PC → Mobile 能力映射

| PC 工作台能力 | 移动端落点 | 处理方式 |
| --- | --- | --- |
| 需处理、运行中、待复核、异常摘要 | 2×2 紧凑摘要 | 保留数字和筛选行为 |
| 审批、待输入、失败、待复核、无进展 | 横向 chips + 单列卡片 | 保留严重度与原因 |
| 项目/worktree scope | 顶部胶囊 + bottom sheet | 保留精确 scope |
| 执行上下文网格 | 单列上下文卡片 | 保留分组，不显示推测进度 |
| 桌面右侧详情栏 | 手机全屏 push | 保留完整证据链 |
| 注意力规则面板 | 二级设置页 | 说明由桌面同步 |
| 聚焦已有终端 | 终端全屏详情 | 保留原路返回 |
| xterm 预览 | 仅终端详情 | 工作台不挂载终端 |
| 项目常驻侧栏 | scope 选择 sheet | 避免挤压窄屏内容 |

## 6. 原型场景

原型支持 URL 参数：

```text
?scenario=attention
?scenario=running
?scenario=empty
?scenario=warming
?scenario=offline
```

| 场景 | 核心状态 |
| --- | --- |
| `attention` | 审批、待输入、异常和待复核并存 |
| `running` | 5 个执行上下文稳定运行，无需立即介入 |
| `empty` | 无终端；可从工作台或终端页创建 |
| `warming` | 已连接但快照尚未到达，工作台与终端显示同步状态 |
| `offline` | 保留缓存快照，显示连接条，禁用终端接管 |

桌面评审时还可切换 390×844、360×800、430×932 和 844×390 视口。评审控制位于
手机外框之外，在真实窄屏中自动隐藏，不属于产品 UI。

## 7. 完整交互清单

| 区域 | 已覆盖的前端行为 |
| --- | --- |
| 工作台 | scope、搜索、摘要定位、分类筛选、事项详情、上下文详情、规则 |
| 通知 | 打开详情、单条已读、全部已读、清空确认、测试通知 |
| 终端列表 | 搜索、活跃/归档、scope、新建、打开、菜单 |
| 终端管理 | 重命名校验、置顶、归档确认、恢复、关闭删除确认 |
| 终端详情 | Ctrl/Alt 状态、快捷键、历史命令、输入自适应、发送和模拟输出 |
| 配对 | 二维码、地址/配对码校验、连接、断开确认 |
| 权限 | 完全控制 / 只读切换，终端输入区同步禁用 |
| 通知偏好 | 系统通知、提示音、角标开关和测试反馈 |
| 外观 | 深色、浅色、跟随系统和终端密度 |
| 语言 | 四种语言选择和状态反馈 |
| 诊断 | 重连、复制脱敏诊断、模拟离线 |
| 关于 | 原型说明、许可位置、复制版本信息 |

## 8. 状态与导航模型

生产实现不应继续扩展当前 `tab + detailOpen + scannerOpen` 一类布尔组合。建议使用
明确的 route stack：

```ts
type RootTab = "workbench" | "terminal" | "settings";

type MobileRoute =
  | { name: "root"; tab: RootTab }
  | { name: "attention"; id: string }
  | { name: "execution-group"; id: string }
  | { name: "terminal"; id: string; origin: NavigationSnapshot }
  | { name: "new-terminal" }
  | { name: "notifications" }
  | { name: "rules" }
  | { name: "connection" }
  | { name: "settings-detail"; section: string };

type NavigationSnapshot = {
  tab: RootTab;
  scope: string;
  attentionFilter: string;
  searchQuery: string;
  scrollTop: number;
};
```

Workbench 和 Terminal 各自保存搜索条件；二级页面通过栈返回上一层；从工作台进入
终端时保存完整 `NavigationSnapshot`。

## 9. 后续数据契约

当前移动 Bridge 不能准确复刻 PC Workbench，生产 UI 开发前需要先补协议。建议由
桌面端计算并下发有界投影：

```ts
interface WorkbenchProjection {
  generatedAt: number;
  summary: {
    attention: number;
    running: number;
    review: number;
    failed: number;
  };
  attentionItems: MobileAttentionItem[];
  executionGroups: MobileExecutionGroup[];
  appliedRulesSummary: AppliedRulesSummary;
  capabilities: {
    openTerminal: boolean;
    respondToStructuredRequest: boolean;
    updateRules: boolean;
  };
}
```

该投影必须进入可重连恢复的 snapshot，并提供对应增量事件。移动端不应通过终端
输出文本再次推导审批、失败、完成或无进展状态。

### 9.1 已确认的数据缺口

- Mobile `CardMeta` 缺少 branch label、事件时间线和自动重启 pending 状态。
- 当前 Rust 移动快照中的 notifications 为空，重连后事项会丢失。
- 移动通知缺少稳定 ID、read、title、body 和 routing 语义。
- Bridge 没有 structured requests、Supervisor alerts 或响应请求的命令。
- Workbench rules 只持久化于桌面 renderer；移动端不能另建独立规则。
- 当前移动分组通常优先使用 `projectPath`，会合并同一项目的不同 Worktree。

### 9.2 信号优先级

后续实现必须复用 PC 的确定性优先级：

```text
结构化请求
> 未处理 Supervisor alert
> 未读通知
> 终端状态
```

自动恢复已经排队的异常不能再显示成需要人工介入。

## 10. 视觉规范

### 10.1 基础 tokens

| Token | 深色值 | 用途 |
| --- | --- | --- |
| App background | `#10151d` | 页面背景 |
| Surface | `#151b24` | 卡片和列表 |
| Surface elevated | `#202a38` | 次级控件 |
| Foreground | `#e8edf5` | 主文本 |
| Muted | `#8f9cac` | 次级说明 |
| Border | `#2d3948` | 分隔和描边 |
| Primary | `#4f8bd6` | 主动作和选中 |
| Success | `#35c66b` | 正常运行 |
| Warning | `#f0a23a` | 等待和审批 |
| Destructive | `#ef5b61` | 异常和删除 |
| Review | `#a879e8` | 待复核 |

原型同时提供浅色主题；跟随系统模式基于 `prefers-color-scheme`。

### 10.2 移动约束

- 页面使用 `100dvh` 与 safe-area inset。
- 主要点击目标不小于 44px。
- 输入框字号 16px，避免 iOS 自动缩放。
- 各 screen 独立滚动，根页面不产生横向滚动。
- 长路径和终端输出允许换行或截断。
- 360px 宽度收紧左右边距；横屏压缩状态栏、底栏和辅助控件。
- 支持 `prefers-reduced-motion`。

### 10.3 语义色约束

颜色不是唯一状态表达。事项同时显示文字标签，终端同时显示状态点和文本，离线状态
同时显示全局横幅和禁用说明。

## 11. 无障碍要求

- 所有图标按钮提供 `aria-label`。
- 筛选、主题、权限和开关使用 `aria-pressed` / `aria-checked`。
- sheet 使用 `role="dialog"` 和 `aria-modal`。
- toast 与终端输出使用 live region。
- 输入、textarea、select 均有关联 label。
- Escape 关闭当前 sheet 或二级页面。
- 焦点使用清晰的 `focus-visible` 描边。
- reduced-motion 下关闭非必要动画。

生产实现还应补充完整的焦点圈闭、路由标题播报和 iOS VoiceOver 实机检查。

## 12. 生产拆分建议

```text
mobile-app/src/
├─ navigation/
│  ├─ MobileRouter
│  └─ navigationSnapshot
├─ workbench/
│  ├─ WorkbenchScreen
│  ├─ SummaryGrid
│  ├─ AttentionList
│  ├─ ExecutionGroupList
│  └─ WorkbenchDetailScreen
├─ terminals/
│  ├─ TerminalListScreen
│  ├─ NewTerminalScreen
│  └─ TerminalDetailScreen
├─ settings/
│  ├─ SettingsScreen
│  ├─ ConnectionSettings
│  └─ NotificationSettings
└─ bridge/
   └─ workbenchProjection
```

先完成共享协议和 route stack，再拆生产组件。不要把独立原型脚本直接复制进 React
实现。

## 13. 当前验证记录

已完成：

- 内联 JavaScript 语法检查；
- 4 个场景的 DOM 初始化；
- 工作台 → scope → 事项 → 终端 → 输入模拟；
- 空工作区 → 表单校验 → 新建终端 → 列表/工作台回显；
- 终端重命名、归档和归档列表；
- 通知全部已读与清空确认；
- 设置主题、权限和配对校验；
- 二级页面嵌套返回栈；
- 43 类动态 action 与处理器映射检查；
- 全部生成页面的按钮名称、表单 label 和重复 ID 检查。

当前环境未提供可控制的浏览器实例，因此尚未完成真实浏览器截图和像素级视觉走查。
原型提供明确的 390×844、360×800、430×932 和横屏评审开关，后续首次 UI 评审应
优先检查：

1. 360px 下长项目名、路径和设置副标题；
2. 390px 下详情页证据链与固定底部动作；
3. 软键盘弹出后的终端输入区；
4. 横屏下终端输出和快捷键栏；
5. iOS safe-area、VoiceOver 和输入框缩放。
