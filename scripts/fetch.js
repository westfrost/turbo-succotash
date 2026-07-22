// Henter aktuelle togafgange fra Rejseplanen (HAFAS) for hele Danmark,
// vedligeholder dags-filerne i data/days/ og genererer de aggregerede
// JSON-filer som websitet i docs/ læser.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {readdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {createClient} from 'hafas-client';
import {profile as rejseplanenProfile} from 'hafas-client/p/rejseplanen/index.js';
import {STATION_NAMES} from './stations.js';

const ROOT = path.join(import.meta.dirname, '..');
const DAYS_DIR = path.join(ROOT, 'data', 'days');
const DOCS_DATA = path.join(ROOT, 'docs', 'data');
const STATIONS_CACHE = path.join(ROOT, 'data', 'stations.json');

const TZ = 'Europe/Copenhagen';
// Klassifikation (samme princip som DSB's officielle punktlighedsmål):
// til tiden = mindre end 3 minutter forsinket. Før tid = afgang meldt >1 min tidligt.
const DELAYED_THRESHOLD = 180; // sekunder
const EARLY_THRESHOLD = -60; // sekunder
// Al historik gemmes for altid - dagsfilerne er små tekstfiler, og både
// statistik og udgivne dagsfiler dækker hele perioden uden loft.

const client = createClient(rejseplanenProfile, 'dk-togstatus (github.com/westfrost/turbo-succotash)');

// ---------- små hjælpere ----------

function dkParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const s = fmt.format(date); // "2026-07-21 14:05"
  return {date: s.slice(0, 10), hour: Number(s.slice(11, 13))};
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, JSON.stringify(data));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = 1500 * (i + 1) + Math.random() * 500;
      console.warn(`  ${label}: forsøg ${i + 1} fejlede (${err.message}), venter ${Math.round(wait)} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Begrænset parallelitet, så vi ikke hamrer Rejseplanens API.
async function mapPool(items, limit, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

// ---------- stationskatalog ----------
// Gemmes i data/stations.json som {stations: {id: {id, name, lat, lon}}}.
// Kataloget bygges automatisk: et gitter af nearby-opslag hen over Danmark
// finder alle stop med togprodukter. Scanningen gentages den 1. i måneden,
// så nye stationer kommer med af sig selv.

async function loadStationCache() {
  const raw = await readJson(STATIONS_CACHE, null);
  if (!raw) return {stations: {}};
  if (raw.stations) return raw;
  // migration fra det gamle navne-baserede format
  const stations = {};
  for (const s of Object.values(raw)) {
    if (s?.id) stations[s.id] = {id: s.id, name: s.name, lat: s.lat ?? null, lon: s.lon ?? null};
  }
  return {stations};
}

// Fallback-bootstrap: slå seed-listen af knudepunkter op på navn.
async function resolveSeedStations(cache) {
  const known = new Set(Object.values(cache.stations).map((s) => s.name));
  for (const name of STATION_NAMES) {
    if (known.has(name)) continue;
    try {
      const found = await withRetry(
        () => client.locations(name, {results: 3, stops: true, addresses: false, poi: false, language: 'da'}),
        `locations(${name})`,
      );
      const stop = found.find((l) => l.type === 'stop' || l.type === 'station');
      if (stop) {
        cache.stations[stop.id] = {
          id: stop.id,
          name: stop.name,
          lat: stop.location?.latitude ?? null,
          lon: stop.location?.longitude ?? null,
        };
      }
      await sleep(150);
    } catch (err) {
      console.warn(`Opslag fejlede for "${name}": ${err.message}`);
    }
  }
}

async function discoverStations(cache) {
  // Gitter over Danmark (Bornholm har ingen tog). ~0,3° x 0,55° med 26 km
  // radius giver god overlapning.
  const points = [];
  for (let lat = 54.55; lat <= 57.8; lat += 0.3) {
    for (let lon = 8.0; lon <= 12.8; lon += 0.55) {
      points.push([Math.round(lat * 100) / 100, Math.round(lon * 100) / 100]);
    }
  }
  console.log(`Stationsscanning: ${points.length} gitterpunkter...`);
  const before = Object.keys(cache.stations).length;
  let failed = 0;
  await mapPool(points, 4, async ([lat, lon]) => {
    try {
      const found = await withRetry(
        () => client.nearby({type: 'location', latitude: lat, longitude: lon},
          {results: 100, distance: 26000, stops: true, poi: false}),
        `nearby(${lat},${lon})`, 2,
      );
      for (const l of found) {
        if (l.type !== 'stop' && l.type !== 'station') continue;
        // kun stop der betjenes af mindst ét togprodukt (frasorterer busstop)
        if (!Object.values(l.products ?? {}).some(Boolean)) continue;
        if (!cache.stations[l.id]) {
          cache.stations[l.id] = {
            id: l.id,
            name: l.name,
            lat: l.location?.latitude ?? null,
            lon: l.location?.longitude ?? null,
          };
        }
      }
    } catch (err) {
      failed++;
      console.warn(`nearby(${lat},${lon}): opgivet (${err.message})`);
    }
  });
  const added = Object.keys(cache.stations).length - before;
  console.log(`Scanning færdig: ${added} nye stationer fundet (${failed} punkter fejlede). I alt ${Object.keys(cache.stations).length}.`);
}

// ---------- vejrdata (Open-Meteo, gratis og uden nøgle) ----------

// Punkter der dækker jernbanenettet geografisk.
const WEATHER_POINTS = [
  [55.67, 12.57], // København
  [55.40, 10.39], // Odense
  [56.15, 10.20], // Aarhus
  [57.05, 9.92],  // Aalborg
  [55.47, 8.45],  // Esbjerg
  [54.77, 11.87], // Nykøbing F
];

// Henter timevejr for alle punkter (2 dage tilbage + i dag) og fletter det
// ind i data/weather/DATO.json. Pr. time gemmes landets "værste" vejr:
// største vindstød, mest nedbør/sne samt min/max temperatur.
async function fetchWeather() {
  const lat = WEATHER_POINTS.map((p) => p[0]).join(',');
  const lon = WEATHER_POINTS.map((p) => p[1]).join(',');
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&hourly=temperature_2m,precipitation,snowfall,wind_gusts_10m'
    + '&windspeed_unit=ms&timezone=Europe%2FCopenhagen&past_days=2&forecast_days=1';
  const res = await withRetry(async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo svarede ${r.status}`);
    return r.json();
  }, 'open-meteo');
  const points = Array.isArray(res) ? res : [res];

  const byDate = {};
  for (const p of points) {
    const h = p.hourly;
    for (let i = 0; i < (h?.time?.length ?? 0); i++) {
      const date = h.time[i].slice(0, 10);
      const hour = h.time[i].slice(11, 13);
      const e = ((byDate[date] ??= {})[hour] ??= {gust: 0, precip: 0, snow: 0, tmin: Infinity, tmax: -Infinity});
      e.gust = Math.round(Math.max(e.gust, h.wind_gusts_10m[i] ?? 0) * 10) / 10;
      e.precip = Math.round(Math.max(e.precip, h.precipitation[i] ?? 0) * 10) / 10;
      e.snow = Math.round(Math.max(e.snow, h.snowfall[i] ?? 0) * 10) / 10;
      e.tmin = Math.min(e.tmin, h.temperature_2m[i] ?? e.tmin);
      e.tmax = Math.max(e.tmax, h.temperature_2m[i] ?? e.tmax);
    }
  }
  for (const [date, hours] of Object.entries(byDate)) {
    const file = path.join(ROOT, 'data', 'weather', `${date}.json`);
    const existing = await readJson(file, {});
    await writeJson(file, {...existing, ...hours});
  }
  console.log(`Vejrdata gemt for ${Object.keys(byDate).length} dage.`);
}

// Sammenfatter en dags timevejr og sætter kategori (prioriteret rækkefølge).
function weatherSummary(hours) {
  if (!hours || !Object.keys(hours).length) return null;
  const vals = Object.values(hours);
  const s = {
    maxGust: Math.max(...vals.map((v) => v.gust ?? 0)),
    precipSum: Math.round(vals.reduce((a, v) => a + (v.precip ?? 0), 0) * 10) / 10,
    snowSum: Math.round(vals.reduce((a, v) => a + (v.snow ?? 0), 0) * 10) / 10,
    tmin: Math.round(Math.min(...vals.map((v) => v.tmin ?? Infinity)) * 10) / 10,
    tmax: Math.round(Math.max(...vals.map((v) => v.tmax ?? -Infinity)) * 10) / 10,
  };
  s.category = s.snowSum >= 0.5 ? 'sne'
    : s.maxGust >= 15 ? 'blæst'
    : s.precipSum >= 3 ? 'regn'
    : 'tørt';
  return s;
}

// ---------- klassifikation ----------

const PRODUCT_LABELS = {
  'national-train': 'InterCity',
  'national-train-2': 'Lyntog',
  'local-train': 'Regional-/lokaltog',
  'o': 'Øresundstog',
  's-tog': 'S-tog',
};

function productLabel(line) {
  return PRODUCT_LABELS[line?.product] ?? line?.productName ?? 'Andet tog';
}

function operatorOf(line) {
  if (line?.operator?.name) return line.operator.name;
  const n = (line?.name ?? '').trim();
  if (/^(IC|ICL|Lyn|EC|EN|IL)\b/i.test(n)) return 'DSB';
  if (line?.product === 's-tog') return 'DSB S-tog';
  if (line?.product === 'o') return 'Øresundstog';
  if (/arriva|gocollective/i.test(n)) return 'GoCollective (Arriva)';
  if (/lokaltog/i.test(n)) return 'Lokaltog';
  return productLabel(line);
}

function statusOf(delay, cancelled) {
  if (cancelled) return 'aflyst';
  if (delay == null) return 'ukendt';
  if (delay <= EARLY_THRESHOLD) return 'foertid';
  if (delay < DELAYED_THRESHOLD) return 'tiltiden';
  return 'forsinket';
}

const clampDelay = (d) => (d == null ? null : Math.max(-900, Math.min(10800, d)));

// Kategoriserer Rejseplanens bemærkningstekster til en kort årsag.
const CAUSE_RULES = [
  [/personpåkørsel|påkørsel af person/, 'Personpåkørsel'],
  [/signal/, 'Signalfejl'],
  [/køreledning/, 'Køreledningsfejl'],
  [/sporarbejde|sporspærring|vedligehold/, 'Sporarbejde'],
  [/materiel|defekt tog|togsæt/, 'Materiel'],
  [/storm|blæst|kraftig vind|sne|isslag|oversvøm|vejr/, 'Vejrforhold'],
  [/politi|ambulance|redning|brand/, 'Politi/redning'],
  [/personale|bemanding/, 'Personalemangel'],
];

function causeOf(remarks) {
  if (!Array.isArray(remarks)) return null;
  const text = remarks
    .filter((r) => r.type === 'warning' || r.type === 'status')
    .map((r) => r.text ?? r.summary ?? '')
    .join(' ')
    .toLowerCase();
  if (!text.trim()) return null;
  for (const [re, label] of CAUSE_RULES) {
    if (re.test(text)) return label;
  }
  return 'Andet';
}

// ---------- hentning ----------

async function fetchAllDepartures(stations) {
  let failed = 0;
  const perStation = await mapPool(stations, 6, async (st) => {
    try {
      const res = await withRetry(
        () => client.departures(st.id, {duration: 75, results: 400, remarks: true, language: 'da'}),
        `departures(${st.name})`,
      );
      const deps = Array.isArray(res) ? res : res.departures ?? [];
      return deps.map((d) => ({...d, _station: st.name}));
    } catch (err) {
      failed++;
      console.warn(`${st.name}: opgivet (${err.message})`);
      return [];
    }
  });
  if (failed === stations.length) {
    throw new Error('Alle stationsopslag fejlede – API\'et er formentlig nede.');
  }
  console.log(`${failed} af ${stations.length} stationer fejlede.`);
  return perStation.flat();
}

// ---------- sammenfletning i dagsfiler ----------

function mergeIntoDay(dayMap, deps, nowIso) {
  const latestRows = new Map(); // tripId -> række til live-tabellen
  for (const d of deps) {
    if (!d.tripId || !d.plannedWhen) continue;
    const delay = clampDelay(d.cancelled ? null : d.delay);
    const {date, hour} = dkParts(new Date(d.plannedWhen));
    const rec = dayMap[d.tripId] ?? {
      line: d.line?.name ?? '?',
      product: productLabel(d.line),
      operator: operatorOf(d.line),
      direction: d.direction ?? '',
      date,
      hour,
      planned: d.plannedWhen,
      lastDelay: delay,
      maxDelay: delay ?? 0,
      cancelled: false,
      obs: 0,
      lastStation: d._station,
    };
    rec.obs += 1;
    rec.cancelled = rec.cancelled || Boolean(d.cancelled);
    const cause = causeOf(d.remarks);
    if (cause && (rec.cause == null || rec.cause === 'Andet')) rec.cause = cause;
    if (d.plannedWhen <= rec.planned) {
      // tidligste observation bestemmer togets "starttidspunkt" i statistikken
      rec.planned = d.plannedWhen;
      rec.date = date;
      rec.hour = hour;
    }
    // Seneste observation MED realtidsdata bestemmer aktuel status. Stationer
    // langt ude i fremtiden har endnu ingen realtid (delay=null) og må ikke
    // overskrive en kendt forsinkelse.
    if (delay != null && d.plannedWhen >= (rec._lastRtPlanned ?? '')) {
      rec._lastRtPlanned = d.plannedWhen;
      rec.lastDelay = delay;
      rec.lastStation = d._station;
      rec.maxDelay = Math.max(rec.maxDelay ?? 0, delay);
    }
    rec.seenAt = nowIso;
    dayMap[d.tripId] = rec;

    // Live-tabellen: foretræk observationer med realtid, dernæst tidligste.
    const hasRt = delay != null || d.cancelled;
    const existing = latestRows.get(d.tripId);
    if (!existing || (hasRt && !existing._hasRt) || (hasRt === Boolean(existing._hasRt) && d.plannedWhen < existing.planned)) {
      latestRows.set(d.tripId, {
        _hasRt: hasRt,
        id: d.tripId,
        line: rec.line,
        product: rec.product,
        operator: rec.operator,
        direction: rec.direction,
        station: d._station,
        platform: d.platform ?? d.plannedPlatform ?? null,
        planned: d.plannedWhen,
        expected: d.when ?? null,
        delay,
        cancelled: Boolean(d.cancelled),
        status: statusOf(delay, d.cancelled),
      });
    }
  }
  return [...latestRows.values()]
    .map(({_hasRt, ...row}) => row)
    .sort((a, b) => a.planned.localeCompare(b.planned));
}

// ---------- statistik ----------

function summarize(recs) {
  const s = {total: 0, tiltiden: 0, foertid: 0, forsinket: 0, aflyst: 0, ukendt: 0, delaySum: 0, delayN: 0};
  for (const r of recs) {
    s.total++;
    s[statusOf(r.lastDelay, r.cancelled)]++;
    if (!r.cancelled && r.lastDelay != null) {
      s.delaySum += r.lastDelay;
      s.delayN++;
    }
  }
  const known = s.total - s.ukendt;
  s.avgDelay = s.delayN ? Math.round(s.delaySum / s.delayN) : 0;
  s.punctuality = known > 0 ? Math.round(((s.tiltiden + s.foertid) / known) * 1000) / 10 : null;
  delete s.delaySum;
  delete s.delayN;
  return s;
}

function groupStats(recs, keyFn, {min = 1, top = Infinity} = {}) {
  const groups = new Map();
  for (const r of recs) {
    const k = keyFn(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .filter(([, v]) => v.length >= min)
    .map(([k, v]) => ({key: k, ...summarize(v)}))
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}

function buildTips(stats, allRecs) {
  const tips = [];
  const days = stats.days.filter((d) => d.punctuality != null);
  const today = days.at(-1);
  const prev = days.slice(0, -1);
  if (today && prev.length >= 3) {
    const avg = prev.reduce((a, d) => a + d.punctuality, 0) / prev.length;
    const diff = Math.round((today.punctuality - avg) * 10) / 10;
    if (diff <= -3) tips.push(`I dag kører togene dårligere end normalt: ${today.punctuality} % til tiden mod normalt ca. ${Math.round(avg)} %. Læg lidt ekstra rejsetid ind.`);
    else if (diff >= 3) tips.push(`I dag kører togene bedre end normalt: ${today.punctuality} % til tiden mod normalt ca. ${Math.round(avg)} %.`);
    else tips.push(`Punktligheden i dag (${today.punctuality} %) ligger tæt på normalen for de seneste ${prev.length} dage.`);
  }
  const lines = groupStats(allRecs, (r) => r.line, {min: 25}).filter((l) => l.punctuality != null);
  if (lines.length >= 3) {
    const worst = [...lines].sort((a, b) => a.punctuality - b.punctuality)[0];
    const best = [...lines].sort((a, b) => b.punctuality - a.punctuality)[0];
    tips.push(`Linjen med flest forsinkelser er ${worst.key} (${worst.punctuality} % til tiden). Skal du med den, så hold øje med afgangen i god tid.`);
    tips.push(`Mest pålidelige linje: ${best.key} med ${best.punctuality} % til tiden.`);
  }
  const hours = stats.byHour.filter((h) => h.total >= 20 && h.punctuality != null);
  if (hours.length >= 6) {
    const worstH = [...hours].sort((a, b) => a.punctuality - b.punctuality)[0];
    const bestH = [...hours].sort((a, b) => b.punctuality - a.punctuality)[0];
    tips.push(`Flest forsinkelser rammer afgange omkring kl. ${worstH.key}–${(Number(worstH.key) + 1) % 24}. Kan du rejse omkring kl. ${bestH.key} i stedet, er chancen for at komme til tiden størst.`);
  }
  const total = summarize(allRecs);
  if (total.total > 0 && total.aflyst / total.total >= 0.02) {
    tips.push(`${Math.round((total.aflyst / total.total) * 100)} % af afgangene er blevet aflyst i perioden – tjek altid Rejseplanen, før du tager hjemmefra.`);
  }
  tips.push('Et tog tæller som "til tiden", når det er mindre end 3 minutter forsinket – samme princip som DSB\'s officielle punktlighedsmål.');
  return tips;
}

// Udgiver en kompakt udgave af hver dagsfil til websitet (docs/data/days/)
// plus et indeks over tilgængelige datoer, så historik-sektionen kan bladre.
async function publishDays() {
  const files = existsSync(DAYS_DIR)
    ? readdirSync(DAYS_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];
  const dates = [];
  for (const f of files) {
    const date = f.replace('.json', '');
    const dayMap = await readJson(path.join(DAYS_DIR, f), {});
    const trains = Object.values(dayMap)
      .map((r) => ({
        line: r.line,
        product: r.product,
        operator: r.operator,
        direction: r.direction,
        station: r.lastStation ?? null,
        planned: r.planned,
        hour: r.hour,
        delay: r.lastDelay ?? null,
        maxDelay: r.maxDelay ?? null,
        cancelled: Boolean(r.cancelled),
        status: statusOf(r.lastDelay, r.cancelled),
        cause: r.cause ?? null,
      }))
      .sort((a, b) => (a.planned ?? '').localeCompare(b.planned ?? ''));
    const weather = weatherSummary(await readJson(path.join(ROOT, 'data', 'weather', `${date}.json`), null));
    await writeJson(path.join(DOCS_DATA, 'days', `${date}.json`), {date, weather, trains});
    dates.push(date);
  }
  await writeJson(path.join(DOCS_DATA, 'index.json'), {
    generatedAt: new Date().toISOString(),
    dates,
  });

  // Stationskoordinater til danmarkskortet
  const cache = await loadStationCache();
  await writeJson(path.join(DOCS_DATA, 'stations.json'),
    Object.values(cache.stations)
      .filter((s) => s.lat != null && s.lon != null)
      .map((s) => ({name: s.name, lat: s.lat, lon: s.lon})));

  return dates.length;
}

// Lille SVG-badge med dagens punktlighed (docs/badge.svg)
async function writeBadge(stats) {
  const p = stats.days.at(-1)?.punctuality;
  const value = p == null ? 'ingen data' : `${String(p).replace('.', ',')} %`;
  const color = p == null ? '#898781' : p >= 90 ? '#0ca30c' : p >= 75 ? '#c98500' : '#d03b3b';
  const lw = 118;
  const vw = Math.max(46, value.length * 8 + 12);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="punktlighed i dag: ${value}">
<rect width="${lw}" height="20" rx="3" fill="#52514e"/>
<rect x="${lw}" width="${vw}" height="20" rx="3" fill="${color}"/>
<rect x="${lw - 3}" width="6" height="20" fill="${color}"/>
<g fill="#fff" font-family="system-ui,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">🚆 punktlighed i dag</text>
<text x="${lw + vw / 2}" y="14" font-weight="bold">${value}</text>
</g>
</svg>`;
  await mkdir(path.join(ROOT, 'docs'), {recursive: true});
  await writeFile(path.join(ROOT, 'docs', 'badge.svg'), svg);
}

async function buildStats() {
  const files = existsSync(DAYS_DIR)
    ? readdirSync(DAYS_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];
  const perDay = [];
  const allRecs = [];
  for (const f of files) {
    const dayMap = await readJson(path.join(DAYS_DIR, f), {});
    const recs = Object.values(dayMap);
    perDay.push({date: f.replace('.json', ''), ...summarize(recs)});
    for (const r of recs) allRecs.push(r);
  }
  const stats = {
    generatedAt: new Date().toISOString(),
    periodDays: files.length,
    days: perDay,
    byProduct: groupStats(allRecs, (r) => r.product),
    byOperator: groupStats(allRecs, (r) => r.operator),
    byLine: groupStats(allRecs, (r) => r.line, {min: 10, top: 15}),
    byHour: Array.from({length: 24}, (_, h) => h)
      .map((h) => ({key: String(h), ...summarize(allRecs.filter((r) => r.hour === h))})),
    worstLines: groupStats(allRecs, (r) => r.line, {min: 25})
      .filter((l) => l.punctuality != null)
      .sort((a, b) => a.punctuality - b.punctuality)
      .slice(0, 10),
  };
  stats.tips = buildTips(stats, allRecs);
  return stats;
}

// ---------- main ----------

// --offline springer datahentningen over og genberegner kun udgivne filer
// (docs/data/*) fra de eksisterende dagsfiler i data/days/.
const OFFLINE = process.argv.includes('--offline');
const nowIso = new Date().toISOString();
const today = dkParts().date;

console.log(`== dk-togstatus ${nowIso} (${today})${OFFLINE ? ' [offline]' : ''} ==`);

if (!OFFLINE) {
  const cache = await loadStationCache();
  const count = () => Object.keys(cache.stations).length;
  // Scan: ved --discover, ved (næsten) tomt katalog, og den 1. i måneden
  // kl. 05 dansk tid, så nye stationer kommer med automatisk.
  const needDiscover = process.argv.includes('--discover')
    || count() < 60
    || (today.endsWith('-01') && dkParts().hour === 5);
  if (needDiscover) {
    if (count() < 10) await resolveSeedStations(cache);
    await discoverStations(cache);
    await writeJson(STATIONS_CACHE, cache);
  }
  if (count() === 0) throw new Error('Ingen stationer kunne slås op.');
  const stations = Object.values(cache.stations);
  console.log(`${stations.length} stationer i brug.`);

  const deps = await fetchAllDepartures(stations);
  console.log(`${deps.length} afgange hentet i alt.`);

  const dayFile = path.join(DAYS_DIR, `${today}.json`);
  const dayMap = await readJson(dayFile, {});
  const latest = mergeIntoDay(dayMap, deps, nowIso);
  // Afgange kort efter midnat kan høre til i morgendagens fil – de lander via
  // rec.date, men vi gemmer alt i dags-filen for den dag, kørslen skete.
  await writeJson(dayFile, dayMap);
  console.log(`${Object.keys(dayMap).length} unikke tog registreret for ${today}.`);

  await writeJson(path.join(DOCS_DATA, 'latest.json'), {
    generatedAt: nowIso,
    trains: latest,
  });

  // Vejret må aldrig vælte togdata-kørslen
  try {
    await fetchWeather();
  } catch (err) {
    console.warn(`Vejrdata kunne ikke hentes: ${err.message}`);
  }
}

const publishedDays = await publishDays();
const stats = await buildStats();
await writeJson(path.join(DOCS_DATA, 'stats.json'), stats);
await writeBadge(stats);
console.log(`Statistik genereret for ${stats.periodDays} dage, ${publishedDays} dagsfiler udgivet. Færdig.`);
