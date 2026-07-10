# Telegram 通知全清單

> Status: 盤點於 2026-07-10,對照 runtime config + 程式碼逐條驗證(非憑印象)。
> 通道機制:所有通知經 `connectorCenter.notify()` 進 notifications store;
> Telegram 端 `shouldSurfaceToTelegram`(`src/connectors/telegram/helpers.ts`)決定浮現:
> **high = 無條件直推**;normal = 僅當 Telegram 是最近互動頻道才 inline。

## 一、主動推播(priority: high — 沒在看也會送到)

| 來源 | 檢查頻率 | 什麼時候才真的推 |
|---|---|---|
| **market-state-alert** | 每 1h(每 UTC 日只評估一次) | BTC 壓力反彈 v1 **狀態轉移**時;外加初始 smoke(見下方註) |
| **news-alert** | 每 10m | 命中關鍵字的重大新聞(hack / exploit / SEC / ETF / liquidation / halt…),已推過的去重 |
| **microstructure-alert** | 訂單簿 2m、資金費率 30m | 微結構異常(價差 / 深度 / 掛單失衡 / 資金費率極端),帶冷卻防洗版 |
| **account-report** | 每 5m | 帳戶風險事件且 **severity=high**(大回撤 / 近強平 / NLV 大變動) |
| **market-report(快照哨兵)** | 每 30m | 行情快照過期 ⚠️ / 恢復 ✅(程式建字) |
| **market-report(RSI 事件)** | 每 30m | RSI 區間轉換或價格大幅變動 → **AI 撰寫的行情摘要**(`notifyPriority: 'high'`,五類中唯一花 AI token 的推播) |

**檢查頻率 ≠ 發送頻率**:全部都只在條件觸發時才送,沒事就安靜。

**初始 smoke 的正確語意**(容易記錯):smoke 只在 `initialSmokeSentFor`
**不存在**時發——即**首次部署一次**;旗標持久化在 state 檔,一般重啟**不會**重發。
唯一重發情境:`runtimeIdentity`(symbol / 參數等關鍵 config)變更 → state 重置
→ smoke 再發一次。

## 二、normal priority(僅當 TG 是最近互動頻道才送)

- **market-report 安靜期摘要**:最多每 4h 一則行情一行文(零 AI token)
- **account-report 安靜期摘要**:最多每 6h 一則帳戶一行文
- **account-report 非高嚴重度風險事件**:仍會送,但 normal——不在看就不吵

## 三、對話回覆(不是通知)

直接私訊 bot 時的回覆走對話流。問「現在 BTC 壓力狀態?」→ Alice 呼叫
`market_state_report` 即時回(狀態 + 各條線距離 + 原因明細)。

## 四、目前不會發的

- **heartbeat**:config `enabled: false`
- **auto-trading 訊號**:`enabled: false` —— **維持關閉**(憲法理由見
  [runtime-topology.md](runtime-topology.md):它推「🟢 進場訊號」= 未驗證
  訊號的進場背書,Alice 不當 directionSource)
- **cron `BTC 30min report`**(883b2802,disabled):唯一殘留的使用者排程,
  功能已被 market-report + market-state-alert 覆蓋;留待日後裁定刪否

## 歷史紀錄

2026-07-10 清理:刪除兩個舊時代 footgun cron(備份於
`data/_backup/2026-07-10T14-24-31-pre-cron-cleanup-jobs.json`):

- `position-heartbeat`(fb8eeef3)——prompt 內含自動分層減倉邏輯(L1/L2/L3
  觸發 closePosition),與「人批准每一筆單」的現行憲法衝突;若日後需要
  倉位心跳,按觀察與提醒(不下指令)重寫
- `Signal Scanner - BTC/ETH Long Entry Detection`(c7e29830)——進場訊號
  產生器,directionSource 禁區
