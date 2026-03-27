import sqlite3
from datetime import date as date_cls
from pathlib import Path


DB_PATH = Path(__file__).resolve().with_name("tsa_data.db")


def get_connection():
    return sqlite3.connect(DB_PATH)


def init_db():
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS daily_passengers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT UNIQUE NOT NULL,
                passengers INTEGER NOT NULL,
                day_of_week INTEGER NOT NULL,
                week_number INTEGER NOT NULL,
                year INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )


def insert_day(date_str, passengers):
    parsed_date = date_cls.fromisoformat(date_str)
    iso_year, iso_week, iso_day = parsed_date.isocalendar()

    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO daily_passengers (
                date, passengers, day_of_week, week_number, year
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (date_str, int(passengers), iso_day, iso_week, iso_year),
        )


def get_all_weeks():
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT year, week_number, day_of_week, passengers
            FROM daily_passengers
            ORDER BY year, week_number, day_of_week
            """
        ).fetchall()

    weeks = {}
    for row in rows:
        key = (row["year"], row["week_number"])
        entry = weeks.setdefault(
            key,
            {
                "y": row["year"],
                "w": row["week_number"],
                "d": {},
                "_sum": 0,
                "c": 0,
            },
        )
        entry["d"][str(row["day_of_week"])] = row["passengers"]
        entry["_sum"] += row["passengers"]
        entry["c"] += 1

    results = []
    for key in sorted(weeks):
        entry = weeks[key]
        count = entry["c"]
        results.append(
            {
                "y": entry["y"],
                "w": entry["w"],
                "d": entry["d"],
                "a": int(round(entry["_sum"] / count)) if count else 0,
                "c": count,
            }
        )

    return results


if __name__ == "__main__":
    init_db()
