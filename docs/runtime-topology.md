# Runtime 拓撲與目錄紀律

> Status: 定於 2026-07-10(OneDrive 開發樹移除日)。
> 這份文件存在的原因:曾經有兩棵並行的樹(OneDrive dev 樹 + Desktop runtime 樹),
> 造成「修 A、跑 B」的混淆與 API 金鑰躺在雲端同步資料夾的曝險。已收斂為單樹。

## 唯一主樹

```
C:\Users\Marcus\Desktop\Open Alice     ← 開發 + 運行,唯一的樹
```

- 所有開發 session(Claude Code / Codex / 編輯器)一律**從這裡啟動**
- Alice runtime 也跑在這裡(啟動 log 的 `Directory:` 應恆為此路徑)
- 遠端:`fork` = marrrrrcus/OpenAlice(push 目標 / 雲端備份);
  `origin` = TraderAlice/OpenAlice(上游,push 被 403,僅 fetch)
- 舊的 `C:\Users\Marcus\OneDrive\Desktop\Open Alice` 已於 2026-07-10 刪除,
  **不得重建**

## 為什麼 runtime 絕不能放 OneDrive(硬規則)

研究證據帳本(strategy shadow / Track D decisions)有硬守衛
`isCloudSyncedPath`(`services/uta/src/domain/research/cloud-sync.ts`,
路徑含 `onedrive` 即拒絕寫入):

1. 雲端同步的檔案鎖會撕裂 append-only JSONL
2. 第二份同步副本會鑄造平行證據(帳本 = authority,不容分叉)

把樹搬回 OneDrive 的後果是**證據管線靜默停寫**(守衛 idle,不報錯)。
這條規則優先於任何備份便利性——備份走 git push fork,不走雲端資料夾同步。

## 金鑰紀律

- `data/config/accounts.json` 含實交易 API 金鑰,`/data/*` 已 gitignore,
  但**曾長期位於 OneDrive 同步目錄**(2026-07-10 前)。
- 刪除同步資料夾 ≠ 雲端即刻消失(OneDrive 線上回收筒保留約 30 天)——
  已知曝險,處置:清空線上回收筒;更徹底的做法是輪替 OKX / Binance 金鑰。
- 金鑰永不進 repo、永不進 CLAUDE.md(CLAUDE.md 是公開的)。

## auto-trading 維持關閉(憲法理由)

`data/config/auto-trading.json` 的 `enabled: false` 是**刻意現狀,不是待辦**:

- 它啟用後會對 snapshot 的 `all_clear` 訊號推「🟢 進場訊號!」——那是
  **未經驗證的啟發式**(0/8 backtest 基準率的同族)的進場背書
- 直接違反三條軸心:Alice 有否決權沒有背書權 / 方向由策略決定 /
  沒有驗證通過的自動進場策略
- 「行情狀態自動通知」的憲法正確版**已存在**:market-state-alert
  (報狀態、附「這不是交易訊號」、永不喊進場)

## 日常工作流(單樹版)

```
在 Desktop 樹編輯 → npx tsc --noEmit → npx --yes pnpm@10.29.2 test
→ Marcus 口令後 commit(dev)→ 口令後 push fork
→ 動到 src/ 才需重啟 Alice;UI 需 rebuild;docs/config 不用
```

- pnpm 一律用 `npx --yes pnpm@10.29.2`(系統 pnpm 11.x 會毀 node_modules)
- 測試基線:3 檔 / 11 tests 的 Windows 路徑分隔符失敗為既有基線,不得增長
- 證據帳本(`data/research/**`)只由 runtime 寫,人與 AI 都不手改
