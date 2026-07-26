# 局域网访问安全与显式开放 · Implementation Plan

## Step 1 — Exposure Default

- [x] impact bridge start/status/settings/persist。
- [x] 新安装与迁移后的默认绑定均为本机。
- [x] 增加显式 LAN 选项、二次确认和停止服务时断连。

## Safe Hardening

- [x] 局域网运行期间持续展示明文风险，不伪装成安全连接。
- [x] 桌面页面禁止向任意外部 HTTPS 地址主动传输数据。
- [x] 手机页面增加同源加载、禁止嵌套、禁止来源泄露和类型嗅探保护。
- [x] 旧网址 token 兼容路径只记录累计次数，不把完整网址写入访问日志。

## Step 2 — Security Spike

- [ ] 在 iOS Safari / Android Chrome 验证标准 TLS 路径。
- [ ] 记录证书建立、信任、更新和指纹校验流程。
- [ ] 若 TLS UX 不可用，评估成熟安全通道库并做威胁模型审查。

## Step 3 — Encrypted Pairing and Transport

- [ ] 长期 token 只在安全通道内传递。
- [ ] 二维码绑定电脑身份。
- [ ] HTTP/WS 明文端点不得传输终端或凭证。

## Validation

- [ ] 抓包检查。
- [ ] 冒充服务/重放/过期二维码测试。
- [x] 默认本机、LAN 确认、运行中警告与停止断连自动测试。
- [ ] 两类真机浏览器验收。
- [x] 全量门禁和安全复核。

## Decision Gate

- [ ] 由用户确认“应用内证书与电脑身份校验”或“只支持成熟加密隧道”后，
  再实施真正的局域网加密；当前不得把风险提示当成加密完成。
