import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { computeBacktest, getWeekAwareness, predict, probabilityAbove } from "./model";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const KALSHI_BANKROLL = 100;
const KALSHI_K_FACTOR = 0.25;
const YEAR_COLORS = {
  2019: "#7dd3fc",
  2022: "#a78bfa",
  2023: "#f472b6",
  2024: "#34d399",
  2025: "#f59e0b",
  2026: "#60a5fa",
};

export default function App() {
  const [weeks, setWeeks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [simDay, setSimDay] = useState(4);
  const [kalshiMarkets, setKalshiMarkets] = useState([]);
  const [kalshiError, setKalshiError] = useState("");

  useEffect(() => {
    let active = true;

    fetch("/api/weeks")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (!active) {
          return;
        }
        setWeeks(data);
        const awareness = getWeekAwareness(data);
        setSelectedKey(`${awareness.currentWeek.year}-${awareness.currentWeek.week}`);
        setSimDay(Math.max(1, awareness.daysAvailable || 4));
      })
      .catch((err) => {
        if (active) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    fetch("/api/kalshi-markets")
      .then(async (response) => {
        if (response.status === 404) {
          return [];
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (!active) {
          return;
        }
        setKalshiMarkets(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (active) {
          setKalshiError(String(err));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const awareness = useMemo(() => (weeks.length ? getWeekAwareness(weeks) : null), [weeks]);
  const syntheticCurrentWeek = useMemo(() => {
    if (!awareness) {
      return null;
    }

    const exists = weeks.some(
      (week) => week.y === awareness.currentWeek.year && week.w === awareness.currentWeek.week,
    );
    if (exists) {
      return null;
    }

    return {
      y: awareness.currentWeek.year,
      w: awareness.currentWeek.week,
      d: {},
      c: 0,
      a: null,
    };
  }, [weeks, awareness]);

  const displayWeeks = useMemo(
    () => (syntheticCurrentWeek ? [...weeks, syntheticCurrentWeek] : weeks),
    [weeks, syntheticCurrentWeek],
  );
  const sortedWeeks = useMemo(() => [...displayWeeks].sort(compareWeeksDesc), [displayWeeks]);
  const selectedWeek = useMemo(() => {
    return displayWeeks.find((week) => `${week.y}-${week.w}` === selectedKey) || null;
  }, [displayWeeks, selectedKey]);

  const activeTarget = selectedWeek || null;
  const autoMode =
    awareness && activeTarget
      ? activeTarget.y === awareness.currentWeek.year && activeTarget.w === awareness.currentWeek.week
      : true;
  const throughDay = autoMode && awareness ? Math.max(1, awareness.daysAvailable || 1) : simDay;

  const prediction = useMemo(() => {
    if (!activeTarget) {
      return null;
    }
    return predict(weeks, activeTarget.y, activeTarget.w, throughDay);
  }, [weeks, activeTarget, throughDay]);

  const funnelData = useMemo(() => {
    if (!activeTarget) {
      return [];
    }

    const points = [];
    for (let day = 1; day <= 4; day += 1) {
      const result = predict(weeks, activeTarget.y, activeTarget.w, day);
      points.push({
        label: `+${DAY_LABELS[day - 1]}`,
        median: toMillions(result.p50),
        low90: toMillions(result.p5),
        high90: toMillions(result.p95),
        low50: toMillions(result.p25),
        high50: toMillions(result.p75),
        actual: toMillions(result.actual),
      });
    }
    return points;
  }, [weeks, activeTarget]);

  const yoyOverlayData = useMemo(() => {
    if (!activeTarget) {
      return [];
    }

    const years = Array.from(new Set(weeks.map((week) => week.y)))
      .filter((year) => year !== 2020 && year !== 2021)
      .sort((a, b) => a - b);

    return DAY_LABELS.map((label, index) => {
      const day = index + 1;
      const row = { day: label };
      for (const year of years) {
        const week = weeks.find((entry) => entry.y === year && entry.w === activeTarget.w);
        row[year] = week && week.d ? Number(week.d[String(day)] || null) : null;
      }
      return row;
    });
  }, [weeks, activeTarget]);

  const backtest = useMemo(() => {
    if (!activeTarget) {
      return [];
    }
    return computeBacktest(weeks, activeTarget.y, activeTarget.w, 8)
      .slice()
      .reverse()
      .map((entry, index) => {
        const pctError = entry.actual ? Math.abs(entry.error) / entry.actual : 0;
        return {
          name: `W${entry.week}`,
          predicted: toMillions(entry.predicted),
          actual: toMillions(entry.actual),
          low90: toMillions(predict(weeks, entry.year, entry.week, 4).p5),
          high90: toMillions(predict(weeks, entry.year, entry.week, 4).p95),
          errorPct: pctError * 100,
          color: pctError < 0.03 ? "#34d399" : pctError < 0.05 ? "#fbbf24" : "#f97316",
          idx: index,
        };
      });
  }, [weeks, activeTarget]);

  const yoyTrendData = useMemo(() => {
    const fullWeeks = [...weeks]
      .filter((week) => week.c === 7)
      .filter((week) => week.y !== 2020 && week.y !== 2021)
      .sort(compareWeeksAsc);

    const lastTwelve = fullWeeks.slice(-12);
    return lastTwelve.map((week, index, source) => {
      const lastYear = weeks.find((entry) => entry.y === week.y - 1 && entry.w === week.w) || weeks.find((entry) => entry.y === 2019 && entry.w === week.w);
      const yoy = lastYear ? ((week.a - lastYear.a) / lastYear.a) * 100 : null;
      const rollingWindow = source
        .slice(Math.max(0, index - 3), index + 1)
        .map((item) => {
          const base =
            weeks.find((entry) => entry.y === item.y - 1 && entry.w === item.w) ||
            weeks.find((entry) => entry.y === 2019 && entry.w === item.w);
          return base ? ((item.a - base.a) / base.a) * 100 : null;
        })
        .filter((value) => value != null);

      return {
        label: `${week.y}-W${week.w}`,
        yoy,
        rolling: rollingWindow.length
          ? rollingWindow.reduce((sum, value) => sum + value, 0) / rollingWindow.length
          : null,
      };
    });
  }, [weeks]);

  const confidenceScore = useMemo(() => {
    if (!prediction || prediction.p5 == null || prediction.p95 == null || prediction.p50 == null) {
      return 0;
    }
    const spread = (prediction.p95 - prediction.p5) / prediction.p50;
    return Math.max(0, Math.min(1, 1 - spread));
  }, [prediction]);

  const kalshiCards = useMemo(() => {
    if (!prediction || !activeTarget || !kalshiMarkets.length) {
      return [];
    }

    return kalshiMarkets
      .map((market) => normalizeKalshiMarket(market, activeTarget))
      .filter(Boolean)
      .map((market) => {
        const modelProbability = probabilityAbove(prediction, market.threshold);
        if (modelProbability == null) {
          return null;
        }

        const edge = modelProbability - market.impliedProbability;
        const recommendedSide = edge >= 0 ? "YES" : "NO";
        const contractPrice = recommendedSide === "YES" ? market.yesPrice : 1 - market.yesPrice;
        const winProbability = recommendedSide === "YES" ? modelProbability : 1 - modelProbability;
        const expectedValue = winProbability * (1 - contractPrice) - (1 - winProbability) * contractPrice;
        const recommendedStake = Math.abs(edge) * KALSHI_BANKROLL * KALSHI_K_FACTOR;
        const opportunityScore = Math.round(Math.abs(edge) * 100);

        return {
          ...market,
          modelProbability,
          edge,
          recommendedSide,
          contractPrice,
          expectedValue,
          recommendedStake,
          opportunityScore,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      .slice(0, 4);
  }, [kalshiMarkets, prediction, activeTarget]);

  if (loading) {
    return <Shell><div className="empty-state">Loading TSA forecast...</div></Shell>;
  }

  if (error) {
    return <Shell><div className="empty-state">Failed to load dashboard: {error}</div></Shell>;
  }

  if (!awareness || !activeTarget || !prediction) {
    return <Shell><div className="empty-state">No TSA data available.</div></Shell>;
  }

  const lastKnownDate = latestKnownDate(activeTarget);
  const noCurrentWeekInput = prediction.nDays === 0;
  const latestPublishedDate = latestAvailableDate(displayWeeks);

  return (
    <Shell>
      <header className="status-card card">
        <div>
          <p className="eyebrow">TSA Forecast</p>
          <h1>Week {activeTarget.w}, {activeTarget.y}</h1>
          <p className="status-copy">
            {formatLongDate(new Date())} · Predicting ISO week {activeTarget.w}
          </p>
        </div>
        <button className="gear-button" onClick={() => setShowSettings((open) => !open)} aria-label="Open settings">
          ⚙
        </button>
        <div className="status-meta">
          <span>Last updated: {lastKnownDate || latestPublishedDate || "Unknown"}</span>
          <span>Next update: {formatNextUpdate(awareness.nextUpdateTime)}</span>
        </div>
      </header>

      {showSettings && (
        <section className="card settings-panel">
          <label>
            Historical week replay
            <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              {sortedWeeks.map((week) => (
                <option key={`${week.y}-${week.w}`} value={`${week.y}-${week.w}`}>
                  {week.y} · Week {week.w}
                </option>
              ))}
            </select>
          </label>
          <label>
            Simulate through day: <strong>{throughDay}</strong>
            <input
              type="range"
              min="1"
              max="7"
              value={simDay}
              onChange={(event) => setSimDay(Number(event.target.value))}
            />
          </label>
          <p className="settings-note">
            Auto-awareness uses the current week and Eastern publish schedule. Selecting another week
            switches to replay mode.
          </p>
        </section>
      )}

      <section className="card hero-card">
        <div className="hero-top">
          <div>
            <p className="eyebrow">Median Weekly Daily Average</p>
            <div className="hero-number">{formatMillions(prediction.p50)}</div>
            {noCurrentWeekInput && (
              <p className="hero-note">No current-week TSA inputs yet. Forecast is running on prior-week trend only.</p>
            )}
          </div>
          <div className="confidence-meter">
            <div className="meter-track">
              <div
                className="meter-fill"
                style={{
                  width: `${confidenceScore * 100}%`,
                  background: confidenceScore > 0.65 ? "#34d399" : confidenceScore > 0.4 ? "#fbbf24" : "#fb923c",
                }}
              />
            </div>
            <span>Confidence {Math.round(confidenceScore * 100)}%</span>
          </div>
        </div>
        <div className="hero-grid">
          <Metric label="90% CI" value={`${formatMillions(prediction.p5)} - ${formatMillions(prediction.p95)}`} />
          <Metric label="50% CI" value={`${formatMillions(prediction.p25)} - ${formatMillions(prediction.p75)}`} />
          <Metric label="Last Year" value={formatMillions(prediction.lastYearAvg)} />
          <Metric label="YoY Trend" value={formatPercent(prediction.yoyTrend)} />
        </div>
      </section>

      {(kalshiCards.length > 0 || kalshiError) && (
        <section className="card market-card">
          <div className="section-head">
            <h2>Market Overlay</h2>
            <span>
              Comparing the model to optional Kalshi-style threshold markets for Week {activeTarget.w}
            </span>
          </div>
          {kalshiCards.length > 0 ? (
            <div className="market-grid">
              {kalshiCards.map((market) => (
                <div key={market.id} className={`market-tile ${market.edge > 0 ? "positive" : "negative"}`}>
                  <div className="market-row">
                    <strong>{market.label}</strong>
                    <span>{market.recommendedSide} at {formatContractPrice(market.contractPrice)}</span>
                  </div>
                  <div className="market-row market-meta">
                    <span>Model {formatProbability(market.modelProbability)}</span>
                    <span>Market {formatProbability(market.impliedProbability)}</span>
                  </div>
                  <div className="market-row market-meta">
                    <span>{market.recommendedSide} edge {formatSignedProbability(Math.abs(market.edge))}</span>
                    <span>Stake ${market.recommendedStake.toFixed(2)}</span>
                  </div>
                  <div className="market-row market-meta">
                    <span>Opportunity score {market.opportunityScore}/100</span>
                  </div>
                  <p className="market-note">
                    Bet {market.recommendedSide}. Expected value: {formatSignedPercent(market.expectedValue)} per $1 contract.
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-note">Market data is unavailable right now.</p>
          )}
          {kalshiError && <p className="settings-note">Market feed error: {kalshiError}</p>}
        </section>
      )}

      <section className="card day-strip">
        {DAY_LABELS.map((label, index) => {
          const day = index + 1;
          const value = activeTarget.d[String(day)];
          const known = value != null;
          const glowing = !known && day === throughDay + 1 && throughDay < 7;
          return (
            <div key={label} className={`day-tile ${known ? "known" : ""} ${glowing ? "glow" : ""}`}>
              <span>{label}</span>
              <strong>{known ? formatPassengers(value) : "?"}</strong>
            </div>
          );
        })}
      </section>

      <section className="card chart-card">
        <div className="section-head">
          <h2>Narrowing Funnel</h2>
          <span>Prediction band as data arrives</span>
        </div>
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={funnelData}>
              <CartesianGrid stroke="#17304f" vertical={false} />
              <XAxis dataKey="label" stroke="#7c93b8" />
              <YAxis stroke="#7c93b8" tickFormatter={formatAxisMillions} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatMillionsFromRaw(value)} />
              <Area type="monotone" dataKey="high90" stroke="transparent" fill="#60a5fa1a" />
              <Area type="monotone" dataKey="low90" stroke="transparent" fill="#060a14" />
              <Area type="monotone" dataKey="high50" stroke="transparent" fill="#60a5fa33" />
              <Area type="monotone" dataKey="low50" stroke="transparent" fill="#060a14" />
              <Line type="monotone" dataKey="median" stroke="#60a5fa" strokeWidth={3} dot={{ r: 3 }} />
              {prediction.actual != null && (
                <ReferenceLine y={toMillions(prediction.actual)} stroke="#fbbf24" strokeDasharray="5 5" />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      </section>

      <section className="card chart-card">
        <div className="section-head">
          <h2>Year-over-Year Overlay</h2>
          <span>Same week shape across years</span>
        </div>
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={yoyOverlayData}>
              <CartesianGrid stroke="#17304f" vertical={false} />
              <XAxis dataKey="day" stroke="#7c93b8" />
              <YAxis stroke="#7c93b8" tickFormatter={formatAxisPassengers} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatPassengers(value)} />
              <Legend verticalAlign="bottom" wrapperStyle={{ color: "#9bb2d6" }} />
              {Object.keys(YEAR_COLORS).map((year) => (
                <Line
                  key={year}
                  type="monotone"
                  dataKey={year}
                  stroke={YEAR_COLORS[year]}
                  strokeWidth={Number(year) === activeTarget.y ? 4 : 2}
                  strokeOpacity={Number(year) === activeTarget.y ? 1 : 0.35}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      </section>

      <section className="card chart-card">
        <div className="section-head">
          <h2>Recent Backtest</h2>
          <span>Thursday forecast versus actual</span>
        </div>
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={backtest}>
              <CartesianGrid stroke="#17304f" vertical={false} />
              <XAxis dataKey="name" stroke="#7c93b8" />
              <YAxis stroke="#7c93b8" tickFormatter={formatAxisMillions} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatMillionsFromRaw(value)} />
              <Area type="monotone" dataKey="high90" stroke="transparent" fill="#60a5fa1f" />
              <Area type="monotone" dataKey="low90" stroke="transparent" fill="#060a14" />
              <Line type="monotone" dataKey="predicted" stroke="#60a5fa" strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="actual" stroke="#fbbf24" strokeWidth={2} dot={{ r: 4 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
        <ChartFrame compact>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={backtest}>
              <CartesianGrid stroke="#17304f" vertical={false} />
              <XAxis dataKey="name" stroke="#7c93b8" />
              <YAxis stroke="#7c93b8" tickFormatter={(value) => `${value.toFixed(0)}%`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => `${Number(value).toFixed(2)}%`} />
              <Bar dataKey="errorPct" fill="#60a5fa">
                {backtest.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      </section>

      <section className="card chart-card">
        <div className="section-head">
          <h2>YoY Trend</h2>
          <span>Last 12 weeks with rolling average</span>
        </div>
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={yoyTrendData}>
              <CartesianGrid stroke="#17304f" vertical={false} />
              <XAxis dataKey="label" stroke="#7c93b8" hide />
              <YAxis stroke="#7c93b8" tickFormatter={(value) => `${value.toFixed(0)}%`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => `${Number(value).toFixed(2)}%`} />
              <ReferenceLine y={0} stroke="#7c93b8" strokeDasharray="4 4" />
              <Bar dataKey="yoy" fill="#60a5fa" radius={[6, 6, 0, 0]} />
              <Line type="monotone" dataKey="rolling" stroke="#fbbf24" strokeWidth={3} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      </section>
    </Shell>
  );
}

function Shell({ children }) {
  return <main className="app-shell">{children}</main>;
}

function ChartFrame({ children, compact = false }) {
  return <div className={`chart-frame ${compact ? "compact" : ""}`}>{children}</div>;
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function compareWeeksAsc(a, b) {
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  return a.w - b.w;
}

function compareWeeksDesc(a, b) {
  if (a.y !== b.y) {
    return b.y - a.y;
  }
  return b.w - a.w;
}

function latestKnownDate(week) {
  if (!week || !week.d) {
    return "";
  }

  const knownDays = Object.keys(week.d).map(Number).sort((a, b) => a - b);
  if (!knownDays.length) {
    return "";
  }

  const monday = isoWeekToDate(week.y, week.w, 1);
  monday.setUTCDate(monday.getUTCDate() + knownDays[knownDays.length - 1] - 1);
  return monday.toISOString().slice(0, 10);
}

function latestAvailableDate(weeks) {
  return weeks
    .map((week) => latestKnownDate(week))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function isoWeekToDate(year, week, day) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  if (dow <= 4) {
    simple.setUTCDate(simple.getUTCDate() - dow + 1);
  } else {
    simple.setUTCDate(simple.getUTCDate() + 8 - dow);
  }
  simple.setUTCDate(simple.getUTCDate() + day - 1);
  return simple;
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatPassengers(value) {
  if (value == null) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US").format(Math.round(Number(value)));
}

function toMillions(value) {
  return value == null ? null : Number(value) / 1000000;
}

function formatMillions(value) {
  if (value == null) {
    return "n/a";
  }
  return `${(Number(value) / 1000000).toFixed(2)}M`;
}

function formatMillionsFromRaw(value) {
  return value == null ? "n/a" : `${Number(value).toFixed(2)}M`;
}

function formatAxisMillions(value) {
  return `${Number(value).toFixed(2)}M`;
}

function formatAxisPassengers(value) {
  return `${(Number(value) / 1000000).toFixed(1)}M`;
}

function formatPercent(value) {
  if (value == null) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatNextUpdate(value) {
  if (!value) {
    return "Unknown";
  }
  const [day] = value.split("T");
  return `${day} ~10am EST`;
}

function normalizeKalshiMarket(market, activeTarget) {
  if (!market || !activeTarget) {
    return null;
  }

  const marketWeek = market.week ?? market.week_number ?? market.target_week;
  const marketYear = market.year ?? market.target_year;
  if (
    Number.isFinite(Number(marketWeek)) &&
    Number.isFinite(Number(marketYear)) &&
    (Number(marketWeek) !== activeTarget.w || Number(marketYear) !== activeTarget.y)
  ) {
    return null;
  }

  const thresholdSource =
    market.threshold ??
    market.threshold_passengers ??
    market.strike ??
    market.cutoff ??
    market.line;
  const threshold = Number(thresholdSource);
  const yesPrice = normalizeContractPrice(market.yes_price ?? market.yesPrice ?? market.probability ?? market.price);

  if (!Number.isFinite(threshold) || !Number.isFinite(yesPrice)) {
    return null;
  }

  return {
    id: String(market.ticker ?? market.id ?? `${activeTarget.y}-${activeTarget.w}-${threshold}`),
    label: market.label ?? `Above ${formatMillions(threshold)} passengers`,
    threshold,
    yesPrice,
    impliedProbability: yesPrice,
  };
}

function normalizeContractPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric > 1) {
    return numeric / 100;
  }
  return numeric;
}

function formatProbability(value) {
  if (value == null) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedProbability(value) {
  if (value == null) {
    return "n/a";
  }
  const pct = (value * 100).toFixed(1);
  return `${value > 0 ? "+" : ""}${pct} pts`;
}

function formatSignedPercent(value) {
  if (value == null) {
    return "n/a";
  }
  const pct = (value * 100).toFixed(1);
  return `${value > 0 ? "+" : ""}${pct}%`;
}

function formatContractPrice(value) {
  if (value == null) {
    return "n/a";
  }
  return `${Math.round(value * 100)}c`;
}

const tooltipStyle = {
  background: "#08111f",
  border: "1px solid #1e3a5f",
  borderRadius: "14px",
  color: "#d9e7ff",
};
