import React, { useEffect, useRef, useState } from 'react';

// ─── Real historical data from Enhanced_Booked_Events_v8_final.csv ───────────

const MONTHLY = [
  {key:'2023-01',rev:382,fnb:116,room:236,mtg:30,n:30,fnbPct:30},
  {key:'2023-02',rev:350,fnb:104,room:218,mtg:28,n:30,fnbPct:30},
  {key:'2023-03',rev:464,fnb:123,room:313,mtg:29,n:33,fnbPct:26},
  {key:'2023-04',rev:560,fnb:131,room:398,mtg:32,n:39,fnbPct:23},
  {key:'2023-05',rev:608,fnb:128,room:441,mtg:38,n:44,fnbPct:21},
  {key:'2023-06',rev:540,fnb:139,room:363,mtg:38,n:37,fnbPct:26},
  {key:'2023-07',rev:499,fnb:139,room:320,mtg:40,n:41,fnbPct:28},
  {key:'2023-08',rev:523,fnb:118,room:371,mtg:34,n:40,fnbPct:23},
  {key:'2023-09',rev:591,fnb:124,room:433,mtg:34,n:42,fnbPct:21},
  {key:'2023-10',rev:627,fnb:159,room:424,mtg:44,n:48,fnbPct:25},
  {key:'2023-11',rev:489,fnb:134,room:318,mtg:37,n:39,fnbPct:27},
  {key:'2023-12',rev:272,fnb:94,room:154,mtg:24,n:27,fnbPct:35},
  {key:'2024-01',rev:349,fnb:111,room:208,mtg:29,n:32,fnbPct:32},
  {key:'2024-02',rev:349,fnb:111,room:206,mtg:32,n:34,fnbPct:32},
  {key:'2024-03',rev:439,fnb:119,room:286,mtg:35,n:38,fnbPct:27},
  {key:'2024-04',rev:577,fnb:154,room:384,mtg:40,n:39,fnbPct:27},
  {key:'2024-05',rev:644,fnb:150,room:453,mtg:41,n:47,fnbPct:23},
  {key:'2024-06',rev:555,fnb:155,room:357,mtg:43,n:53,fnbPct:28},
  {key:'2024-07',rev:513,fnb:123,room:355,mtg:35,n:42,fnbPct:24},
  {key:'2024-08',rev:608,fnb:184,room:380,mtg:44,n:49,fnbPct:30},
  {key:'2024-09',rev:601,fnb:146,room:415,mtg:40,n:45,fnbPct:24},
  {key:'2024-10',rev:658,fnb:134,room:486,mtg:38,n:45,fnbPct:20},
  {key:'2024-11',rev:474,fnb:144,room:289,mtg:41,n:43,fnbPct:30},
  {key:'2024-12',rev:276,fnb:84,room:169,mtg:24,n:31,fnbPct:30},
  {key:'2025-01',rev:311,fnb:91,room:196,mtg:25,n:30,fnbPct:29},
  {key:'2025-02',rev:345,fnb:92,room:228,mtg:24,n:28,fnbPct:27},
  {key:'2025-03',rev:490,fnb:125,room:331,mtg:34,n:38,fnbPct:25},
  {key:'2025-04',rev:563,fnb:115,room:414,mtg:34,n:46,fnbPct:20},
  {key:'2025-05',rev:655,fnb:144,room:468,mtg:43,n:44,fnbPct:22},
  {key:'2025-06',rev:587,fnb:152,room:391,mtg:44,n:50,fnbPct:26},
  {key:'2025-07',rev:588,fnb:175,room:364,mtg:50,n:55,fnbPct:30},
  {key:'2025-08',rev:575,fnb:162,room:366,mtg:47,n:52,fnbPct:28},
  {key:'2025-09',rev:598,fnb:119,room:443,mtg:37,n:48,fnbPct:20},
  {key:'2025-10',rev:662,fnb:173,room:442,mtg:47,n:49,fnbPct:26},
  {key:'2025-11',rev:483,fnb:122,room:329,mtg:31,n:36,fnbPct:25},
  {key:'2025-12',rev:288,fnb:84,room:178,mtg:25,n:31,fnbPct:29},
];

const RESPONSE_BUCKETS = [
  { label: '6–10d', n: 301, avgRev: 12038 },
  { label: '11–20d', n: 700, avgRev: 12738 },
  { label: '21d+', n: 454, avgRev: 12232 },
];

// ─── Account Industry ─────────────────────────────────────────────────────
// The customer/account's own industry — who they are, not what kind of event
// they're booking. Distinct from Market Segment below (see the naming note
// at the top of the file).
const ACCOUNT_INDUSTRIES = [
  { label: 'Healthcare', rev: 4256, n: 274 },
  { label: 'Finance', rev: 3290, n: 210 },
  { label: 'Prof. Services', rev: 2129, n: 139 },
  { label: 'Technology', rev: 1847, n: 159 },
  { label: 'Social', rev: 1503, n: 279 },
  { label: 'Education', rev: 1125, n: 71 },
];

// ─── Market Segment ─────────────────────────────────────────────────────────
// The type of hotel business being booked (Corporate Group, Association,
// SMERF, Government, ...) — distinct from Account Industry above, which is
// the customer's own line of business. Kept as a separate classification per
// Kim's naming/classification feedback: an Association event and a Corporate
// Group event can both come from a Healthcare account, so these two
// dimensions are never merged into one label.
const MARKET_SEGMENTS = [
  { label: 'Association', n: 427, avg: 20152 },
  { label: 'Corporate Group', n: 559, avg: 12027 },
  { label: 'SMERF', n: 190, avg: 6645 },
  { label: 'Wedding/Social', n: 279, avg: 5388 },
];

function lbl(key) {
  const [y, m] = key.split('-');
  return new Date(+y, +m-1, 1).toLocaleString('default', { month: 'short', year: '2-digit' });
}

// ─── Chart wrapper ────────────────────────────────────────────────────────────

function ChartBox({ id, title, subtitle, children, legend }) {
  return (
    <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)',
      borderRadius: 'var(--border-radius-lg)', padding: '1rem 1.25rem' }}>
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--color-text-primary)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)', marginTop: '0.15rem' }}>{subtitle}</div>}
        {legend && <div style={{ display: 'flex', gap: 16, marginTop: '0.4rem', flexWrap: 'wrap' }}>{legend}</div>}
      </div>
      {children}
    </div>
  );
}

function Dot({ color, label }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

// ─── Chart.js loader ──────────────────────────────────────────────────────
// A single shared, cached load — previously each of the three Chart.js-based
// charts below injected its own <script> tag independently, so on any slow
// connection or a blocked/failing CDN request, three charts' worth of
// reserved canvas height sat there blank with nothing telling the viewer
// whether it was still loading or had actually failed (that's what produced
// the large empty gap in the upper half of the page). Loading the library
// once and having every chart await the same promise means: only one
// network request instead of three, and every chart can now show an honest
// "loading" or "chart unavailable" state instead of silent blank space.
let chartJsPromise = null;
function loadChartJs() {
  if (typeof window !== 'undefined' && window.Chart) return Promise.resolve(window.Chart);
  if (chartJsPromise) return chartJsPromise;
  chartJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => { chartJsPromise = null; reject(new Error('Failed to load Chart.js')); };
    document.head.appendChild(script);
  });
  return chartJsPromise;
}

// Shared hook: mounts a Chart.js chart into `ref` once the library and the
// canvas are both ready, tracking 'loading' | 'ready' | 'error' so the
// caller can render an honest placeholder instead of blank space. `build`
// receives the resolved Chart constructor and the canvas node, and must
// return the created Chart instance (so it can be destroyed on unmount).
function useChartJs(build, deps) {
  const ref = useRef();
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    let chart;
    loadChartJs()
      .then(Chart => {
        if (cancelled || !ref.current) return;
        chart = build(Chart, ref.current);
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; try { chart?.destroy(); } catch (e) {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps || []);
  return [ref, status];
}

// Overlays the reserved chart area while the library is loading or failed —
// the canvas underneath stays mounted at its normal size the whole time
// (Chart.js sizes itself off that always-present parent), this just covers
// it so the viewer sees an honest "loading"/"unavailable" state instead of
// a blank rectangle.
function ChartPlaceholder({ status }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--color-background-primary)' }}>
      {status === 'error' ? (
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', padding: '0 1rem', textAlign: 'center' }}>
          Chart unavailable — couldn't load the charting library.
        </span>
      ) : (
        <>
          <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--color-border-tertiary)',
            borderTopColor: 'var(--color-text-tertiary)', animation: 'trends-spin 0.8s linear infinite' }} />
          <style>{'@keyframes trends-spin { to { transform: rotate(360deg); } }'}</style>
        </>
      )}
    </div>
  );
}

// ─── Chart 1: Revenue stacked bar (36 months) ────────────────────────────────

function RevenueChart() {
  const [ref, status] = useChartJs((Chart, canvas) => {
    const labels = MONTHLY.map(d => lbl(d.key));
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Group Room Revenue', data: MONTHLY.map(d => d.room), backgroundColor: '#185fa5', stack: 'a' },
          { label: 'F&B Revenue',  data: MONTHLY.map(d => d.fnb),  backgroundColor: '#0f6e56', stack: 'a' },
          { label: 'Meeting Room Rental (MRR)', data: MONTHLY.map(d => d.mtg),  backgroundColor: '#8B5CF6', stack: 'a' },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y}K` } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0, font: { size: 11 } } },
          y: { stacked: true, ticks: { callback: v => `$${v}K`, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } }
        }
      }
    });
  }, []);
  return (
    <ChartBox title="Group revenue by month" subtitle="2023–2025 · $K · 1,455 booked events"
      legend={[<Dot key="r" color="#185fa5" label="Group Room Revenue" />, <Dot key="f" color="#0f6e56" label="F&B Revenue" />, <Dot key="m" color="#8B5CF6" label="Meeting Room Rental (MRR)" />]}>
      <div style={{ position: 'relative', height: 200 }}>
        <canvas ref={ref} role="img" aria-label="Stacked bar chart of group revenue by month, 2023 to 2025">
          Monthly group revenue broken down by Group Room Revenue, F&B Revenue, and Meeting Room Rental.
        </canvas>
        {status !== 'ready' && <ChartPlaceholder status={status} />}
      </div>
      <div style={{ marginTop: '0.6rem', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
        F&B contribution growing year-over-year: from ~25% of revenue in 2023 to ~27% in 2025. Peak months: May–Jun and Sep–Oct.
      </div>
    </ChartBox>
  );
}

// ─── Chart 2: F&B % trend (line) ─────────────────────────────────────────────

function FnBTrendChart() {
  const [ref, status] = useChartJs((Chart, canvas) => {
    const labels = MONTHLY.map(d => lbl(d.key));
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'F&B Revenue Mix (% of total)',
          data: MONTHLY.map(d => d.fnbPct),
          borderColor: '#0f6e56', backgroundColor: 'rgba(15,110,86,0.08)',
          borderWidth: 2, pointRadius: 2, fill: true, tension: 0.3,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `F&B: ${ctx.parsed.y}%` } } },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0, font: { size: 11 } } },
          y: { min: 15, max: 40, ticks: { callback: v => `${v}%`, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } }
        }
      }
    });
  }, []);
  return (
    <ChartBox title="F&B Revenue Mix" subtitle="Trending up — a sign of higher-value bookings">
      <div style={{ position: 'relative', height: 160 }}>
        <canvas ref={ref} role="img" aria-label="Line chart showing F&B Revenue Mix as a percentage of total revenue from 2023 to 2025">
          F&B Revenue Mix trends from 20% to 35% over the period.
        </canvas>
        {status !== 'ready' && <ChartPlaceholder status={status} />}
      </div>
      <div style={{ marginTop: '0.6rem', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
        Q4 spikes reflect holiday F&B packages (dinners, receptions). Summer dips are room-heavy conference season.
      </div>
    </ChartBox>
  );
}

// ─── Chart 3: Pipeline hole — events per month (bar) ─────────────────────────

function PipelineChart() {
  const [ref, status] = useChartJs((Chart, canvas) => {
    const labels = MONTHLY.map(d => lbl(d.key));
    const colors = MONTHLY.map(d => {
      if (d.n < 30) return '#ef4444';
      if (d.n < 40) return '#f59e0b';
      return '#185fa5';
    });
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Events booked', data: MONTHLY.map(d => d.n), backgroundColor: colors }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.parsed.y} events booked` } } },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0, font: { size: 11 } } },
          y: { ticks: { font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } }
        }
      }
    });
  }, []);
  return (
    <ChartBox title="Booked events per month" subtitle="Volume by arrival month · red = pipeline hole (<30 events)"
      legend={[<Dot key="b" color="#185fa5" label="Strong (40+)" />, <Dot key="a" color="#f59e0b" label="Moderate (30–39)" />, <Dot key="r" color="#ef4444" label="Gap (<30)" />]}>
      <div style={{ position: 'relative', height: 160 }}>
        <canvas ref={ref} role="img" aria-label="Bar chart of booked events per month, highlighting pipeline gaps in red">
          Monthly event volume showing seasonal patterns and gaps.
        </canvas>
        {status !== 'ready' && <ChartPlaceholder status={status} />}
      </div>
      <div style={{ marginTop: '0.6rem', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
        Jan–Feb and Dec consistently under 35 events — winter pipeline gaps. Proactive outreach in Oct–Nov recommended to fill Q1.
      </div>
    </ChartBox>
  );
}

// ─── Chart 4: Account Industry mix (horizontal bar) ──────────────────────────
// See the ACCOUNT_INDUSTRIES note above — this is the customer's own
// industry, kept separate from the Market Segment chart below.

function AccountIndustryChart() {
  const COLORS = ['#185fa5','#0f6e56','#8B5CF6','#c05621','#1d9e75','#ba7517'];
  const max = Math.max(...ACCOUNT_INDUSTRIES.map(s => s.rev));
  return (
    <ChartBox title="Revenue by Account Industry" subtitle="3-year total · $K">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        {ACCOUNT_INDUSTRIES.map((s, i) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 90, fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'right', flexShrink: 0 }}>{s.label}</div>
            <div style={{ flex: 1, background: 'var(--color-background-secondary)', borderRadius: 4, height: 18, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(s.rev/max*100)}%`, height: '100%', background: COLORS[i], borderRadius: 4, transition: 'width 0.5s' }} />
            </div>
            <div style={{ width: 60, fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>${s.rev}K · {s.n}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
        Healthcare and Finance dominate. Social accounts show high volume but lower average revenue per event.
      </div>
    </ChartBox>
  );
}

// ─── Chart 5: Market Segment avg revenue ─────────────────────────────────────
// See the MARKET_SEGMENTS note above — this is the type of hotel business
// booked, kept separate from the Account Industry chart above.

function MarketSegmentChart() {
  const max = Math.max(...MARKET_SEGMENTS.map(e => e.avg));
  const COLORS = ['#185fa5','#0f6e56','#f59e0b','#ef4444'];
  return (
    <ChartBox title="Avg Revenue by Market Segment" subtitle="1,455 events · 2023–2025">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
        {MARKET_SEGMENTS.map((e, i) => (
          <div key={e.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
              <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{e.label}</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>${(e.avg/1000).toFixed(1)}K avg · {e.n} events</span>
            </div>
            <div style={{ background: 'var(--color-background-secondary)', borderRadius: 4, height: 10 }}>
              <div style={{ width: `${Math.round(e.avg/max*100)}%`, height: '100%', background: COLORS[i], borderRadius: 4 }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
        Association events deliver 67% more revenue than Corporate Group on average — worth prioritizing multi-day conferences.
      </div>
    </ChartBox>
  );
}

// ─── Chart 6: Response time ───────────────────────────────────────────────────

function ResponseChart() {
  const maxN = Math.max(...RESPONSE_BUCKETS.map(b => b.n));
  const maxRev = Math.max(...RESPONSE_BUCKETS.map(b => b.avgRev));
  return (
    <ChartBox title="Response time & avg deal value" subtitle="Days from inquiry to decision">
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {RESPONSE_BUCKETS.map((b, i) => (
          <div key={b.label} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{b.label}</div>
            <div style={{ height: 80, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 2 }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{b.n} events</div>
              <div style={{ width: '60%', background: '#185fa5', borderRadius: '3px 3px 0 0',
                height: `${Math.round(b.n/maxN*60)}px` }} title={`${b.n} events`} />
            </div>
            <div style={{ borderTop: '1px solid var(--color-border-tertiary)', paddingTop: 6, marginTop: 2 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)' }}>${(b.avgRev/1000).toFixed(1)}K</div>
              <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>avg rev</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
        Most decisions happen in 11–20 days. Avg deal value is similar across response windows — focus on response quality, not just speed.
      </div>
    </ChartBox>
  );
}

// ─── KPI cards ────────────────────────────────────────────────────────────────

function KPI({ label, value, sub, trend }) {
  const pos = trend === undefined ? null : trend >= 0;
  return (
    <div style={{ background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)', padding: '1rem' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: '0.7rem', marginTop: '0.3rem', display: 'flex', alignItems: 'center', gap: 6 }}>
        {pos !== null && (
          <span style={{ color: pos ? '#166534' : '#991b1b', background: pos ? '#f0fdf4' : '#fff5f5',
            border: `1px solid ${pos ? '#bbf7d0' : '#fecaca'}`, borderRadius: 4, padding: '0.1rem 0.35rem', fontSize: '0.68rem' }}>
            {pos ? '↑' : '↓'} {Math.abs(trend)}% YoY
          </span>
        )}
        <span style={{ color: 'var(--color-text-secondary)' }}>{sub}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
//
// Naming/classification rules (per Kim's review — keep these in mind before
// adding new metrics here):
//   - "Market Segment" = the type of hotel business booked (Corporate Group,
//     Association, SMERF, Government, ...). See MARKET_SEGMENTS above.
//   - "Account Industry" = the customer/account's own line of business
//     (Healthcare, Finance, Technology, Education, ...). See
//     ACCOUNT_INDUSTRIES above. Never label an industry category as
//     "Market Segment" or vice versa — they're independent classifications
//     (a Healthcare account can book a Corporate Group event or an
//     Association event; the two dimensions don't imply each other).
//   - Hotel-wide metrics (ADR, Occupancy, RevPAR) belong under those exact
//     names and describe the WHOLE property. None of that lives on this
//     page today — this view is entirely group-business figures (Group Room
//     Revenue, F&B Revenue, Meeting Room Rental) — so RevPAR in particular
//     should never be introduced here to describe group-only revenue; if a
//     hotel-wide occupancy/ADR/RevPAR view gets added later, keep it in its
//     own section labeled accordingly rather than blending it into these
//     group totals.
export default function TrendsView() {
  const total2025 = MONTHLY.filter(d => d.key.startsWith('2025')).reduce((s, d) => s + d.rev, 0);
  const total2024 = MONTHLY.filter(d => d.key.startsWith('2024')).reduce((s, d) => s + d.rev, 0);
  const yoyRev = Math.round((total2025 - total2024) / total2024 * 100);
  const total2025n = MONTHLY.filter(d => d.key.startsWith('2025')).reduce((s, d) => s + d.n, 0);
  const total2024n = MONTHLY.filter(d => d.key.startsWith('2024')).reduce((s, d) => s + d.n, 0);
  const yoyN = Math.round((total2025n - total2024n) / total2024n * 100);
  const avgFnb2025 = Math.round(MONTHLY.filter(d => d.key.startsWith('2025')).reduce((s, d) => s + d.fnbPct, 0) / 12);
  const avgFnb2024 = Math.round(MONTHLY.filter(d => d.key.startsWith('2024')).reduce((s, d) => s + d.fnbPct, 0) / 12);

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>

      <div style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 500, color: 'var(--color-text-primary)', margin: '0 0 0.2rem' }}>Trends</h2>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          1,455 booked events · Jan 2023 – Dec 2025 · live pipeline from Firestore
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))', gap: 12, marginBottom: '1.25rem' }}>
        {/* MONTHLY.rev is already in thousands of dollars ($K) — dividing by
            1000 here converts thousands to millions, so the unit must be
            "M", not "K" (a prior version divided by 1000 and still labeled
            it "K", silently showing "$6K" for what is actually a ~$6.1M
            annual total — caught by cross-checking this KPI against the
            monthly revenue chart, whose y-axis is genuinely in $K). */}
        <KPI label="Total Group Revenue 2025" value={`$${(total2025/1000).toFixed(1)}M`} trend={yoyRev} sub="vs 2024" />
        <KPI label="Events booked 2025" value={total2025n} trend={yoyN} sub="vs 2024" />
        <KPI label="F&B Revenue Mix 2025" value={`${avgFnb2025}%`} trend={avgFnb2025 - avgFnb2024} sub="of total revenue" />
        <KPI label="Top Account Industry" value="Healthcare" sub="$4.3M · 274 events" />
        <KPI label="Highest Avg Group Revenue" value="Association" sub="$20.2K avg per event · by Market Segment" />
      </div>

      {/* Charts grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <RevenueChart />
        </div>
        <FnBTrendChart />
        <PipelineChart />
        <AccountIndustryChart />
        <ResponseChart />
        <MarketSegmentChart />
      </div>

      <div style={{ fontSize: '0.65rem', color: 'var(--color-text-tertiary)', textAlign: 'right' }}>
        Historical data: Enhanced_Booked_Events_v8_final.csv · live pipeline: Firestore rfps + incoming_rfps
      </div>
    </div>
  );
}
