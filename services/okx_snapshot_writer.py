#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
okx_snapshot_writer.py
======================
每 5 分鐘向 Open Alice 輸出一份 market-snapshot.json，內含：
  - OKX 真實帳戶的淨值、持倉、掛單（資料 A）
  - BTC/USDT:USDT 與 ETH/USDT:USDT 的 Signal Scanner 進場指標（資料 B）

輸出路徑：ALICE_MARKET_SNAPSHOT_PATH，可用 .env / 系統 env 覆寫。
更新頻率：每 POLL_INTERVAL_SECONDS 秒（預設 300 秒 = 5 分鐘）

採用 atomic write（tmp → rename），避免 Alice 讀到寫入一半的檔案。
OKX 憑證從環境變數讀取（.env 或系統 env）：
  OKX_API_KEY / OKX_SECRET / OKX_PASSPHRASE
"""

import asyncio
import json
import logging
import os
import sys
import signal
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import ccxt.async_support as ccxt
from dotenv import load_dotenv

# Windows cp1252 console 修正：強制 stdout/stderr 使用 UTF-8
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ─── 路徑設定 ────────────────────────────────────────────────────────────────

# This writer lives at <repo>/services/okx_snapshot_writer.py, so its repo
# root is one level up. All I/O (.env, logs, snapshot output) is anchored
# to REPO_ROOT, not the script dir — keeps the writer self-contained inside
# Open Alice with no absolute paths and no dependency on the old v8 project.
PROJECT_DIR = Path(__file__).resolve().parent
REPO_ROOT = PROJECT_DIR.parent
load_dotenv(REPO_ROOT / ".env")
OUTPUT_PATH_ENV = "ALICE_MARKET_SNAPSHOT_PATH"
DEFAULT_OUTPUT_PATH = REPO_ROOT / "data" / "market-snapshot.json"
POLL_INTERVAL_SECONDS = 300  # 5 分鐘
WRITER_VERSION = "2.1.0"  # 2.1: netLiq=free+positions, LINK signals, contracts×contractSize

# Must align with trading-rules.json (BTC/ETH/LINK-USDT-SWAP) → CCXT unified keys.
SYMBOLS = ["BTC/USDT:USDT", "ETH/USDT:USDT", "LINK/USDT:USDT"]
SNAPSHOT_CIRCUIT_BREAKER_ENV = "ALICE_SNAPSHOT_CIRCUIT_BREAKER"
OHLCV_LIMIT = 10       # 拉最近 10 根日線，用於計算連跌天數與成交量比率
CONSEC_WINDOW = 5      # 連跌天數判斷最多回看 5 根已收盤日線


def _resolve_output_path() -> Path:
    configured = os.getenv(OUTPUT_PATH_ENV, "").strip()
    return Path(configured).expanduser() if configured else DEFAULT_OUTPUT_PATH


OUTPUT_PATH = _resolve_output_path()

# ─── 進場條件閾值（Alice Signal Scanner）─────────────────────────────────────

THRESHOLD_DAILY_CHANGE_PCT = -3.0     # 當日跌幅 ≥ 3%（回測驗證：-3% 樣本增加且勝率不降，優於 -5%）
THRESHOLD_CONSEC_DOWN_DAYS = 2        # 連跌 ≥ 2 日
THRESHOLD_LOWER_SHADOW_RATIO = 0.4   # 下影線佔 K 棒總長 ≥ 40%（買盤支撐訊號）
THRESHOLD_UPPER_SHADOW_RATIO = 0.4   # 上影線佔 K 棒總長 < 40%（賣壓過重時排除）
THRESHOLD_VOLUME_RATIO = 0.8          # 成交量不低於近 10 日均量的 80%（防死貓彈）

STOP_LOSS_BUFFER = 0.98               # 止損位 = 最近 5 日低點 × 0.98（留 2% buffer）

FEAR_GREED_API = "https://api.alternative.me/fng/?limit=1"
FEAR_GREED_TIMEOUT_SEC = 5

# ─── 日誌設定 ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [okx_snapshot] %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(REPO_ROOT / "logs" / "okx_snapshot.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("okx_snapshot")

# 確保 StreamHandler 不因 Windows 編碼崩潰
for _h in logging.root.handlers:
    if isinstance(_h, logging.StreamHandler) and not isinstance(_h, logging.FileHandler):
        _h.setStream(open(sys.stdout.fileno(), mode='w', encoding='utf-8', errors='replace', closefd=False))

# ─── 優雅關閉 ─────────────────────────────────────────────────────────────────

_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    logger.info(f"收到信號 {signum}，準備關閉...")
    _shutdown = True


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)

# ─── OKX 建立 ────────────────────────────────────────────────────────────────


def _build_exchange() -> ccxt.okx:
    api_key = os.getenv("OKX_API_KEY", "").strip()
    secret = os.getenv("OKX_SECRET", "").strip()
    passphrase = os.getenv("OKX_PASSPHRASE", "").strip()

    if not api_key or not secret or not passphrase:
        raise EnvironmentError(
            "OKX credentials not set. Please fill OKX_API_KEY / OKX_SECRET / OKX_PASSPHRASE in .env"
        )

    exchange = ccxt.okx({
        "apiKey": api_key,
        "secret": secret,
        "password": passphrase,
        "enableRateLimit": True,
    })
    _patch_okx_keysort_none_ids(exchange)
    return exchange


def _patch_okx_keysort_none_ids(exchange: ccxt.okx) -> None:
    """Allow current ccxt OKX market loading to tolerate None market ids.

    ccxt 4.5.42 can receive an OKX market entry with a None id, then its default
    keysort calls sorted(dictionary.items()), which compares None with strings
    and raises TypeError. Keep the workaround scoped to this writer's exchange
    instance so other exchange clients retain their normal ccxt behavior.
    """

    def _safe_keysort(dictionary):
        return dict(sorted(dictionary.items(), key=lambda item: "" if item[0] is None else str(item[0])))

    exchange.keysort = _safe_keysort


async def _patch_exchange_resolver(exchange: ccxt.okx) -> None:
    """
    修補 ccxt 內部的 aiohttp TCPConnector，改用 ThreadedResolver（系統 getaddrinfo）。
    規避 Windows 上 aiodns 無法聯繫 DNS server 的問題。
    必須在 exchange 完成首次 load_markets 之前呼叫（await load_markets 會觸發建立 session）。
    """
    import ssl
    import certifi

    # 觸發 ccxt 建立其內部 session（只有 async context 才能建立）
    if exchange.session is None:
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        connector = aiohttp.TCPConnector(
            ssl=ssl_ctx,
            resolver=aiohttp.ThreadedResolver(),
            use_dns_cache=False,
            enable_cleanup_closed=True,
        )
        exchange.tcp_connector = connector
        exchange.session = aiohttp.ClientSession(connector=connector)
        exchange.own_session = True

# ─── 資料 A：帳戶持倉與掛單 ──────────────────────────────────────────────────


async def _fetch_account(exchange: ccxt.okx) -> dict:
    """取得帳戶淨值、所有持倉、所有掛單。

    netLiquidation 對齊 Open Alice CcxtBroker.getAccount：
      free USDT + Σ (|contracts| × contractSize × markPrice)
    勿用 balance.total.USDT（僅 swap 子帳餘額，會嚴重低估）。
    """
    balance, positions, orders = await asyncio.gather(
        exchange.fetch_balance(),
        exchange.fetch_positions(),
        exchange.fetch_open_orders(),
    )

    free_usdt = float((balance.get("free") or {}).get("USDT") or 0)

    pos_list = []
    total_position_value = 0.0
    for p in positions:
        contracts = abs(float(p.get("contracts") or p.get("amount") or 0))
        contract_size = float(p.get("contractSize") or 1)
        qty = contracts * contract_size
        if qty == 0:
            continue
        mark_price = float(p.get("markPrice") or 0)
        total_position_value += qty * mark_price
        pos_list.append({
            "symbol": p["symbol"],
            "side": p.get("side", ""),
            "quantity": qty,
            "avgCost": float(p.get("entryPrice") or p.get("averagePrice") or 0),
            "unrealizedPnL": float(p.get("unrealizedPnl") or 0),
        })

    net_liquidation = free_usdt + total_position_value

    order_list = []
    for o in orders:
        order_list.append({
            "id": str(o.get("id", "")),
            "symbol": o.get("symbol", ""),
            "type": o.get("type", ""),
            "side": o.get("side", ""),
            "price": float(o.get("price") or 0),
        })

    return {
        "netLiquidation": net_liquidation,
        "positions": pos_list,
        "orders": order_list,
    }

# ─── 資料 B：Signal Scanner ───────────────────────────────────────────────────


def _calc_signal(symbol: str, ticker_price: float, ohlcv: list) -> dict:
    """
    ohlcv: list of [timestamp, open, high, low, close, volume]，由新到舊排列（最新索引 0）。
    取已收盤日線（跳過最後一根可能還在走的日線，如果當天日線尚未完整）。
    由於 OKX fetch_ohlcv 回傳的最後一根可能是正在走的當日線，
    我們直接取 [:-1]（排除最後一根）作為「已收盤」日線集合。
    """
    if len(ohlcv) < 2:
        return _signal_error(symbol, ticker_price, "K 線資料不足")

    # 已收盤日線（最新的排最後；ccxt 回傳順序是舊→新）
    closed = ohlcv[:-1]  # 去掉最後一根（當日可能還沒收盤）

    if not closed:
        return _signal_error(symbol, ticker_price, "已收盤 K 線為空")

    latest = closed[-1]   # 最新一根已收盤日線
    o, h, l, c = float(latest[1]), float(latest[2]), float(latest[3]), float(latest[4])
    vol = float(latest[5])

    # ── daily_change_pct ──────────────────────────────────────────────────────
    daily_change_pct = ((c - o) / o * 100) if o != 0 else 0.0

    # ── consecutive_down_days ─────────────────────────────────────────────────
    # 從最新往回數：close 依序嚴格小於前一根 close 的連續根數
    window = closed[-CONSEC_WINDOW:]  # 最近 5 根
    consec = 0
    for i in range(len(window) - 1, 0, -1):
        if float(window[i][4]) < float(window[i - 1][4]):
            consec += 1
        else:
            break

    # ── lower_shadow_ratio / upper_shadow_ratio ───────────────────────────────
    candle_range = h - l
    lower_shadow = (min(o, c) - l) if candle_range > 0 else 0
    upper_shadow = (h - max(o, c)) if candle_range > 0 else 0
    lower_shadow_ratio = lower_shadow / candle_range if candle_range > 0 else 0.0
    upper_shadow_ratio = upper_shadow / candle_range if candle_range > 0 else 0.0

    # ── volume_ratio ──────────────────────────────────────────────────────────
    recent_10 = closed[-10:]
    avg_vol = sum(float(k[5]) for k in recent_10) / len(recent_10) if recent_10 else 1
    volume_ratio = vol / avg_vol if avg_vol > 0 else 0.0

    # ── suggested_stop_loss（最近 5 根已收盤日線最低點 × 0.98）────────────────
    # 作為進場時的止損參考；掛單後以實際訂單為準，不應再更新
    recent_5_lows = [float(k[3]) for k in closed[-5:]]
    stop_loss_ref = min(recent_5_lows) * STOP_LOSS_BUFFER if recent_5_lows else None

    # ── all_clear 條件判斷 ────────────────────────────────────────────────────
    fail_reasons = []
    if daily_change_pct > THRESHOLD_DAILY_CHANGE_PCT:
        fail_reasons.append(
            f"跌幅不足{abs(THRESHOLD_DAILY_CHANGE_PCT):.0f}%（當前 {daily_change_pct:.1f}%）"
        )
    if consec < THRESHOLD_CONSEC_DOWN_DAYS:
        fail_reasons.append(f"連跌天數不足2日（當前 {consec} 日）")
    if lower_shadow_ratio < THRESHOLD_LOWER_SHADOW_RATIO:
        fail_reasons.append(f"下影線比值不足0.4（當前 {lower_shadow_ratio:.2f}）")
    if volume_ratio < THRESHOLD_VOLUME_RATIO:
        fail_reasons.append(f"成交量萎縮（{volume_ratio:.2f}x，需 ≥{THRESHOLD_VOLUME_RATIO}x）")
    if upper_shadow_ratio >= THRESHOLD_UPPER_SHADOW_RATIO:
        fail_reasons.append(f"上影線過長（{upper_shadow_ratio:.2f}，需 <{THRESHOLD_UPPER_SHADOW_RATIO}）")

    return {
        "price": ticker_price,
        "daily_change_pct": round(daily_change_pct, 4),
        "consecutive_down_days": consec,
        "lower_shadow_ratio": round(lower_shadow_ratio, 4),
        "upper_shadow_ratio": round(upper_shadow_ratio, 4),
        "volume_ratio": round(volume_ratio, 4),
        "suggested_stop_loss": round(stop_loss_ref, 2) if stop_loss_ref else None,
        "all_clear": len(fail_reasons) == 0,
        "fail_reasons": fail_reasons,
    }


def _signal_error(symbol: str, price: float, reason: str) -> dict:
    return {
        "price": price,
        "daily_change_pct": None,
        "consecutive_down_days": None,
        "lower_shadow_ratio": None,
        "upper_shadow_ratio": None,
        "volume_ratio": None,
        "suggested_stop_loss": None,
        "all_clear": False,
        "fail_reasons": [f"資料錯誤：{reason}"],
    }


async def _fetch_signals(exchange: ccxt.okx) -> dict:
    """平行拉取所有標的的 ticker + OHLCV，計算 signal。"""
    async def _one(symbol: str) -> tuple[str, dict]:
        try:
            ticker, ohlcv = await asyncio.gather(
                exchange.fetch_ticker(symbol),
                exchange.fetch_ohlcv(symbol, "1d", limit=OHLCV_LIMIT + 1),
            )
            price = float(ticker.get("last") or ticker.get("close") or 0)
            return symbol, _calc_signal(symbol, price, ohlcv)
        except Exception as e:
            logger.warning(f"[{symbol}] 拉取失敗: {e}")
            return symbol, _signal_error(symbol, 0.0, str(e))

    results = await asyncio.gather(*[_one(s) for s in SYMBOLS])
    return dict(results)



async def _fetch_fear_greed() -> dict:
    """
    拉取 Alternative.me 的 Fear & Greed Index（免費，無需 API Key）。
    回傳格式：{"value": int, "label": str, "timestamp": str}
    失敗時回傳 null 值，不影響主流程。
    """
    try:
        connector = aiohttp.TCPConnector(
            resolver=aiohttp.ThreadedResolver(),
            use_dns_cache=False,
        )
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(
                FEAR_GREED_API,
                timeout=aiohttp.ClientTimeout(total=FEAR_GREED_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json(content_type=None)
                item = data["data"][0]
                value = int(item["value"])
                label = item["value_classification"]
                logger.info(f"Fear & Greed Index: {value} ({label})")
                return {
                    "value": value,
                    "label": label,
                    "note": "0=Extreme Fear, 100=Extreme Greed. <25 = high-quality entry zone",
                }
    except Exception as e:
        logger.warning(f"Fear & Greed Index 拉取失敗（不影響快照）: {e}")
        return {"value": None, "label": None, "note": "fetch failed"}

# ─── Atomic Write ─────────────────────────────────────────────────────────────


def _atomic_write(path: Path, data: dict) -> None:
    """先寫入同目錄 tmp 檔，再原子 rename，避免 Alice 讀到寫入一半的檔案。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    try:
        tmp_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp_path.replace(path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


# ─── 主迴圈 ───────────────────────────────────────────────────────────────────


async def _run_once(exchange: ccxt.okx) -> None:
    """
    執行一次完整的資料拉取 + 寫入。

    失敗行為（符合 Alice 設計的 fallback 邏輯）：
    - API 失敗 → 不寫入，保留磁碟上的舊 JSON
    - 舊 JSON 的 updated_at 超過 10 分鐘 → Alice 自行判斷為過期並跳過
    - 不會寫入空 JSON 或局部資料，避免 Alice 誤判
    """
    try:
        (account, signals), fear_greed = await asyncio.gather(
            asyncio.gather(
                _fetch_account(exchange),
                _fetch_signals(exchange),
            ),
            _fetch_fear_greed(),
        )

        snapshot = {
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "writer_version": WRITER_VERSION,
            "data_source": "okx",
            "CIRCUIT_BREAKER": os.getenv(SNAPSHOT_CIRCUIT_BREAKER_ENV, "RUN").strip().upper() or "RUN",
            "market_context": {
                "fear_greed_index": fear_greed,
            },
            "account": account,
            "signals": signals,
        }

        _atomic_write(OUTPUT_PATH, snapshot)
        fg_val = fear_greed.get("value")
        triggered = [s for s, v in signals.items() if v.get("all_clear")]
        logger.info(
            f"快照已寫入 {OUTPUT_PATH} | "
            f"持倉={len(account['positions'])} | "
            f"掛單={len(account['orders'])} | "
            f"all_clear={triggered} | "
            f"FGI={fg_val}"
        )

    except Exception as e:
        # 刻意不寫入任何內容：保留舊 JSON，讓 Alice 的 updated_at 過期邏輯生效
        logger.error(f"本次快照失敗（舊快照保留）: {e}", exc_info=True)


async def main(once: bool = False) -> None:
    """
    once=True：單次執行後退出（供 Windows Task Scheduler 呼叫，加 --once 參數）。
    once=False：長跑迴圈模式（供 unified_service_manager 管理）。
    """
    mode = "單次模式" if once else f"長跑模式（每 {POLL_INTERVAL_SECONDS}s）"
    logger.info(f"okx_snapshot_writer 啟動 [{mode}]")
    logger.info(f"輸出路徑: {OUTPUT_PATH}")

    exchange = _build_exchange()
    await _patch_exchange_resolver(exchange)
    try:
        await _run_once(exchange)
        if not once:
            # 分段 sleep，讓 SIGTERM 能快速響應
            for _ in range(POLL_INTERVAL_SECONDS):
                if _shutdown:
                    break
                await asyncio.sleep(1)
            while not _shutdown:
                await _run_once(exchange)
                for _ in range(POLL_INTERVAL_SECONDS):
                    if _shutdown:
                        break
                    await asyncio.sleep(1)
    finally:
        await exchange.close()
        logger.info("okx_snapshot_writer 已關閉")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="OKX market snapshot writer for Open Alice")
    parser.add_argument("--once", action="store_true", help="執行一次後退出（供 Task Scheduler 使用）")
    args = parser.parse_args()
    asyncio.run(main(once=args.once))
