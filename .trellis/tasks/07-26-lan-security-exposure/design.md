# 局域网访问安全与显式开放 · Technical Design

## Mandatory Design Spike

手机浏览器对本地自签证书的信任体验存在平台限制。实现前必须用 iOS Safari 和
Android Chrome 验证以下方案：

1. 本地 HTTPS/WSS + 二维码携带证书指纹；
2. 用户安装本地信任证书；
3. 经成熟安全库实现、由二维码公钥确认身份的应用层安全通道。

不得自行设计未经审查的密码协议。优先选择标准 TLS；若浏览器体验不可接受，
应采用经过审计的现成协议/库，而不是裸 WebCrypto 拼装。

## Exposure State

Bridge 设置拆分为：

- service enabled；
- LAN access enabled；
- effective bind address。

LAN 关闭时强制 `127.0.0.1`。LAN 开启需确认，关闭时重新绑定 loopback 并关闭
现有非本机连接。

## Pairing

一次性配对材料继续保持短 TTL、单次消费。长期 token 仅在安全通道建立后下发，
并继续以 hash 形式存储。二维码绑定电脑身份指纹，防止同网服务冒充。

## Rollback

加密方案无法在真机稳定使用时，不允许退回明文并称为完成；保持 LAN 默认关闭，
直到安全方案通过验收。
