# KCEX Futures Automation

本仓库用于开发一个**本地运行的 KCEX Futures Playwright 自动化工具**。

第一版目标：

- 本地实时 Web UI：`http://127.0.0.1:6666`
- 本地密钥解锁
- KCEX 账号 / 密码录入
- 本地加密保存凭据
- KCEX 邮箱验证码实时输入
- 登录状态 / 浏览器状态实时显示
- GPS_USDT 实时价格、余额、仓位、PnL
- 交易计划与运行日志实时显示
- 交易对：`GPS_USDT`
- 保证金模式：逐仓
- 杠杆：10x
- 单次保证金：默认 50 USDT
- 每日计划：随机 1–10 次
- 方向：可配置为随机 LONG / SHORT
- 同时最大持仓：1
- 自动设置 TP / SL
- **默认禁止实盘**

> 重要：本项目采用浏览器自动化，而不是 KCEX 官方公开交易 API。只有在账户、地区、平台规则和 KCEX 授权允许的前提下才能启用真实交易。

## 登录设计

不再依赖“打开浏览器后人工在 KCEX 页面完成全部登录”。

最终应用提供自己的本地登录面板：

```
本地密钥
KCEX 账号
KCEX 密码
邮箱验证码（需要时出现）
```

流程：

```
打开 http://127.0.0.1:6666
        ↓
输入本地密钥解锁 Vault
        ↓
读取加密保存的 KCEX 凭据
或首次输入账号密码
        ↓
Playwright 登录 KCEX
        ↓
如果要求邮箱验证码
        ↓
前端实时出现验证码输入框
        ↓
用户输入验证码
        ↓
Playwright 提交
        ↓
登录成功
        ↓
进入实时交易 Dashboard
```

安全要求：

- 本地密钥本身不落盘
- KCEX 密码只能加密保存
- 保存后前端不能读取完整密码
- OTP 验证码绝不持久化
- 密码、OTP、Cookie、Token 不进入日志
- GitHub Actions 不接触真实 KCEX 凭据
- Dashboard 默认只监听 `127.0.0.1`

详细方案：[docs/FRONTEND_AUTH.md](docs/FRONTEND_AUTH.md)

## 实时 Dashboard

首页至少展示：

```
KCEX：已连接 / 需要登录 / 需要验证码
Browser：运行中 / 已停止

模式：PAPER / LIVE
自动交易：运行 / 暂停 / HALTED

GPS_USDT
现价 / 标记价格

可用 USDT
逐仓 / 全仓
杠杆
当前方向
开仓价格
仓位价值
未实现盈亏

今日计划交易次数
已完成次数
下一次计划交易时间

实时运行日志
```

后端通过 WebSocket 向前端推送实时状态。

## 开发环境原则：GitHub Actions Only

为了不影响用户本机环境：

> **本机只编辑代码，不安装、不构建、不测试、不启动 Playwright。自动测试、TypeScript 检查和依赖安装验证均在 GitHub Actions 中运行。**

编码代理不得在用户机器运行：

```
npm install
npm ci
npm run dev
npm run build
npm run typecheck
npm test
npx playwright ...
```

真实 KCEX 登录和实际页面 DOM 验证统一标记为 deferred，直到用户明确允许后续本机运行。

## 当前开发顺序

```
TASK-001
Playwright / KCEX 只读基础架构
        ↓
TASK-002
本地实时 Dashboard
+ 加密 Vault
+ Fake Auth / OTP
        ↓
TASK-003
KCEX 账号密码登录
+ Email OTP
+ Session 恢复
        ↓
TASK-004
读取 GPS_USDT / 余额 / 杠杆 / 仓位
        ↓
TASK-005
Local SQLite Persistence
        ↓
TASK-006
Paper Trading Lifecycle
        ↓
TASK-007
RiskEngine
        ↓
受控真实交易
        ↓
TP / SL
        ↓
随机 1–10 单/天
```

任何阶段未验收，不进入下一阶段。

## TASK-001 当前状态与安全注记

TASK-001 提供只读浏览器启动与页面状态识别 scaffold。真实登录、持久化会话复用和 KCEX 实际 GPS_USDT DOM 验证均为 **DEFERRED MANUAL VERIFICATION**。Persistent Browser 当前仅为 TASK-001 scaffold；TASK-003 将依据 [docs/FRONTEND_AUTH.md](docs/FRONTEND_AUTH.md)，优先采用加密的 Playwright storage state。

在 TASK-003 实现账号密码自动填入之前，必须先将 `KCEX_BASE_URL` 限制为已确认的 KCEX 官方域名；绝不能向任意自定义 host 自动填入凭据。当前 TASK-001 不实现凭据填写。

## TASK-002 Dashboard + Vault

TASK-002 使用 React + TypeScript 和本地 TypeScript 服务提供 Dashboard / Vault scaffold，默认只绑定 `127.0.0.1:6666`。凭据由 scrypt 派生密钥并使用 AES-256-GCM 加密保存；前端只收到 `credentialsSaved` 状态。登录与六位验证码由 FakeAuthAdapter 模拟，验证码只在短时内存状态中处理。

Dashboard 和 WebSocket 当前只提供 `GPS_USDT` fixture/mock 数据，`LIVE_TRADING=false`。本阶段不连接 KCEX、不启动真实浏览器、不提交订单；真实 KCEX 登录、Email OTP、持久化会话和实际页面数据属于后续任务。

## TASK-003 Auth Integration Scaffold

TASK-003 将认证提供方显式区分为 `AUTH_PROVIDER=FAKE` 与 `AUTH_PROVIDER=KCEX`。KCEX 适配器只允许在 `https://www.kcex.com` 上填入凭据，并在每次跳转后重新检查 host；未知页面和安全挑战均失败关闭。Playwright storage state 通过 Vault 派生密钥加密保存，解密只在一次内存回调中可见。CI 使用本地 fixture，真实 KCEX 登录、邮箱 OTP 和 session 验证仍为 **DEFERRED MANUAL VERIFICATION**。

## TASK-004 Futures Read-Only State Extractor

当前状态：COMPLETE。

TASK-004 把已认证的 KCEX 页面作为一个受信任页面源，向同一个浏览器页面安装只读提取器：

```
KCEX authenticated browser
        ↓
trusted page source
        ↓
read-only futures extractor
        ↓
FuturesReadService
        ↓
shared snapshots / WebSocket
        ↓
local Dashboard
```

提取器只读取 `GPS_USDT` 的显式页面字段：价格、可用 USDT、保证金模式、杠杆、当前仓位和挂单。数值解析严格失败关闭，缺失或格式错误的数据保持 `null`，不会用 `0` 猜测。`KCEX_READONLY_ENABLED` 默认关闭，轮询只在认证状态和受信页面同时满足时启动；会话丢失、挑战页或 symbol 不匹配会停止读取，不会自动登录或刷新。

TASK-004 不包含下单、撤单、Long/Short 按钮、杠杆/保证金修改或真实 KCEX 验证。真实 DOM selector、登录 session 和 GPS_USDT 页面仍标记为 **DEFERRED MANUAL VERIFICATION**。CI 只使用 loopback fixture，并用网络 guard 拒绝意外公网请求。

## TASK-005 Local SQLite Trading Persistence

当前状态：COMPLETE。

TASK-005 建立本地 SQLite durable storage，用于保存未来上层提供的 trade records、trade lifecycle events、daily plans 和 runtime audit events，并向 Dashboard 提供只读 trade history 与 storage health。默认数据库为 `data/trading.sqlite3`，可通过 `TRADING_DB_FILE` 覆盖；数据库目录和文件权限 best-effort 收紧，数据库文件由 Git 忽略。

TASK-005 不生成交易或计划，不读取或保存市场 tick、KCEX credentials/session，也不保存 live-arm 状态。`LIVE_TRADING=false` 保持强制关闭。数据库验证只在 GitHub Actions Node 22 中运行。

## TASK-006 Paper Trading Lifecycle

当前状态：IN PROGRESS。

TASK-006 在 TASK-005 SQLite records 上实现确定性的本地 Paper 生命周期。只有 server 内部显式调用才会 plan、open、mark 或 close；Paper Position 与 KCEX Read-Only Position 在 API、WebSocket 和 Dashboard 中分开显示。模拟费率由 `PAPER_FEE_RATE` 配置，默认 `0`，不代表 KCEX 实际费率。

本阶段没有 scheduler、自动交易、自动平仓、TP/SL、爆仓或风险引擎，也不增加 Paper 写入 HTTP API。Paper 状态只用于本地模拟，绝不会创建 KCEX 请求或真实订单。`LIVE_TRADING=false` 持续强制关闭。

## 推荐技术栈

- Node.js 22+
- TypeScript
- Playwright
- React
- Fastify
- WebSocket
- SQLite
- Zod
- Pino
- Vitest
- GitHub Actions

## 实盘边界

登录成功不代表允许交易。

最终状态必须严格分开：

```
KCEX AUTHENTICATED
        ↓
READ ONLY READY
        ↓
PAPER READY
        ↓
用户显式启用 LIVE
        ↓
RiskEngine 检查
        ↓
LIVE READY
```

每次程序重启：

```
LIVE_TRADING=false
```

即使 KCEX Session 仍有效，也绝不能自动恢复实盘。
