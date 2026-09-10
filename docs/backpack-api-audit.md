# Backpack Exchange API 核查

核查日期：2026-09-11。范围为 `src/Backpack` 中现有 REST 封装，以及 Grid、TrailingStop 的 WebSocket 消费逻辑。以 [Backpack 官方文档](https://docs.backpack.exchange/) 内嵌的 OpenAPI 3.0 规范、官方更新记录及 [Backpack 官方 Rust 客户端](https://github.com/backpack-exchange/bpx-api-client) 为依据。

## 本次调整

旧盈亏历史方法替换为 `getPositionHistory({ symbol, state, marketType, limit, offset, sortDirection })`；利息历史改为 `getInterestHistory({ symbol, asset, limit, offset, sortDirection, positionId, source })`。这两处是明确的调用接口变更，外部使用方需要迁移参数和响应字段。

借贷历史的 `side` / `sources`、单笔订单 ID 校验、Linux 导入大小写、Grid 撤单事件、TrailingStop 净持仓及关闭/重连订阅处理均纳入修复。历史接口使用统一的重复键查询序列化，签名端使用相同键值序列；多值私有签名仍属于按文档实现、尚未真实账户验证的部分。下表保留原问题与官方依据，便于审查。

K 线周周期已按七天计算，月周期按 UTC 日历月边界计算，避免月底跨月溢出。依赖使用 pnpm 安装，SQLite 原生模块已加载成功；未新增生产依赖。

验证结果：`npm test` 的 15 个用例通过，覆盖 Ed25519 签名、修订后的查询、订单 ID、周/月 K 线以及 WebSocket 事件和重连。`pnpm check:api` 通过 SQLite、官方公共 status/time/markets/ticker/klines/markPrices/trades 和实际公共 WebSocket 行情检查；所有 `src` 模块可在 Linux 导入。未启动策略或提交交易。

## 已确认需要调整的接口

| 现有实现 | 官方契约与调整方向 | 来源 |
| --- | --- | --- |
| `History.getProfitAndLossHistory` 调用 `/wapi/v1/history/pnl`，签名指令 `pnlHistoryQueryAll` | 官方 2025-08-07 更新记录明确移除了 `/history/pnl`。当前历史仓位接口为 `GET /wapi/v1/history/position`、`positionHistoryQueryAll`，支持 `symbol`、`state`、`marketType`、`limit`、`offset`、`sortDirection`，不支持旧方法的 `subaccountId`。迁移方法与调用方时必须注明返回结构改变，不能宣称旧盈亏接口与新仓位接口完全等价。 | [更新记录](https://docs.backpack.exchange/#section/Changelog)、[历史仓位](https://docs.backpack.exchange/#tag/Position/operation/get_position_history) |
| `History.getInterestHistory` 使用 `type` 与 `sources` | 当前参数为 `asset`、`symbol`、`positionId`、`limit`、`offset`、`source`、`sortDirection`。`source` 为单值 `UnrealizedPnl` 或 `BorrowLend`。旧 `type` 与复数 `sources` 不属于当前契约。 | [利息历史](https://docs.backpack.exchange/#tag/Borrow-Lend/operation/get_interest_history) |
| `getBorrowPositionHistory` 在传入 `side` 时执行 `params.type = type` | 当前接口要求 `side`，枚举 `Borrow` / `Lend`；此处还有未定义变量导致的本地异常。应发送并签名同一 `side` 参数。 | [借贷仓位历史](https://docs.backpack.exchange/#tag/Borrow-Lend/operation/get_borrow_lend_position_history) |
| 单笔订单查询/撤销允许同时传入两种 ID，且丢弃 `clientId: 0` | 文档明确要求 `orderId` 与 `clientId` 只提供一个，同时提供会造成签名校验失败。`clientId` 是 `uint32`，因此零是有效 ID。 | [查询订单](https://docs.backpack.exchange/#tag/Order/operation/get_order)、[撤销订单](https://docs.backpack.exchange/#tag/Order/operation/cancel_order) |
| 历史查询把数组直接交给 Axios；签名却使用 JavaScript 数组转字符串 | `marketType` 在历史成交、历史订单、历史仓位中为数组，OpenAPI 指定 `explode: true`；传输应使用重复的无括号参数名。`sources` 则是明确规定为逗号分隔的字符串，不能与 `marketType` 共用逗号序列化规则。详见下文实测和签名限制。 | [成交历史](https://docs.backpack.exchange/#tag/Order/operation/get_fills)、[订单历史](https://docs.backpack.exchange/#tag/Order/operation/get_order_history)、[借贷历史](https://docs.backpack.exchange/#tag/Borrow-Lend/operation/get_borrow_lend_history) |
| Grid 监听 `orderCancel` 事件 | 官方事件名为 `orderCancelled`；事件还包括 `orderAccepted`、`orderExpired`、`orderFill`、`orderModified`、`triggerPlaced`、`triggerFailed`。 | [订单流](https://docs.backpack.exchange/#tag/Streams/Private/Order-update) |
| TrailingStop REST 初始化将 `netExposureQuantity` 当成仓位数量，而 WebSocket 使用 `q` | REST `netQuantity` / WS `q` 为有符号净持仓，正数为多、负数为空；REST `netExposureQuantity` / WS `Q` 包含未成交订单造成的敞口。用于平仓/止损数量时应使用净持仓的绝对值，方向单独由符号判断。 | [当前仓位](https://docs.backpack.exchange/#tag/Position/operation/get_positions)、[仓位流](https://docs.backpack.exchange/#tag/Streams/Private/Position-update) |
| 仓位关闭事件仍写入本地仓位，空仓不退订，重连保留旧订阅集合；断线回调调用未定义的重连函数 | 官方会发送 `positionClosed`，订阅时会推送当前仓位快照，快照不包含 `e`；服务端关闭连接后客户端应重新连接。应移除关闭仓位、退订对应行情，并在新连接上重新订阅。重连函数缺失属于本地实现问题。 | [仓位流与连接生命周期](https://docs.backpack.exchange/#tag/Streams) |
| K 线周期辅助函数遇到 `1w` / `1month` 时静默按 60 秒计算 | 官方 K 线枚举包含这两个周期。周应正确换算；月份应按日历月处理，不能静默降级成分钟。`startTime` / `endTime` 仍为秒。另有 `Markets.js` 导入 `../../utils` 与实际 `Utils` 目录大小写不匹配，影响 Linux 启动。 | [K 线](https://docs.backpack.exchange/#tag/Markets/operation/get_klines) |

## 保持有效的实现

- REST 主机仍为 `https://api.backpack.exchange`，WebSocket 主机仍为 `wss://ws.backpack.exchange`。原项目除 `/history/pnl` 外的现有 REST 路径仍出现在当前官方规范中；不需要整体切换到新的 API 版本。[官方介绍](https://docs.backpack.exchange/#section/Introduction)
- 当前认证仍为 Ed25519：使用 Base64 编码的私钥种子派生密钥，参数按键排序，加 `instruction` 前缀和 `timestamp`、`window` 后缀，签名结果再 Base64 编码。`X-Timestamp` 单位为毫秒；项目显式使用 `10000` 毫秒窗口，处于官方最大 `60000` 毫秒范围内。官方默认 `5000` 不意味着现有 `10000` 已失效。[认证](https://docs.backpack.exchange/#section/Authentication)、[官方客户端签名代码](https://github.com/backpack-exchange/bpx-api-client/blob/master/client/src/lib.rs)
- 私有流继续使用 `instruction=subscribe&timestamp=...&window=...`，以及单独的 `signature: [key, signature, timestamp, window]` 数组。`account.positionUpdate`、`account.orderUpdate` 和 `markPrice.<symbol>` 都仍有效。[流文档](https://docs.backpack.exchange/#tag/Streams)
- WS `B` 是入场价，`b` 是盈亏平衡价，`M` 是标记价，`p` / `P` 是已实现/未实现盈亏；标记价流仍使用 `data.p`。不要误改这些大小写。[仓位流](https://docs.backpack.exchange/#tag/Streams/Private/Position-update)、[标记价流](https://docs.backpack.exchange/#tag/Streams/Public/Mark-price)
- `triggerQuantity` 在当前 `OrderExecutePayload` 中仍是字符串，官方规范没有声明它是枚举。不能仅凭推测将现有数量字符串改成某个枚举值。[下单](https://docs.backpack.exchange/#tag/Order/operation/execute_order)
- 充值、提现历史的 `from` / `to` 仍使用毫秒；K 线的 `startTime` / `endTime` 使用秒，现有两处单位差异是正确的。[充值历史](https://docs.backpack.exchange/#tag/Capital/operation/get_deposits)、[提现历史](https://docs.backpack.exchange/#tag/Capital/operation/get_withdrawals)、[K 线](https://docs.backpack.exchange/#tag/Markets/operation/get_klines)
- 官方允许当前大部分历史查询 `limit` 最大为 `1000`，默认 `100`；现有成交历史分页使用 `1000` 仍在范围内。[成交历史](https://docs.backpack.exchange/#tag/Order/operation/get_fills)

## 无凭证的在线核验

对官方公共 `GET /api/v1/markets` 做了只读请求；核验时观察到：

| Query | 结果 |
| --- | --- |
| `marketType=PERP` | 102 个市场，均为 PERP |
| `marketType[]=PERP`（括号 URL 编码后传输） | 189 个市场，含 SPOT 与 PERP；括号形式未应用筛选 |
| `marketType=PERP&marketType=SPOT` | 189 个市场，含 SPOT 与 PERP |
| `marketType=PERP,SPOT` | 枚举解析错误 |

数量是当时快照，不应硬编码。以上验证了公共数组参数的传输方式；不能据此声称私有数组请求的签名已经在线验证。[官方市场接口](https://api.backpack.exchange/api/v1/markets?marketType=PERP)

官方 Rust 客户端的签名实现将 URL 解码后的参数收集进 `BTreeMap`，重复键会被覆盖，因此它也不能作为多值私有签名正确性的充分依据。按官方 OpenAPI 实现重复键传输时，必须让签名规范化和实际请求参数一致，并对多值场景保留离线契约测试；私有服务器的接受情况需要另行进行经授权的只读认证验证。[官方签名实现](https://github.com/backpack-exchange/bpx-api-client/blob/master/client/src/lib.rs)

同时成功读取了公共 `/api/v1/openInterest?symbol=SOL_USDC_PERP`，确认该路径与 `symbol` 参数仍工作。[官方持仓量接口](https://api.backpack.exchange/api/v1/openInterest?symbol=SOL_USDC_PERP)

## 验证边界

本次研究未读取 `.env`、未使用账户凭证、未调用私有接口或提交交易。关于私有接口的结论来自官方规范和源码，不能等同于真实账户端到端验证。历史仓位响应使用 `cumulativePnlRealized`、`unrealizedPnl` 等字段，与当前仓位的 `pnlRealized`、`pnlUnrealized` 命名不同；迁移调用方需要按实际新响应处理。[历史仓位](https://docs.backpack.exchange/#tag/Position/operation/get_position_history)

官方更新记录称当前仓位 `cumulativeInterest` 将移除，但 OpenAPI 的响应模型仍包含它；项目不依赖该字段，无需围绕该文档差异新增逻辑。仓位流 `l` 已明确为恒零的弃用占位符，项目也不应新增依赖。[更新记录](https://docs.backpack.exchange/#section/Changelog)、[仓位流](https://docs.backpack.exchange/#tag/Streams/Private/Position-update)
