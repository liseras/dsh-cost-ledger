# 消费账本（Cost Ledger）

桌宠式用量记账插件。你用的模型网关（`zhaoli` 天翼云 AI 网关）没有用量/余额接口，
所以这本账直接读本机已经落盘的会话日志，把每次模型调用上报的 token 折算成钱。

## 数据来源

- 路径：`%DSH_HOME%/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`（旧格式 `session.jsonl.zstd` 同样支持）
- 每条 `assistant/message` 事件里的 `data.usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`）与 `data.message.source.model`
- 覆盖**全部工作区、全部会话、全部子代理**，与窗口无关：算的是这台机器真实发出的每一次模型请求
- 解析结果缓存在 `%DSH_HOME%/cost-ledger/scan-cache.json`，按文件大小+mtime 增量，首次约 30 秒，之后 100ms 级

## 记账规则

- 日切：**每天 05:00**（本地时间），05:00 前算前一天
- 计价：`元 / 百万 token`，四类单价（输入、缓存命中、缓存写入、输出）
- 默认价表按模型名包含匹配，`*` 为兜底行：

| 匹配 | 输入 | 缓存命中 | 缓存写入 | 输出 |
|---|---|---|---|---|
| `deepseek` | 2 | 0.2 | 2 | 3 |
| `glm` | 4 | 0.8 | 4 | 16 |
| `*` | 2 | 0.2 | 2 | 3 |

价表可在面板「价表」页直接改，存在 `%DSH_HOME%/cost-ledger/prices.json`。

## 使用

- 右下角胶囊：今日花费 + 近 7 日迷你曲线
- 点一下展开面板：
  - **概览**：今日/昨日/近 7 天/近 30 天/本账务月/累计、token 分解、今日按模型、近 7 天明细
  - **曲线**：近 30 天每日折线图、近 12 周柱状图（悬停看数值）
  - **价表**：编辑四类单价，保存即时生效
- 面板底部显示扫描状态，「立即重算」强制重扫

## 接口

Host 半注册在 `/cost-ledger/api` 下：`GET /summary`、`POST /refresh`、`GET|POST /prices`、`POST /reset-prices`。
