# TSA Predictor

A self-hosted tool that forecasts weekly TSA checkpoint passenger volume using historical data and a statistical prediction model.

## What it does

- Collects TSA checkpoint throughput data via Google Apps Script (bypassing direct scraping restrictions)
- Stores historical data in a SQLite database
- Generates weekly passenger volume predictions using day-of-week scaling factors, recency weighting, and anomaly detection
- Serves predictions via a Flask REST API
- Displays actual vs. projected throughput in a React PWA dashboard with rich charting

## Stack

- **Data pipeline:** Google Apps Script → Flask API
- **Backend:** Python, Flask, SQLite
- **Frontend:** React, Vite
- **Hosting:** Self-hosted on Ubuntu VPS, served via Nginx

## Status

Work in progress. Setup instructions coming soon.

## License

MIT — see [LICENSE](LICENSE)
