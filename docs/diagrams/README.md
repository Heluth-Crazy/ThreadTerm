# OpenWork SVG 技术图系统 v1

这是一个 **中文优先、流程固定、图类可扩展** 的 SVG 技术图体系。

## 设计目标

- **流程固定**：统一走「需求整理 → 选图类 → 组织结构化数据 → 生成 SVG → 导出 PNG」
- **图类可扩展**：不把能力锁死在“架构图 / 流程图”两类
- **中文优先**：默认输出中文标题、中文分区、中文说明；技术名和文件名可保留英文
- **展示友好**：优先适配飞书、文档、汇报、文章配图等场景

---

## v1 固定流程

1. **识别目标**
   - 这是在讲系统结构、执行流程、模块关系、概念分层，还是别的内容？
2. **选择图类**
   - 从图类目录中选择最合适的一类
3. **组织输入数据**
   - 统一转成结构化请求（见 `diagram-request.schema.json`）
4. **选择模板变体**
   - 同一图类可以有不同版式变体
5. **生成 SVG**
   - 基于模板填充标题、节点、分组、连线、说明
6. **校验与导出**
   - 导出 SVG / PNG，检查是否裁切、拥挤、语义混乱

> 约束：**固定的是流程，不是图种数量。**

---

## 当前图类目录（v1）

### 1. 架构图 `architecture`
适合：
- 系统全景
- 分层架构
- 运行时组件关系
- 网关 / 存储 / 服务 / 客户端结构

模板：
- `architecture-template.svg`

### 2. 流程图 `workflow`
适合：
- 用户流程
- 任务生命周期
- 数据处理流程
- 审批 / 异步 / 状态流转

模板：
- `workflow-template.svg`

### 3. 模块关系图 `module-map`
适合：
- 模块职责边界
- 依赖关系
- 子系统之间的调用 / 组合

模板：
- `module-map-template.svg`

### 4. 概念图 `concept-map`
适合：
- 产品能力地图
- 概念拆解
- 主题关系图
- 业务要素和技术要素映射

模板：
- `concept-map-template.svg`

### 5. 时序图 `sequence`
适合：
- 多角色交互
- 请求 / 响应过程
- 客户端、服务端、模型、数据库之间的顺序行为

模板：
- `sequence-template.svg`

### 6. 拓扑图 `topology`
适合：
- 部署结构
- 接入关系
- 节点拓扑
- 多环境、多区域、多实例分布

模板：
- `topology-template.svg`

---

## 中文输出规则（默认）

默认要求：
- 标题：中文
- 分区标题：中文
- 节点说明：中文
- 技术名 / 文件名 / 接口名：可保留英文原文

推荐写法：
- `桥接层 / TauriEventContext`
- `LAN 网关 / http_server.rs (Axum)`
- `会话运行时 / pty.rs + ai.rs`

不推荐：
- 全英文大段堆砌
- 中文结构名与英文说明混乱交错
- 节点文案过长导致图面拥挤

---

## 结构化输入约定

统一输入 Schema 见：
- `diagram-request.schema.json`

统一的顶层字段：
- `title`：标题
- `subtitle`：副标题
- `diagram_type`：图类
- `variant`：版式变体
- `lang`：默认 `zh-CN`
- `theme`：默认 `dark-tech`
- `audience`：受众（老板、内部评审、技术设计、对外展示）
- `groups`：分组
- `nodes`：节点
- `edges`：连线
- `legend`：图例

---

## 推荐扩展方式

新增新图类时，不要改固定流程，只做三件事：

1. 在 `diagram-catalog.json` 增加图类定义
2. 新增一个 `*-template.svg`
3. 保持输入仍然兼容 `diagram-request.schema.json`

这样可以持续扩展，而不会把系统做死。

---

## OpenWork 当前产物

- `openwork-architecture.svg`
- `openwork-workflow.svg`
- 对应 PNG 预览文件

这些产物可以作为后续自动化生成的参考样例。
