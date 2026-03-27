const PERCENTILES = [5, 10, 25, 50, 75, 90, 95];
const EASTERN_TIME_ZONE = "America/New_York";
const PUBLISH_HOUR = 10;

export function predict(allWeeks, targetYear, targetWeek, throughDay) {
  const weekMap = buildWeekMap(allWeeks);
  const target = weekMap.get(weekKey(targetYear, targetWeek)) || {
    y: targetYear,
    w: targetWeek,
    d: {},
    c: 0,
    a: null,
  };
  const knownDays = getKnownDayValues(target, throughDay);
  const partialAvg = average(knownDays);
  const nDays = knownDays.length;
  const actual = target && target.c === 7 ? target.a : null;
  const lastYearAvg = getComparableWeekAverage(weekMap, targetYear - 1, targetWeek);
  const prior = computePrior(weekMap, targetYear, targetWeek);
  const yoyTrend = prior && lastYearAvg ? prior / lastYearAvg - 1 : null;
  const priorWeight = Math.max(0.05, 0.5 - nDays * 0.12);

  if (!partialAvg || !nDays) {
    const priorOnlyResult = buildPriorOnlyPrediction(allWeeks, weekMap, targetYear, targetWeek, prior);
    return buildPredictionResult(priorOnlyResult, partialAvg, nDays, prior, yoyTrend, priorWeight, actual, lastYearAvg);
  }

  const factors = [];
  for (const week of allWeeks) {
    if (!week || week.c !== 7) {
      continue;
    }

    if (!isBeforeWeek(week.y, week.w, targetYear, targetWeek)) {
      continue;
    }

    const partial = average(getKnownDayValues(week, throughDay));
    if (!partial) {
      continue;
    }

    const factor = week.a / partial;
    const distance = weeksBetween(week.y, week.w, targetYear, targetWeek);
    const weight = Math.exp(-distance / 52);
    if (Number.isFinite(factor) && Number.isFinite(weight) && weight > 0) {
      factors.push({ value: factor, weight });
    }
  }

  if (!factors.length) {
    return buildPredictionResult(null, partialAvg, nDays, prior, yoyTrend, priorWeight, actual, lastYearAvg);
  }

  const weightedSamples = factors
    .map(({ value, weight }) => ({
      value: blendWithPrior(partialAvg * value, prior, priorWeight),
      weight,
    }))
    .filter((sample) => Number.isFinite(sample.value) && Number.isFinite(sample.weight) && sample.weight > 0);

  return buildPredictionResult(
    buildPredictionCoreFromSamples(weightedSamples),
    partialAvg,
    nDays,
    prior,
    yoyTrend,
    priorWeight,
    actual,
    lastYearAvg,
  );
}

export function getWeekAwareness(allWeeks) {
  const now = new Date();
  const easternParts = getEasternParts(now);
  const today = easternDateToUtcDate(easternParts.year, easternParts.month, easternParts.day);
  const currentWeek = getIsoWeekInfo(today);
  const publishDayIndex = publishingDayIndex(easternParts.weekday);
  const afterPublish = easternParts.hour >= PUBLISH_HOUR;

  let daysAvailable;
  if (publishDayIndex === null) {
    daysAvailable = easternParts.weekday === 0 ? 4 : 4;
  } else if (publishDayIndex === 0) {
    daysAvailable = 0;
  } else {
    daysAvailable = afterPublish ? publishDayIndex : publishDayIndex - 1;
  }
  daysAvailable = Math.max(0, Math.min(4, daysAvailable));

  const lastCompletedWeek = getLastCompletedWeek(allWeeks);
  const nextUpdateTime = computeNextUpdateTime(easternParts);

  return {
    currentWeek: { year: currentWeek.year, week: currentWeek.week },
    daysAvailable,
    lastCompletedWeek,
    nextUpdateTime,
  };
}

export function computeBacktest(allWeeks, year, week, nWeeksBack) {
  const results = [];

  for (let offset = 1; offset <= nWeeksBack; offset += 1) {
    const target = shiftWeek(year, week, -offset);
    const weekEntry = allWeeks.find((entry) => entry.y === target.year && entry.w === target.week);
    if (!weekEntry || weekEntry.c !== 7) {
      continue;
    }

    const forecast = predict(allWeeks, target.year, target.week, 4);
    if (forecast.p50 == null || forecast.actual == null) {
      continue;
    }

    const predicted = forecast.p50;
    const actual = forecast.actual;
    const error = actual - predicted;
    results.push({
      week: target.week,
      year: target.year,
      predicted,
      actual,
      error,
      inCI90:
        forecast.p5 != null &&
        forecast.p95 != null &&
        actual >= forecast.p5 &&
        actual <= forecast.p95,
    });
  }

  return results;
}

export function weightedPercentile(valuesAndWeights, percentile) {
  if (!Array.isArray(valuesAndWeights) || !valuesAndWeights.length) {
    return null;
  }

  const sorted = valuesAndWeights
    .filter((item) => item && Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => a.value - b.value);

  if (!sorted.length) {
    return null;
  }

  const clamped = Math.max(0, Math.min(1, percentile));
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const threshold = totalWeight * clamped;
  let cumulative = 0;

  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= threshold) {
      return item.value;
    }
  }

  return sorted[sorted.length - 1].value;
}

export function probabilityAbove(prediction, threshold) {
  const samples = prediction?.distribution?.samples;
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(threshold)) {
    return null;
  }

  let totalWeight = 0;
  let aboveWeight = 0;
  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.value) || !Number.isFinite(sample.weight) || sample.weight <= 0) {
      continue;
    }
    totalWeight += sample.weight;
    if (sample.value > threshold) {
      aboveWeight += sample.weight;
    }
  }

  if (!totalWeight) {
    return null;
  }

  return aboveWeight / totalWeight;
}

function buildPredictionResult(core, partialAvg, nDays, prior, yoyTrend, priorWeight, actual, lastYearAvg) {
  const base = {
    p5: null,
    p10: null,
    p25: null,
    p50: null,
    p75: null,
    p90: null,
    p95: null,
    partialAvg,
    nDays,
    prior,
    yoyTrend,
    priorWeight,
    actual,
    lastYearAvg,
    distribution: null,
  };

  return core ? { ...base, ...core } : base;
}

function buildPriorOnlyPrediction(allWeeks, weekMap, targetYear, targetWeek, prior) {
  if (prior == null) {
    return null;
  }

  const factors = [];
  for (const week of allWeeks) {
    if (!week || week.c !== 7) {
      continue;
    }

    if (!isBeforeWeek(week.y, week.w, targetYear, targetWeek)) {
      continue;
    }

    const historicalPrior = computePrior(weekMap, week.y, week.w);
    if (!historicalPrior) {
      continue;
    }

    const factor = week.a / historicalPrior;
    const distance = weeksBetween(week.y, week.w, targetYear, targetWeek);
    const weight = Math.exp(-distance / 52);
    if (Number.isFinite(factor) && Number.isFinite(weight) && weight > 0) {
      factors.push({ value: factor, weight });
    }
  }

  if (!factors.length) {
    return buildPredictionCoreFromSamples([{ value: prior, weight: 1 }]);
  }

  const weightedSamples = factors
    .map(({ value, weight }) => ({
      value: prior * value,
      weight,
    }))
    .filter((sample) => Number.isFinite(sample.value) && Number.isFinite(sample.weight) && sample.weight > 0);

  return buildPredictionCoreFromSamples(weightedSamples);
}

function buildPredictionCoreFromSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) {
    return null;
  }

  const result = { distribution: buildDistribution(samples) };
  for (const percentile of PERCENTILES) {
    result[`p${percentile}`] = weightedPercentile(samples, percentile / 100);
  }
  result.mean = result.distribution.mean;
  result.stddev = result.distribution.stddev;
  return result;
}

function buildDistribution(samples) {
  const normalized = samples
    .filter((sample) => sample && Number.isFinite(sample.value) && Number.isFinite(sample.weight) && sample.weight > 0)
    .sort((a, b) => a.value - b.value);

  const totalWeight = normalized.reduce((sum, sample) => sum + sample.weight, 0);
  if (!totalWeight) {
    return null;
  }

  const mean = normalized.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / totalWeight;
  const variance = normalized.reduce((sum, sample) => {
    const diff = sample.value - mean;
    return sum + diff * diff * sample.weight;
  }, 0) / totalWeight;

  let cumulative = 0;
  return {
    type: "weighted_discrete",
    mean,
    stddev: Math.sqrt(Math.max(0, variance)),
    sampleCount: normalized.length,
    samples: normalized.map((sample) => {
      cumulative += sample.weight / totalWeight;
      return {
        value: sample.value,
        weight: sample.weight,
        cumulative,
      };
    }),
  };
}

function computePrior(weekMap, targetYear, targetWeek) {
  const changes = [];

  for (let offset = 1; offset <= 4; offset += 1) {
    const current = shiftWeek(targetYear, targetWeek, -offset);
    const currentWeek = weekMap.get(weekKey(current.year, current.week));
    if (!currentWeek || currentWeek.c !== 7) {
      continue;
    }

    const lastYearAvg = getComparableWeekAverage(weekMap, current.year - 1, current.week);
    if (!lastYearAvg) {
      continue;
    }

    changes.push(currentWeek.a / lastYearAvg - 1);
  }

  const sameWeekLastYear = getComparableWeekAverage(weekMap, targetYear - 1, targetWeek);
  if (!sameWeekLastYear) {
    return null;
  }

  if (!changes.length) {
    return sameWeekLastYear;
  }

  const trend = average(changes);
  return sameWeekLastYear * (1 + trend);
}

function getComparableWeekAverage(weekMap, year, week) {
  const normalizedYear = normalizeComparisonYear(year);
  const entry = weekMap.get(weekKey(normalizedYear, week));
  return entry ? entry.a : null;
}

function normalizeComparisonYear(year) {
  if (year === 2020 || year === 2021) {
    return 2019;
  }
  return year;
}

function blendWithPrior(scaledPrediction, prior, priorWeight) {
  if (scaledPrediction == null) {
    return null;
  }
  if (prior == null) {
    return scaledPrediction;
  }
  return scaledPrediction * (1 - priorWeight) + prior * priorWeight;
}

function getKnownDayValues(week, throughDay) {
  if (!week || !week.d) {
    return [];
  }

  const values = [];
  const limit = Math.max(0, Math.min(7, throughDay));
  for (let day = 1; day <= limit; day += 1) {
    const value = Number(week.d[String(day)]);
    if (Number.isFinite(value) && value > 0) {
      values.push(value);
    }
  }
  return values;
}

function getLastCompletedWeek(allWeeks) {
  const fullWeeks = allWeeks.filter((week) => week && week.c === 7).sort(compareWeeksAsc);
  const last = fullWeeks[fullWeeks.length - 1];
  if (!last) {
    return null;
  }
  return { year: last.y, week: last.w, avg: last.a };
}

function computeWeekAverage(week) {
  const values = Object.values(week.d || {}).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return average(values);
}

function buildWeekMap(allWeeks) {
  const map = new Map();
  for (const week of allWeeks) {
    map.set(weekKey(week.y, week.w), week);
  }
  return map;
}

function weekKey(year, week) {
  return `${year}-${week}`;
}

function compareWeeksAsc(a, b) {
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  return a.w - b.w;
}

function isBeforeWeek(yearA, weekA, yearB, weekB) {
  if (yearA !== yearB) {
    return yearA < yearB;
  }
  return weekA < weekB;
}

function weeksBetween(yearA, weekA, yearB, weekB) {
  let cursor = { year: yearA, week: weekA };
  let distance = 0;

  while (cursor.year !== yearB || cursor.week !== weekB) {
    cursor = shiftWeek(cursor.year, cursor.week, 1);
    distance += 1;
    if (distance > 2000) {
      break;
    }
  }

  return distance;
}

function shiftWeek(year, week, delta) {
  let y = year;
  let w = week + delta;

  while (w < 1) {
    y -= 1;
    w += getWeeksInIsoYear(y);
  }

  while (w > getWeeksInIsoYear(y)) {
    w -= getWeeksInIsoYear(y);
    y += 1;
  }

  return { year: y, week: w };
}

function getWeeksInIsoYear(year) {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  return getIsoWeekInfo(dec28).week;
}

function getIsoWeekInfo(date) {
  const working = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = working.getUTCDay() || 7;
  working.setUTCDate(working.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(working.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((working - yearStart) / 86400000) + 1) / 7);
  return { year: working.getUTCFullYear(), week };
}

function getEasternParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const lookup = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    weekday: weekdayMap[lookup.weekday],
  };
}

function easternDateToUtcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function publishingDayIndex(weekday) {
  switch (weekday) {
    case 1:
      return 0;
    case 2:
      return 1;
    case 3:
      return 2;
    case 4:
      return 3;
    case 5:
      return 4;
    default:
      return null;
  }
}

function computeNextUpdateTime(easternParts) {
  const candidates = [2, 3, 4, 5];
  const startDate = easternDateToUtcDate(easternParts.year, easternParts.month, easternParts.day);

  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(startDate.getTime());
    date.setUTCDate(date.getUTCDate() + offset);
    const parts = getEasternParts(date);
    if (!candidates.includes(parts.weekday)) {
      continue;
    }

    if (offset === 0 && easternParts.hour >= PUBLISH_HOUR) {
      continue;
    }

    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(PUBLISH_HOUR)}:00:00 ${EASTERN_TIME_ZONE}`;
  }

  return null;
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
