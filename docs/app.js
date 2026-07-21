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
    charts.push(new Chart(document.getElementById('chartDays'), {
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
        }],
      },
      options: baseOptions(c, {percentAxis: true}),
    }));

    // 3) Punktlighed pr. time – søjler
    const hours = stats.byHour.filter((h) => h.total >= 5 && h.punctuality != null);
    charts.push(new Chart(document.getElementById('chartHours'), {
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
    charts.push(new Chart(document.getElementById('chartProducts'), {
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
    charts.push(new Chart(document.getElementById('chartLines'), {
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
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCharts);

  load();
})();
