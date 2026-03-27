import argparse
import datetime as dt
import logging
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS
import requests

import db


APP_DIR = Path("/opt/tsa-predictor/backend")
KALSHI_MARKETS_URL = "https://api.elections.kalshi.com/trade-api/v2/markets"
TOKEN_PATHS = [
    APP_DIR / ".token",
    Path("/opt/tsapredictor/backend/.token"),
]
SERVICE_UNIT = """[Unit]
Description=TSA Predictor API
After=network.target

[Service]
WorkingDirectory=/opt/tsa-predictor/backend
Environment=INGEST_TOKEN=your_token_here
ExecStart=/opt/tsa-predictor/backend/.venv/bin/python /opt/tsa-predictor/backend/api.py
Restart=always
User=joeclaw

[Install]
WantedBy=multi-user.target
"""
HELP_EPILOG = """To set the ingestion token:
1. Generate a token: python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
2. Save it: echo 'YOUR_TOKEN' > /opt/tsa-predictor/backend/.token
3. Also set it in your Google Apps Script properties as INGEST_TOKEN
4. They must match exactly.

Timing note:
- TSA publishes data Monday-Friday by 9am EST.
- Monday's publication contains Fri+Sat+Sun and closes the previous week.
- Tuesday's publication contains Monday and is the first current-week point.
- Wednesday publishes Tuesday's number.
- Thursday publishes Wednesday's number.
- Friday publishes Thursday's number.
"""


app = Flask(__name__)
CORS(app)


def configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )


def load_ingest_token():
    env_token = os.environ.get("INGEST_TOKEN", "").strip()
    if env_token:
        return env_token

    for path in TOKEN_PATHS:
        try:
            token = path.read_text(encoding="utf-8").splitlines()[0].strip()
        except (FileNotFoundError, IndexError, OSError):
            continue
        if token:
            return token

    return None


def row_exists(date_str):
    with db.get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM daily_passengers WHERE date = ?",
            (date_str,),
        ).fetchone()
    return row is not None


def get_status_payload():
    with db.get_connection() as conn:
        totals = conn.execute(
            """
            SELECT
                MAX(date) AS last_update,
                COUNT(*) AS total_days,
                COUNT(DISTINCT printf('%04d-%02d', year, week_number)) AS total_weeks
            FROM daily_passengers
            """
        ).fetchone()

        current_week = conn.execute(
            """
            SELECT year, week_number, COUNT(*) AS days_available
            FROM daily_passengers
            GROUP BY year, week_number
            ORDER BY year DESC, week_number DESC
            LIMIT 1
            """
        ).fetchone()

    current_week_payload = None
    if current_week is not None:
        current_week_payload = {
            "year": current_week[0],
            "week_number": current_week[1],
            "days_available": current_week[2],
        }

    return {
        "last_update": totals[0],
        "total_days": totals[1],
        "total_weeks": totals[2],
        "current_week": current_week_payload,
    }


@app.get("/api/weeks")
def weeks():
    response = jsonify(db.get_all_weeks())
    response.headers["Cache-Control"] = "max-age=1800"
    return response


@app.get("/api/status")
def status():
    return jsonify(get_status_payload())


@app.get("/api/kalshi-markets")
def kalshi_markets():
    try:
        return jsonify(fetch_kalshi_markets())
    except Exception as exc:
        logging.warning("kalshi market fetch failed: %s", exc)
        return jsonify({"error": "market feed unavailable"}), 502


@app.get("/api/kalshi/markets")
def kalshi_markets_proxy():
    series_ticker = str(request.args.get("series_ticker", "KXTSAW")).strip() or "KXTSAW"
    event_ticker = str(request.args.get("event_ticker", "")).strip()

    params = {
        "series_ticker": series_ticker,
        "status": "open",
        "limit": 200,
    }
    if event_ticker:
        params["event_ticker"] = event_ticker

    try:
        response = requests.get(
            KALSHI_MARKETS_URL,
            params=params,
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        logging.exception("Kalshi markets fetch failed")
        return jsonify({"error": f"Kalshi fetch failed: {exc}"}), 502

    payload = response.json()
    proxied = jsonify(payload)
    proxied.headers["Cache-Control"] = "max-age=60"
    return proxied


@app.post("/api/ingest")
def ingest():
    configured_token = load_ingest_token()
    if not configured_token:
        return jsonify({"error": "ingestion disabled"}), 503

    payload = request.get_json(silent=True) or {}
    request_token = str(payload.get("token", "")).strip()
    if request_token != configured_token:
        return jsonify({"error": "unauthorized"}), 401

    rows = payload.get("rows")
    if not isinstance(rows, list):
        return jsonify({"error": "rows must be a list"}), 400

    inserted = 0
    skipped = 0
    errors = []

    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append(f"row {index}: expected object")
            continue

        date_str = str(row.get("date", "")).strip()
        passengers = row.get("passengers")

        if not date_str or passengers in (None, ""):
            errors.append(f"row {index}: missing date or passengers")
            continue

        try:
            passengers = int(passengers)
            existed_before = row_exists(date_str)
            db.insert_day(date_str, passengers)
            existed_after = row_exists(date_str)
        except Exception as exc:
            errors.append(f"row {index}: {exc}")
            continue

        if not existed_before and existed_after:
            inserted += 1
        else:
            skipped += 1

    logging.info(
        "Ingest attempt ip=%s rows_received=%s inserted=%s skipped=%s errors=%s",
        request.headers.get("X-Forwarded-For", request.remote_addr),
        len(rows),
        inserted,
        skipped,
        len(errors),
    )
    return jsonify({"inserted": inserted, "skipped": skipped, "errors": errors})


@app.get("/api/health")
def health():
    with db.get_connection() as conn:
        row = conn.execute("SELECT COUNT(*) FROM daily_passengers").fetchone()
    return jsonify({"status": "ok", "db_rows": row[0]})


def build_parser():
    return argparse.ArgumentParser(
        description="TSA Predictor API server",
        epilog=HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )


def fetch_kalshi_markets():
    response = requests.get(
        KALSHI_MARKETS_URL,
        params={"series_ticker": "KXTSAW", "status": "open", "limit": 200},
        timeout=20,
    )
    response.raise_for_status()

    data = response.json()
    results = []

    for market in data.get("markets", []):
        threshold = parse_int(market.get("floor_strike"))
        yes_bid = parse_decimal(market.get("yes_bid_dollars"))
        yes_ask = parse_decimal(market.get("yes_ask_dollars"))
        yes_price = midpoint_price(yes_bid, yes_ask)
        market_year, market_week = parse_market_week(market.get("event_ticker"))

        if threshold is None or yes_price is None:
            continue

        results.append(
            {
                "id": market.get("ticker"),
                "ticker": market.get("ticker"),
                "title": market.get("title"),
                "subtitle": market.get("subtitle"),
                "threshold_passengers": threshold,
                "yes_price": yes_price,
                "year": market_year,
                "week": market_week,
            }
        )

    return results


def parse_decimal(value):
    if value in (None, ""):
        return None

    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def parse_int(value):
    decimal_value = parse_decimal(value)
    if decimal_value is None:
        return None
    return int(decimal_value)


def midpoint_price(yes_bid, yes_ask):
    if yes_bid is not None and yes_ask is not None and 0 <= yes_bid <= 1 and 0 <= yes_ask <= 1:
        return (yes_bid + yes_ask) / 2
    if yes_ask is not None:
        return yes_ask
    return yes_bid


def parse_market_week(event_ticker):
    if not event_ticker or "-" not in event_ticker:
        return None, None

    try:
        market_date = dt.datetime.strptime(event_ticker.rsplit("-", 1)[-1], "%y%b%d").date()
    except ValueError:
        return None, None

    iso = market_date.isocalendar()
    return iso.year, iso.week


def main():
    parser = build_parser()
    parser.add_argument("--show-service", action="store_true")
    args = parser.parse_args()

    if args.show_service:
        print(SERVICE_UNIT, end="")
        return 0

    configure_logging()
    db.init_db()
    app.run(host="127.0.0.1", port=5050)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
