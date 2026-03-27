import argparse
import logging
import re
import sys
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup

import db


URL = "https://www.tsa.gov/travel/passenger-volumes"
FALLBACK_URL = "https://r.jina.ai/http://https://www.tsa.gov/travel/passenger-volumes"
CRON_ENTRY = "30 10 * * 2-5 cd /opt/tsa-predictor/backend && python3 scraper.py"
LOG_PATH = Path("/opt/tsa-predictor/backend/scraper.log")
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


def configure_logging():
    logger = logging.getLogger("tsa_scraper")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(formatter)
    logger.addHandler(stdout_handler)

    try:
        file_handler = logging.FileHandler(LOG_PATH)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except OSError as exc:
        logger.warning("Unable to open log file %s: %s", LOG_PATH, exc)

    return logger


def fetch_page(logger):
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Referer": "https://www.google.com/",
        }
    )

    try:
        response = session.get(URL, timeout=30)
        response.raise_for_status()
        logger.info("Fetched TSA passenger volume page directly with status %s", response.status_code)
        return response.text, "html"
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else "unknown"
        logger.warning("Direct fetch failed with status %s, trying fallback mirror", status_code)
    except requests.RequestException as exc:
        logger.warning("Direct fetch failed (%s), trying fallback mirror", exc)

    fallback_response = session.get(
        FALLBACK_URL,
        headers={"Accept": "text/plain;q=1.0,text/markdown;q=0.9,*/*;q=0.1"},
        timeout=30,
    )
    fallback_response.raise_for_status()
    logger.info("Fetched TSA passenger volume page via fallback mirror with status %s", fallback_response.status_code)
    return fallback_response.text, "markdown"


def parse_rows(document, source_format):
    if source_format == "markdown":
        return parse_markdown_rows(document)
    return parse_html_rows(document)


def parse_html_rows(html):
    soup = BeautifulSoup(html, "lxml")
    table = find_data_table(soup)
    rows = []

    for tr in table.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if len(cells) < 2:
            continue

        raw_date = cells[0].get_text(" ", strip=True)
        raw_passengers = cells[1].get_text(" ", strip=True)
        if raw_date.lower() == "date":
            continue

        parsed = normalize_row(raw_date, raw_passengers)
        if parsed is not None:
            rows.append(parsed)

    if not rows:
        raise ValueError("No valid data rows found in TSA passenger volume table")

    return rows


def parse_markdown_rows(markdown_text):
    rows = []
    pattern = re.compile(r"^(\d{1,2}/\d{1,2}/\d{4})\s*\|\s*([\d,]+)\s*$")

    for line in markdown_text.splitlines():
        match = pattern.match(line.strip())
        if not match:
            continue

        parsed = normalize_row(match.group(1), match.group(2))
        if parsed is not None:
            rows.append(parsed)

    if not rows:
        raise ValueError("No valid data rows found in TSA fallback markdown")

    return rows


def find_data_table(soup):
    for table in soup.find_all("table"):
        headers = [th.get_text(" ", strip=True).lower() for th in table.find_all("th")]
        if not headers:
            continue

        has_date = any("date" == header or header.startswith("date ") for header in headers)
        has_passengers = any("passenger" in header for header in headers)
        if has_date and has_passengers:
            return table

    raise ValueError("Unable to locate TSA passenger volume data table")


def normalize_row(raw_date, raw_passengers):
    try:
        date_str = datetime.strptime(raw_date, "%m/%d/%Y").date().isoformat()
        passengers = int(raw_passengers.replace(",", ""))
    except ValueError:
        return None

    return date_str, passengers


def insert_rows(rows, logger):
    inserted = 0
    for date_str, passengers in rows:
        try:
            before_exists = row_exists(date_str)
            db.insert_day(date_str, passengers)
            after_exists = row_exists(date_str)
            if not before_exists and after_exists:
                inserted += 1
        except Exception as exc:
            logger.error("Failed to insert row for %s: %s", date_str, exc)

    return inserted


def row_exists(date_str):
    with db.get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM daily_passengers WHERE date = ?",
            (date_str,),
        ).fetchone()
    return row is not None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--show-cron", action="store_true")
    args = parser.parse_args()

    if args.show_cron:
        print(CRON_ENTRY)
        return 0

    logger = configure_logging()
    db.init_db()

    try:
        document, source_format = fetch_page(logger)
        rows = parse_rows(document, source_format)
    except Exception as exc:
        logger.error("Scraper failed before insert: %s", exc)
        return 1

    inserted = insert_rows(rows, logger)
    logger.info("Processed %s rows, inserted %s new rows", len(rows), inserted)
    logger.info(
        "TSA publishing cadence note: Tuesday through Friday updates, with Tuesday including Saturday through Monday."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
