/* DK Togstatus – frontend. Læser docs/data/latest.json + stats.json og
   tegner søgbar tabel, KPI'er, tips og grafer (Chart.js). */
(() => {
  const STATUS_LABELS = {
    tiltiden: 'Til tiden',
    foertid: 'Før tid',
    forsinket: 'Forsinket',
    aflyst: 'Aflyst',
    ukendt: 'Ingen realtid',
  };

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const timeFmt = new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit',
  });
  const dateTimeFmt = new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('da-DK', {day: 'numeric', month: 'short'});

  const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : '–');
  const fmtDelay = (sec) => {
    if (sec == null) return '–';
    const m = Math.round(sec / 60);
    return (m > 0 ? '+' : m < 0 ? '−' : '') + Math.abs(m) + ' min';
  };
  const pct = (v) => (v == null ? '–' : v.toLocaleString('da-DK') + ' %');

  let latest = null;
  let stats = null;
  let statusFilter = '';
  let charts = [];

  // ---------- tabel og søgning ----------

  function renderTable() {
    const tbody = document.querySelector('#trains tbody');
    const q = document.getElementById('search').value.trim().toLowerCase();
    const rows = (latest?.trains ?? []).filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (!q) return true;
      return [t.line, t.direction, t.station, t.operator, t.product]
        .some((s) => (s ?? '').toLowerCase().includes(q));
    });
    tbody.innerHTML = rows.slice(0, 300).map((t) => `
      <tr>
        <td><strong>${esc(t.line)}</strong><br><small style="color:var(--text-muted)">${esc(t.product)}</small></td>
        <td>${esc(t.direction)}</td>
        <td>${esc(t.station)}</td>
        <td class="num">${fmtTime(t.planned)}</td>
        <td class="num">${t.cancelled ? '–' : fmtTime(t.expected ?? t.planned)}</td>
        <td class="num">${t.cancelled ? '–' : fmtDelay(t.delay)}</td>
        <td><span class="badge ${t.status}">${STATUS_LABELS[t.status] ?? t.status}</span></td>
      </tr>`).join('');
    document.getElementById('trainCount').textContent =
      rows.length === 0
        ? 'Ingen afgange matcher søgningen.'
        : `${rows.length} afgange${rows.length > 300 ? ' (viser de første 300)' : ''}.`;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  // ---------- KPI'er ----------

  function renderKpis() {
    const today = stats?.days?.at(-1);
    const el = document.getElementById('kpis');
    if (!today) { el.innerHTML = ''; return; }
    const items = [
      ['Tog i dag', today.total.toLocaleString('da-DK'), 'unikke registrerede tog'],
      ['Til tiden', pct(today.punctuality), 'inkl. før tid'],
      ['Forsinkede', today.forsinket.toLocaleString('da-DK'), '≥ 3 min forsinket'],
      ['Aflyste', today.aflyst.toLocaleString('da-DK'), ''],
      ['Gns. forsinkelse', fmtDelay(today.avgDelay), 'blandt tog med realtid'],
    ];
    el.innerHTML = items.map(([label, value, hint]) => `
      <div class="card kpi">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
        <div class="hint">${hint}</div>
      </div>`).join('');
  }

  // ---------- grafer ----------

  function chartColors() {
    return {
      blue: cssVar('--series-1'),
      blueSoft: cssVar('--series-1-soft'),
      good: cssVar('--status-good'),
      warning: cssVar('--status-warning'),
      serious: cssVar('--status-serious'),
      critical: cssVar('--status-critical'),
      muted: cssVar('--text-muted'),
      grid: cssVar('--grid'),
      surface: cssVar('--surface-1'),
      text: cssVar('--text-secondary'),
    };
  }

  function baseOptions(c, {horizontal = false, percentAxis = false} = {}) {
    const valueAxis = {
      grid: {color: c.grid},
      border: {color: cssVar('--baseline')},
      ticks: {color: c.muted, callback: percentAxis ? (v) => v + ' %' : undefined},
      ...(percentAxis ? {min: 0, max: 100} : {}),
    };
    const catAxis = {grid: {display: false}, border: {color: cssVar('--baseline')}, ticks: {color: c.muted}};
    return {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {display: false},
        tooltip: {
          backgroundColor: c.surface, titleColor: cssVar('--text-primary'),
          bodyColor: c.text, borderColor: c.grid, borderWidth: 1,
        },
      },
      scales: horizontal ? {x: valueAxis, y: catAxis} : {x: catAxis, y: valueAxis},
    };
  }

  // Skjuler kortet og viser en note, hvis der ikke er data nok til grafen.
  function chartOrNotice(canvasId, rows) {
    const card = document.getElementById(canvasId).closest('.chart-card');
    let note = card.querySelector('.nodata');
    if (rows.length === 0) {
      card.querySelector('.chart-box').style.display = 'none';
      if (!note) {
        note = document.createElement('p');
        note.className = 'notice nodata';
        note.textContent = 'Ikke nok data endnu – kom tilbage, når databasen har samlet mere.';
        card.appendChild(note);
      }
      return false;
    }
    card.querySelector('.chart-box').style.display = '';
    note?.remove();
    return true;
  }

  function renderCharts() {
    charts.forEach((ch) => ch.destroy());
    charts = [];
    if (!stats) return;
    const c = chartColors();
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';

    // 1) Status i dag – én vandret stablet bjælke med statusfarver
    const today = stats.days.at(-1);
    if (today) {
      const parts = [
        ['tiltiden', c.good], ['foertid', c.warning],
        ['forsinket', c.serious], ['aflyst', c.critical], ['ukendt', c.muted],
      ].filter(([k]) => today[k] > 0);
      const opts = baseOptions(c, {horizontal: true});
      opts.plugins.legend = {display: true, position: 'bottom', labels: {color: c.text, boxWidth: 12, boxHeight: 12}};
      opts.scales.x.stacked = true;
      opts.scales.y.stacked = true;
      opts.scales.x.ticks.callback = (v) => v;
      charts.push(new Chart(document.getElementById('chartStatus'), {
        type: 'bar',
        data: {
          labels: ['I dag'],
          datasets: parts.map(([k, color]) => ({
            label: `${STATUS_LABELS[k]} (${today[k]})`,
            data: [today[k]],
            backgroundColor: color,
            borderColor: c.surface,
            borderWidth: 2,
            barThickness: 34,
          })),
        },
        options: opts,
      }));
    }

    // 2) Punktlighed pr. dag – linje
    const days = stats.days.filter((d) => d.punctuality != null);
    if (chartOrNotice('chartDays', days)) charts.push(new Chart(document.getElementById('chartDays'), {
      type: 'line',
      data: {
        labels: days.map((d) => dayFmt.format(new Date(d.date))),
        datasets: [{
          label: 'Til tiden',
          data: days.map((d) => d.punctuality),
          borderColor: c.blue,
          backgroundColor: c.blue,
          borderWidth: 2,
          pointRadius: days.length > 20 ? 2.5 : 4,
          tension: 0.25,
        }, {
          label: 'DSB-mål (ca. 90 %)',
          data: days.map(() => 90),
          borderColor: c.muted,
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
        }],
      },
      options: (() => {
        const o = baseOptions(c, {percentAxis: true});
        o.plugins.legend = {display: true, position: 'bottom', labels: {color: c.text, boxWidth: 12, boxHeight: 12}};
        return o;
      })(),
    }));

    // 3) Punktlighed pr. time – søjler
    const hours = stats.byHour.filter((h) => h.total >= 5 && h.punctuality != null);
    if (chartOrNotice('chartHours', hours)) charts.push(new Chart(document.getElementById('chartHours'), {
      type: 'bar',
      data: {
        labels: hours.map((h) => h.key),
        datasets: [{
          label: 'Til tiden',
          data: hours.map((h) => h.punctuality),
          backgroundColor: c.blue,
          borderRadius: {topLeft: 4, topRight: 4},
          borderSkipped: 'start',
          maxBarThickness: 22,
        }],
      },
      options: (() => {
        const o = baseOptions(c, {percentAxis: true});
        o.scales.x.title = {display: true, text: 'Afgangstime', color: c.muted};
        return o;
      })(),
    }));

    // 4) Punktlighed pr. togtype – vandrette søjler
    const prods = stats.byProduct.filter((p) => p.punctuality != null);
    if (chartOrNotice('chartProducts', prods)) charts.push(new Chart(document.getElementById('chartProducts'), {
      type: 'bar',
      data: {
        labels: prods.map((p) => p.key),
        datasets: [{
          label: 'Til tiden',
          data: prods.map((p) => p.punctuality),
          backgroundColor: c.blue,
          borderRadius: {topRight: 4, bottomRight: 4},
          borderSkipped: 'start',
          maxBarThickness: 22,
        }],
      },
      options: baseOptions(c, {horizontal: true, percentAxis: true}),
    }));

    // 5) Mest forsinkede linjer
    const worst = stats.worstLines ?? [];
    if (chartOrNotice('chartLines', worst)) charts.push(new Chart(document.getElementById('chartLines'), {
      type: 'bar',
      data: {
        labels: worst.map((l) => l.key),
        datasets: [{
          label: 'Til tiden',
          data: worst.map((l) => l.punctuality),
          backgroundColor: c.blueSoft,
          borderRadius: {topRight: 4, bottomRight: 4},
          borderSkipped: 'start',
          maxBarThickness: 18,
        }],
      },
      options: baseOptions(c, {horizontal: true, percentAxis: true}),
    }));
  }

  // ---------- historik: bladre i datoer / fra-til-periode ----------

  let histIndex = []; // tilgængelige datoer (sorteret)
  let histFrom = null;
  let histTo = null;
  const histCache = new Map(); // dato -> togliste
  let histCharts = [];
  let histTrains = [];
  let histMultiDay = false;

  const dayMs = 86400000;
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const toStr = (d) => d.toISOString().slice(0, 10);
  const shiftDate = (s, days) => toStr(new Date(toDate(s).getTime() + days * dayMs));
  const datesBetween = (from, to) => {
    const out = [];
    for (let d = toDate(from); d <= toDate(to); d = new Date(d.getTime() + dayMs)) out.push(toStr(d));
    return out;
  };
  const longDate = new Intl.DateTimeFormat('da-DK', {day: 'numeric', month: 'long', year: 'numeric'});
  const shortDateTime = new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  function aggregate(trains) {
    const s = {total: 0, tiltiden: 0, foertid: 0, forsinket: 0, aflyst: 0, ukendt: 0, delaySum: 0, delayN: 0};
    for (const t of trains) {
      s.total++;
      s[t.status] = (s[t.status] ?? 0) + 1;
      if (!t.cancelled && t.delay != null) { s.delaySum += t.delay; s.delayN++; }
    }
    const known = s.total - s.ukendt;
    s.avgDelay = s.delayN ? Math.round(s.delaySum / s.delayN) : null;
    s.punctuality = known > 0 ? Math.round(((s.tiltiden + s.foertid) / known) * 1000) / 10 : null;
    return s;
  }

  function groupBy(trains, keyFn) {
    const m = new Map();
    for (const t of trains) {
      const k = keyFn(t);
      if (k == null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return m;
  }

  async function histFetchDays(dates) {
    await Promise.all(dates.filter((d) => !histCache.has(d)).map(async (d) => {
      try {
        const r = await fetch(`data/days/${d}.json`);
        const file = r.ok ? await r.json() : {};
        histCache.set(d, {trains: file.trains ?? [], weather: file.weather ?? null});
      } catch {
        histCache.set(d, {trains: [], weather: null});
      }
    }));
  }

  const WEATHER_LABELS = {'tørt': '☀️ Tørt', 'regn': '🌧️ Regn', 'blæst': '💨 Blæst', 'sne': '❄️ Sne'};

  function weatherText(w) {
    if (!w) return null;
    return `${WEATHER_LABELS[w.category] ?? w.category} · vindstød op til ${Math.round(w.maxGust)} m/s · ${String(w.precipSum).replace('.', ',')} mm nedbør · ${Math.round(w.tmin)}–${Math.round(w.tmax)} °C`;
  }

  async function histApply() {
    if (!histIndex.length) return;
    // hold inputs inden for det tilgængelige interval og i rigtig rækkefølge
    const min = histIndex[0];
    const max = histIndex.at(-1);
    histFrom = histFrom < min ? min : histFrom > max ? max : histFrom;
    histTo = histTo < min ? min : histTo > max ? max : histTo;
    if (histFrom > histTo) [histFrom, histTo] = [histTo, histFrom];
    document.getElementById('histFrom').value = histFrom;
    document.getElementById('histTo').value = histTo;
    document.getElementById('histPrev').disabled = histFrom <= min;
    document.getElementById('histNext').disabled = histTo >= max;

    // delbart link: periode i URL'en
    history.replaceState(null, '', `?fra=${histFrom}&til=${histTo}`);

    const dates = datesBetween(histFrom, histTo);
    await histFetchDays(dates);
    histTrains = dates.flatMap((d) => (histCache.get(d)?.trains ?? []).map((t) => ({...t, date: d})));
    histMultiDay = histFrom !== histTo;
    const missing = dates.filter((d) => !histIndex.includes(d)).length;

    const label = histMultiDay
      ? `${longDate.format(toDate(histFrom))} – ${longDate.format(toDate(histTo))}`
      : longDate.format(toDate(histFrom));
    const weather = !histMultiDay ? weatherText(histCache.get(histFrom)?.weather) : null;
    document.getElementById('histInfo').textContent =
      `${label} · ${histTrains.length.toLocaleString('da-DK')} tog` +
      (missing ? ` · ${missing} dag(e) uden data` : '') +
      (weather ? ` · ${weather}` : '');

    renderHistKpis();
    renderHistCharts();
    renderHistMap();
    renderHistRecords();
    renderHistTable();
  }

  function renderHistKpis() {
    const s = aggregate(histTrains);
    document.getElementById('histKpis').innerHTML = [
      ['Tog', s.total.toLocaleString('da-DK'), ''],
      ['Til tiden', pct(s.punctuality), 'inkl. før tid'],
      ['Forsinkede', s.forsinket.toLocaleString('da-DK'), '≥ 3 min'],
      ['Aflyste', s.aflyst.toLocaleString('da-DK'), ''],
      ['Gns. forsinkelse', fmtDelay(s.avgDelay), 'tog med realtid'],
    ].map(([l, v, h]) => `
      <div class="card kpi">
        <div class="label">${l}</div>
        <div class="value">${v}</div>
        <div class="hint">${h}</div>
      </div>`).join('');
  }

  function renderHistCharts() {
    histCharts.forEach((ch) => ch.destroy());
    histCharts = [];
    if (!histTrains.length && !histIndex.length) return;
    const c = chartColors();
    const s = aggregate(histTrains);

    // Status i perioden – stablet vandret bjælke i statusfarver
    document.getElementById('histStatusDesc').textContent = histMultiDay
      ? 'Fordeling af registrerede tog i perioden' : 'Fordeling af dagens registrerede tog';
    if (chartOrNotice('histStatus', histTrains)) {
      const parts = [
        ['tiltiden', c.good], ['foertid', c.warning],
        ['forsinket', c.serious], ['aflyst', c.critical], ['ukendt', c.muted],
      ].filter(([k]) => s[k] > 0);
      const opts = baseOptions(c, {horizontal: true});
      opts.plugins.legend = {display: true, position: 'bottom', labels: {color: c.text, boxWidth: 12, boxHeight: 12}};
      opts.scales.x.stacked = true;
      opts.scales.y.stacked = true;
      histCharts.push(new Chart(document.getElementById('histStatus'), {
        type: 'bar',
        data: {
          labels: [histMultiDay ? 'Perioden' : 'Dagen'],
          datasets: parts.map(([k, color]) => ({
            label: `${STATUS_LABELS[k]} (${s[k]})`,
            data: [s[k]],
            backgroundColor: color,
            borderColor: c.surface,
            borderWidth: 2,
            barThickness: 34,
          })),
        },
        options: opts,
      }));
    }

    // Punktlighed pr. dag – kun relevant for flerdages-perioder
    const daysCard = document.getElementById('histDaysCard');
    if (histMultiDay) {
      daysCard.style.display = '';
      const perDay = [...groupBy(histTrains, (t) => t.date).entries()]
        .map(([d, ts]) => ({date: d, ...aggregate(ts)}))
        .filter((d) => d.punctuality != null)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (chartOrNotice('histDays', perDay)) {
        const o = baseOptions(c, {percentAxis: true});
        o.plugins.legend = {display: true, position: 'bottom', labels: {color: c.text, boxWidth: 12, boxHeight: 12}};
        o.plugins.tooltip.callbacks = {
          afterBody: (items) => {
            const w = histCache.get(perDay[items[0]?.dataIndex]?.date)?.weather;
            return weatherText(w) ?? '';
          },
        };
        histCharts.push(new Chart(document.getElementById('histDays'), {
          type: 'line',
          data: {
            labels: perDay.map((d) => dayFmt.format(toDate(d.date))),
            datasets: [{
              label: 'Til tiden',
              data: perDay.map((d) => d.punctuality),
              borderColor: c.blue,
              backgroundColor: c.blue,
              borderWidth: 2,
              pointRadius: perDay.length > 20 ? 2.5 : 4,
              tension: 0.25,
            }, {
              label: 'DSB-mål (ca. 90 %)',
              data: perDay.map(() => 90),
              borderColor: c.muted,
              borderDash: [6, 4],
              borderWidth: 1.5,
              pointRadius: 0,
            }],
          },
          options: o,
        }));
      }
    } else {
      daysCard.style.display = 'none';
    }

    // Punktlighed pr. time
    const perHour = [...groupBy(histTrains, (t) => t.hour).entries()]
      .map(([h, ts]) => ({hour: Number(h), ...aggregate(ts)}))
      .filter((h) => h.total >= 5 && h.punctuality != null)
      .sort((a, b) => a.hour - b.hour);
    if (chartOrNotice('histHours', perHour)) {
      const o = baseOptions(c, {percentAxis: true});
      o.scales.x.title = {display: true, text: 'Afgangstime', color: c.muted};
      histCharts.push(new Chart(document.getElementById('histHours'), {
        type: 'bar',
        data: {
          labels: perHour.map((h) => String(h.hour)),
          datasets: [{
            label: 'Til tiden',
            data: perHour.map((h) => h.punctuality),
            backgroundColor: c.blue,
            borderRadius: {topLeft: 4, topRight: 4},
            borderSkipped: 'start',
            maxBarThickness: 22,
          }],
        },
        options: o,
      }));
    }

    // Punktlighed pr. togtype
    const perProduct = [...groupBy(histTrains, (t) => t.product).entries()]
      .map(([p, ts]) => ({key: p, ...aggregate(ts)}))
      .filter((p) => p.punctuality != null)
      .sort((a, b) => b.total - a.total);
    if (chartOrNotice('histProducts', perProduct)) {
      histCharts.push(new Chart(document.getElementById('histProducts'), {
        type: 'bar',
        data: {
          labels: perProduct.map((p) => p.key),
          datasets: [{
            label: 'Til tiden',
            data: perProduct.map((p) => p.punctuality),
            backgroundColor: c.blue,
            borderRadius: {topRight: 4, bottomRight: 4},
            borderSkipped: 'start',
            maxBarThickness: 22,
          }],
        },
        options: baseOptions(c, {horizontal: true, percentAxis: true}),
      }));
    }

    // Mest forsinkede linjer i perioden
    const worst = [...groupBy(histTrains, (t) => t.line).entries()]
      .map(([l, ts]) => ({key: l, ...aggregate(ts)}))
      .filter((l) => l.total >= 10 && l.punctuality != null)
      .sort((a, b) => a.punctuality - b.punctuality)
      .slice(0, 10);
    if (chartOrNotice('histLines', worst)) {
      histCharts.push(new Chart(document.getElementById('histLines'), {
        type: 'bar',
        data: {
          labels: worst.map((l) => l.key),
          datasets: [{
            label: 'Til tiden',
            data: worst.map((l) => l.punctuality),
            backgroundColor: c.blueSoft,
            borderRadius: {topRight: 4, bottomRight: 4},
            borderSkipped: 'start',
            maxBarThickness: 18,
          }],
        },
        options: baseOptions(c, {horizontal: true, percentAxis: true}),
      }));
    }

    // Punktlighed efter vejrtype (dage grupperet på kategori)
    const byWeather = new Map();
    for (const d of datesBetween(histFrom, histTo)) {
      const file = histCache.get(d);
      if (!file?.weather || !file.trains.length) continue;
      const cat = file.weather.category;
      if (!byWeather.has(cat)) byWeather.set(cat, {trains: [], days: 0});
      byWeather.get(cat).trains.push(...file.trains);
      byWeather.get(cat).days++;
    }
    const weatherRows = [...byWeather.entries()]
      .map(([cat, v]) => ({cat, days: v.days, ...aggregate(v.trains)}))
      .filter((w) => w.punctuality != null);
    if (chartOrNotice('histWeather', weatherRows)) {
      histCharts.push(new Chart(document.getElementById('histWeather'), {
        type: 'bar',
        data: {
          labels: weatherRows.map((w) => `${WEATHER_LABELS[w.cat] ?? w.cat} (${w.days} d.)`),
          datasets: [{
            label: 'Til tiden',
            data: weatherRows.map((w) => w.punctuality),
            backgroundColor: c.blue,
            borderRadius: {topLeft: 4, topRight: 4},
            borderSkipped: 'start',
            maxBarThickness: 40,
          }],
        },
        options: baseOptions(c, {percentAxis: true}),
      }));
    }

    // Punktlighed pr. ugedag
    const WEEKDAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
    const byWeekday = [...groupBy(histTrains, (t) => (toDate(t.date).getUTCDay() + 6) % 7).entries()]
      .map(([wd, ts]) => ({wd: Number(wd), ...aggregate(ts)}))
      .filter((w) => w.punctuality != null)
      .sort((a, b) => a.wd - b.wd);
    if (chartOrNotice('histWeekdays', histMultiDay ? byWeekday : [])) {
      histCharts.push(new Chart(document.getElementById('histWeekdays'), {
        type: 'bar',
        data: {
          labels: byWeekday.map((w) => WEEKDAYS[w.wd]),
          datasets: [{
            label: 'Til tiden',
            data: byWeekday.map((w) => w.punctuality),
            backgroundColor: c.blue,
            borderRadius: {topLeft: 4, topRight: 4},
            borderSkipped: 'start',
            maxBarThickness: 30,
          }],
        },
        options: baseOptions(c, {percentAxis: true}),
      }));
    }

    // Forsinkelsesårsager (antal tog med bemærkning)
    const causes = [...groupBy(histTrains.filter((t) => t.cause), (t) => t.cause).entries()]
      .map(([k, ts]) => ({key: k, n: ts.length}))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    if (chartOrNotice('histCauses', causes)) {
      histCharts.push(new Chart(document.getElementById('histCauses'), {
        type: 'bar',
        data: {
          labels: causes.map((x) => x.key),
          datasets: [{
            label: 'Antal tog',
            data: causes.map((x) => x.n),
            backgroundColor: c.blue,
            borderRadius: {topRight: 4, bottomRight: 4},
            borderSkipped: 'start',
            maxBarThickness: 20,
          }],
        },
        options: baseOptions(c, {horizontal: true}),
      }));
    }
  }

  // ---------- danmarkskort ----------

  let stationCoords = null; // name -> {lat, lon}
  let map = null;
  let tileLayer = null;
  let markerLayer = null;

  function setTiles() {
    if (!map) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const url = dark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(url, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 12,
    }).addTo(map);
  }

  function renderHistMap() {
    const el = document.getElementById('histMap');
    if (typeof L === 'undefined' || !stationCoords || !Object.keys(stationCoords).length) {
      el.closest('.chart-card').style.display = 'none';
      return;
    }
    el.closest('.chart-card').style.display = '';
    if (!map) {
      map = L.map('histMap', {scrollWheelZoom: false}).setView([56.05, 10.8], 6);
      markerLayer = L.layerGroup().addTo(map);
      setTiles();
    }
    markerLayer.clearLayers();
    const perStation = [...groupBy(histTrains, (t) => t.station).entries()]
      .map(([name, ts]) => ({name, ...aggregate(ts)}))
      .filter((s) => s.total >= 3 && s.punctuality != null);
    for (const s of perStation) {
      const pos = stationCoords[s.name];
      if (!pos) continue;
      const color = s.punctuality >= 90 ? cssVar('--status-good')
        : s.punctuality >= 75 ? cssVar('--status-warning')
        : s.punctuality >= 50 ? cssVar('--status-serious')
        : cssVar('--status-critical');
      L.circleMarker([pos.lat, pos.lon], {
        radius: Math.min(16, 5 + Math.sqrt(s.total)),
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.55,
      }).bindPopup(
        `<strong>${esc(s.name)}</strong><br>${s.total} tog · ${pct(s.punctuality)} til tiden` +
        `<br>Gns. forsinkelse: ${fmtDelay(s.avgDelay)}`,
      ).addTo(markerLayer);
    }
  }

  // ---------- rekordliste og CSV ----------

  function renderHistRecords() {
    const top = histTrains
      .filter((t) => t.maxDelay != null && t.maxDelay > 0 && !t.cancelled)
      .sort((a, b) => b.maxDelay - a.maxDelay)
      .slice(0, 10);
    document.querySelector('#histRecords tbody').innerHTML = top.map((t, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${dayFmt.format(toDate(t.date))}</td>
        <td><strong>${esc(t.line)}</strong> <small style="color:var(--text-muted)">${esc(t.product)}</small></td>
        <td>${esc(t.direction)}</td>
        <td>${esc(t.station ?? '–')}</td>
        <td class="num"><strong>${fmtDelay(t.maxDelay)}</strong></td>
        <td>${esc(t.cause ?? '–')}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="notice">Ingen forsinkelser i perioden.</td></tr>';
  }

  function exportCsv() {
    const q = document.getElementById('histSearch').value.trim().toLowerCase();
    const rows = histTrains.filter((t) => !q ||
      [t.line, t.direction, t.station, t.operator, t.product]
        .some((x) => (x ?? '').toLowerCase().includes(q)));
    const head = ['dato', 'linje', 'togtype', 'operatør', 'retning', 'sidst_set', 'planlagt', 'forsinkelse_min', 'maks_forsinkelse_min', 'aflyst', 'status', 'årsag'];
    const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((t) => [
      t.date, t.line, t.product, t.operator, t.direction, t.station,
      t.planned, t.delay == null ? '' : Math.round(t.delay / 60),
      t.maxDelay == null ? '' : Math.round(t.maxDelay / 60),
      t.cancelled ? 'ja' : 'nej', STATUS_LABELS[t.status] ?? t.status, t.cause ?? '',
    ].map(csvEsc).join(';'));
    const blob = new Blob(['﻿' + head.join(';') + '\n' + lines.join('\n')], {type: 'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `togstatus_${histFrom}_${histTo}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderHistTable() {
    const q = document.getElementById('histSearch').value.trim().toLowerCase();
    const rows = histTrains.filter((t) => !q ||
      [t.line, t.direction, t.station, t.operator, t.product]
        .some((x) => (x ?? '').toLowerCase().includes(q)));
    document.querySelector('#histTable tbody').innerHTML = rows.slice(0, 300).map((t) => `
      <tr>
        <td><strong>${esc(t.line)}</strong><br><small style="color:var(--text-muted)">${esc(t.product)}</small></td>
        <td>${esc(t.direction)}</td>
        <td>${esc(t.station ?? '–')}</td>
        <td class="num">${t.planned ? (histMultiDay ? shortDateTime.format(new Date(t.planned)) : fmtTime(t.planned)) : '–'}</td>
        <td class="num">${t.cancelled ? '–' : fmtDelay(t.delay)}</td>
        <td class="num">${t.cancelled || t.maxDelay == null ? '–' : fmtDelay(t.maxDelay)}</td>
        <td><span class="badge ${t.status}">${STATUS_LABELS[t.status] ?? t.status}</span></td>
        <td><small>${esc(t.cause ?? '')}</small></td>
      </tr>`).join('');
    document.getElementById('histCount').textContent =
      rows.length === 0 ? 'Ingen tog matcher.' :
      `${rows.length.toLocaleString('da-DK')} tog${rows.length > 300 ? ' (viser de første 300)' : ''}.`;
  }

  async function histInit() {
    try {
      const [ri, rs] = await Promise.all([fetch('data/index.json'), fetch('data/stations.json')]);
      histIndex = ri.ok ? (await ri.json()).dates ?? [] : [];
      const stations = rs.ok ? await rs.json() : [];
      stationCoords = Object.fromEntries(stations.map((s) => [s.name, {lat: s.lat, lon: s.lon}]));
    } catch {
      histIndex = [];
    }
    if (!histIndex.length) {
      document.getElementById('histInfo').textContent =
        'Ingen historik endnu – dagsfilerne dukker op efter næste dataopdatering.';
      return;
    }
    const min = histIndex[0];
    const max = histIndex.at(-1);
    for (const el of [document.getElementById('histFrom'), document.getElementById('histTo')]) {
      el.min = min;
      el.max = max;
    }
    // delbart link: ?fra=ÅÅÅÅ-MM-DD&til=ÅÅÅÅ-MM-DD
    const params = new URLSearchParams(location.search);
    const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
    histFrom = valid(params.get('fra')) ? params.get('fra') : max;
    histTo = valid(params.get('til')) ? params.get('til') : histFrom;
    await histApply();
  }

  document.getElementById('histFrom').addEventListener('change', (e) => {
    if (e.target.value) { histFrom = e.target.value; histApply(); }
  });
  document.getElementById('histTo').addEventListener('change', (e) => {
    if (e.target.value) { histTo = e.target.value; histApply(); }
  });
  document.getElementById('histPrev').addEventListener('click', () => {
    const span = datesBetween(histFrom, histTo).length;
    histFrom = shiftDate(histFrom, -span);
    histTo = shiftDate(histTo, -span);
    histApply();
  });
  document.getElementById('histNext').addEventListener('click', () => {
    const span = datesBetween(histFrom, histTo).length;
    histFrom = shiftDate(histFrom, span);
    histTo = shiftDate(histTo, span);
    histApply();
  });
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!histIndex.length) return;
      const n = Number(btn.dataset.days);
      histTo = histIndex.at(-1);
      histFrom = n === 0 ? histIndex[0] : shiftDate(histTo, -(n - 1));
      histApply();
    });
  });
  document.getElementById('histSearch').addEventListener('input', renderHistTable);
  document.getElementById('histCsv').addEventListener('click', exportCsv);

  // ---------- tabelvisning af dagsdata ----------

  function renderDayTable() {
    const tbody = document.querySelector('#dayTable tbody');
    tbody.innerHTML = (stats?.days ?? []).slice().reverse().map((d) => `
      <tr>
        <td>${d.date}</td>
        <td class="num">${d.total}</td>
        <td class="num">${d.tiltiden}</td>
        <td class="num">${d.foertid}</td>
        <td class="num">${d.forsinket}</td>
        <td class="num">${d.aflyst}</td>
        <td class="num">${pct(d.punctuality)}</td>
        <td class="num">${fmtDelay(d.avgDelay)}</td>
      </tr>`).join('');
  }

  // ---------- init ----------

  async function load() {
    try {
      [latest, stats] = await Promise.all([
        fetch('data/latest.json').then((r) => (r.ok ? r.json() : null)),
        fetch('data/stats.json').then((r) => (r.ok ? r.json() : null)),
      ]);
    } catch {
      /* håndteres nedenfor */
    }
    if (!latest && !stats) {
      document.getElementById('updated').textContent =
        'Ingen data endnu – første datakørsel er ikke gennemført.';
      return;
    }
    document.getElementById('updated').textContent =
      `Senest opdateret: ${dateTimeFmt.format(new Date(latest?.generatedAt ?? stats.generatedAt))} · opdaterer automatisk hver time`;
    document.getElementById('tips').innerHTML =
      (stats?.tips ?? []).map((t) => `<li>${esc(t)}</li>`).join('') || '<li class="notice">Ikke nok data endnu.</li>';
    renderKpis();
    renderTable();
    renderDayTable();
    renderCharts();
  }

  document.getElementById('search').addEventListener('input', renderTable);
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      statusFilter = chip.dataset.status;
      document.querySelectorAll('.chip').forEach((ch) =>
        ch.setAttribute('aria-pressed', String(ch === chip)));
      renderTable();
    });
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    renderCharts();
    renderHistCharts();
    setTiles();
  });

  load();
  histInit();
})();
