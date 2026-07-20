# ThreadTerm 左侧布局优化提示词

## 参考原型
`prototype/layout-v2-adjusted.html`（当前最终版）

## 优化目标
对 `src/components/terminal/ProjectSidebar.tsx` 左侧侧边栏进行布局调整，同时遵循 typography / color-system / layout-typesetting 三份设计规范。

## 具体改动

### 1. 结构变更
- sidebar 头部：logo + "ThreadTerm" 文字，去掉原来的 Layers 图标 + "项目" 文字
- 头部下方新增"新建终端"和"移动端"两个导航行，占据侧边栏内容区约 1/3 空间（flex: 1），靠顶部对齐
- 原"全部终端"改名为"项目"，与项目列表整体下移至剩余 2/3 空间（flex: 2）
- 右上角 topbar 中的"新建"按钮移除

### 2. 间距节奏（layout-typesetting：8px 基准）
- sidebar-create-area（新建终端 / 移动端容器）：`padding: 16px 12px`，`gap: 8px`
- sidebar-nav（项目列表容器）：`padding: 8px`
- sidebar-divider：`margin: 8px 0`
- sidebar-row：`padding: 6px 8px`，`gap: 8px`
- project-row：`padding: 6px 8px`，`gap: 4px`

### 3. 排版规范（typography）
- 侧边栏行字号统一用 `12px`（caption 级别），不使用 13px
- 行高明确设为 `line-height: 1.35`（密集 UI）
- 快捷键提示 `⌘N` 最小用 `11px`
- 计数 badge 字号统一 `11px`

### 4. 色彩规范（color-system）
- 默认未选中行文字色：`rgba(226,232,240,0.5)`（≈ `#94a3b8`），确保 ≥ 6:1 对比度
- 新建终端/移动端默认态：`background: rgba(226,232,240,0.03)`，不完全透明
- hover 态：`background: rgba(226,232,240,0.06)`
- 选中 active 行：`background: rgba(226,232,240,0.08)`
- 不依赖颜色传达状态 — hover/focus 时配合 `outline` 或背景变化

### 5. 交互行为
- 新建终端点击：打开创建终端对话框（复用现有 `handleGridCreateTerminal` / `setCreateOpen(true)`）
- 移动端点击：保留为入口（具体行为后续定义，先占位）
- 两个元素使用完全相同的 `.create-area-row` 样式（同级优先级）

### 6. 键盘无障碍
- focus-visible 时显示 `outline: 1px solid rgba(226,232,240,0.15)` + 背景微变
- 行元素添加 `tabindex="0"` 和 `role="button"`
