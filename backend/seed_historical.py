import csv
import sys
from datetime import datetime

from db import init_db, insert_day


def main():
    if len(sys.argv) != 2:
        print("Usage: python seed_historical.py /path/to/file.csv", file=sys.stderr)
        sys.exit(1)

    csv_path = sys.argv[1]
    init_db()

    with open(csv_path, newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            raw_date = (row.get("date") or "").strip()
            raw_passengers = (row.get("passengers") or "").strip()

            if not raw_date or not raw_passengers:
                continue

            parsed_date = datetime.strptime(raw_date, "%m/%d/%Y").date()
            passengers = int(raw_passengers.replace(",", ""))
            insert_day(parsed_date.isoformat(), passengers)


if __name__ == "__main__":
    main()
