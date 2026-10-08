import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../firebase';

const safeFmt = (v) => {
  const n = Number(v);
  return isNaN(n) ? '$0' : '$' + Math.round(n).toLocaleString();
};
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { RefreshCw, Zap, BarChart3, Settings2, Play, ArrowLeft, ChevronRight, Check } from 'lucide-react';
import { loadModel, predictStrategies, initPyodide } from '../modelLoader';
import {
  buildContext,
  runNegotiation,
  estimatePareto,
  agreementToStrategy,
  issueNorm,
  DEFAULT_CONFIG,
} from './negotiationEngine';
import './Strategies.css';
import { XGBOOST_TREES } from '../xgboost_trees_data_v7.js';
import { useMarketSignals, SIGNAL_DEFAULTS, useHotelConfig, CONFIG_DEFAULTS } from '../marketSignals';

// ─── JS XGBoost engine (mirrors RankingView — no Pyodide needed) ─────────────

function evalTree(nodes, features) {
  let node = nodes[0];
  while (Array.isArray(node) && node.length === 4) {
    const [fIdx, threshold, yes, no] = node;
    const val = features[fIdx];
    node = nodes[(val === null || val === undefined || isNaN(val) || val >= threshold) ? no : yes];
  }
  return Array.isArray(node) ? node[0] : node;
}
function xgbPredict(model, feats) {
  let s = model.b;
  for (const t of model.t) s += evalTree(t, feats);
  return s;
}
function predictSingle(name, dict) {
  const m = XGBOOST_TREES?.[name];
  if (!m) return null;
  return xgbPredict(m, m.f.map(f => dict[f] ?? 0));
}
const sigmoid = x => 1 / (1 + Math.exp(-x));

const SEASON_MAP   = { 12:0,1:0,2:0, 3:1,4:1,5:1, 6:2,7:2,8:2, 9:3,10:3,11:3 };
const BASELINE_ADR = 164;
const cosMonth = m => Math.cos(2 * Math.PI * m / 12);
const sinMonth = m => Math.sin(2 * Math.PI * m / 12);
const sinQ     = m => Math.sin(2 * Math.PI * Math.ceil(m / 3) / 4);

// Returns { pickup_rate, conversion_prob, fnb_per_person, baseline_adr }
// Uses pickup_ipw (selection-bias-corrected) as the pickup model.
function runJSXGBoost(rfp, signals = SIGNAL_DEFAULTS, config = CONFIG_DEFAULTS) {
  const arrival   = new Date(rfp.arrival_date);
  const departure = new Date(rfp.departure_date);
  const inquiry   = new Date(rfp.inquiry_date || Date.now());
  const nights    = Math.max(1, Math.round((departure - arrival) / 86400000));
  const leadTime  = Math.max(0, Math.round((arrival - inquiry)  / 86400000));
  const month     = arrival.getMonth() + 1;
  const season    = SEASON_MAP[month] ?? 2;
  const roomBlock = Number(rfp.room_block || 50);
  const attendees = Number(rfp.attendees  || roomBlock * 1.4);
  const trn       = roomBlock * nights;
  const hasMtgNum = Number(rfp.has_meeting_space || 0);

  let occPct = Number(rfp.forecasted_occupancy || 0.72);
  if (occPct <= 1) occPct *= 100;

  const dayOfYear = Math.floor((arrival - new Date(arrival.getFullYear(), 0, 0)) / 86400000);
  const dtsPeak   = Math.min(Math.abs(dayOfYear - 75), Math.abs(dayOfYear - 258));
  const isShoulderSeason = (season === 1 || season === 3) ? 1 : 0;

  const bf = {
    arrival_month_cos:   cosMonth(month),
    arrival_month_sin:   sinMonth(month),
    arrival_quarter_sin: sinQ(month),
    total_room_nights:        trn,
    Rooms_Available_Peak_Date: Math.max(0, 220 - roomBlock),
    Meeting_Space_Ratio:      hasMtgNum ? Math.min(2.0, 10 / Math.max(1, roomBlock)) : 0,
    on_books_occupancy_pct: occPct,
    avg_room_utilization:   occPct / 100,
    days_to_peak_season: Math.min(132, dtsPeak),
    is_shoulder_season:  isShoulderSeason,
    pricing_pressure_index: occPct > 80 ? 1.4 : occPct > 65 ? 1.1 : 0.95,
    rate_spread:            BASELINE_ADR * 0.10,
    Flag_Rate_Below_Baseline: 0,
    fnb_ratio: hasMtgNum ? 0.40 : 0.10,
    Displacement_Risk_Score:     occPct > 75 ? 0.65 : 0.30,
    displacement_ratio:          Math.min(0.30, occPct / 100 * 0.25),
    capacity_pressure_score:     Math.min(0.25, occPct / 100 * 0.22),
    displacement_velocity_30_90d: signals.displacement_velocity_30_90d,
    displacement_acceleration:    signals.displacement_acceleration,
    avg_discount_nearby_30d: signals.avg_discount_nearby_30d,
    rfp_volume_acceleration:  signals.rfp_volume_acceleration,
    occupancy_velocity_30_90d: signals.occupancy_velocity_30_90d,
    smerf_demand_30d: signals.smerf_demand_30d,
    booking_pace_7_30d: signals.booking_pace_7_30d,
    revenue_velocity_30_90d: signals.revenue_velocity_30_90d,
    revenue_acceleration: signals.revenue_acceleration,
    win_streak: 3,
    win_rate_velocity_30_90d: signals.win_rate_velocity_30_90d,
    business_momentum_score: 0.50,
    Urgency_Index: Math.max(0.01, Math.min(0.20, (365 - leadTime) / 3650)),
    budget_amount: Math.min(65000, trn * BASELINE_ADR * 0.85),
    Account_Prior_Booked: 8,
    competing_rfps_same_week_segment: 4,
    arrival_clustering_score: 0.07,
    days_since_last_segment_rfp: 7,
    days_since_last_account_rfp: 25,
    destinations_considered: 2,
    lead_source_encoded: 2,
  };

  // pickup_ipw: IPW-corrected model — use this instead of plain 'pickup'
  const pickupRaw = predictSingle('pickup_ipw', bf);
  const convRaw   = predictSingle('conversion', bf);
  const fnbRaw    = predictSingle('fnb', bf);

  const pickup = pickupRaw !== null
    ? Math.min(0.98, Math.max(0.35, sigmoid(pickupRaw)))
    : 0.79;
  const conv = convRaw !== null
    ? Math.min(0.98, Math.max(0.15, sigmoid(convRaw)))
    : 0.65;
  const fnbPP = Math.max(hasMtgNum ? 25 : 20, fnbRaw ?? 60);

  return {
    baseline_adr:    Math.round(BASELINE_ADR),
    pickup_rate:     pickup,
    conversion_prob: conv,
    fnb_per_person:  Math.round(fnbPP),
    room_nights:     trn,
    // meeting_space_base: total space revenue at standard config rate for this group
    meeting_space_base: hasMtgNum
      ? rfp.room_block * config.meeting_rate_per_room_night * Math.max(1, Math.round((new Date(rfp.departure_date) - new Date(rfp.arrival_date)) / 86400000))
      : 0,
  };
}

// Build the three strategy cards from JS XGBoost predictions
function buildJSStrategies(rfp, preds, nights) {
  const { baseline_adr, pickup_rate, conversion_prob, fnb_per_person, meeting_space_base } = preds;
  const baseFnb   = rfp.attendees * fnb_per_person;
  const baseSpace = meeting_space_base;

  // Displacement cost: what transient revenue this group displaces
  const occ = Number(rfp.forecasted_occupancy || 0.72);
  const occNorm = occ > 1 ? occ / 100 : occ;
  const BASELINE_ADR_DISP = 164;
  const DISP_FACTOR = 0.28;

  const make = (name, risk, color, adrMult, pickupMult, convMult, fnbMult, spaceMult, recommended, includes, subtitle) => {
    const adr       = Math.round(baseline_adr * adrMult);
    const pickup    = Math.min(0.99, pickup_rate * pickupMult);
    const conv      = Math.min(0.99, conversion_prob * convMult);
    const roomRev   = Math.round(adr * rfp.room_block * nights * pickup);
    // Realistic F&B: minimum $35/person for meeting groups, $18 for room-only
    const fnbPPFloor = rfp.has_meeting_space ? 35 : 18;
    const fnbRevRaw  = Math.round(baseFnb * fnbMult);
    const fnbRev     = Math.max(fnbRevRaw, Math.round(fnbPPFloor * (rfp.attendees || rfp.room_block * 1.4) * fnbMult));
    const spaceRev  = Math.round(baseSpace * spaceMult);
    const totalRev  = roomRev + fnbRev + spaceRev;
    // Displacement cost — only meaningful when occupancy is high
    const dispCost  = Math.round(BASELINE_ADR_DISP * rfp.room_block * nights * DISP_FACTOR * occNorm);
    const netRev    = totalRev - dispCost;
    // Profit: ~44% margin on net, floored at 0 for display
    const profit    = Math.max(0, Math.round(netRev * 0.44));
    const roiPct    = Math.round((netRev / Math.max(1, BASELINE_ADR_DISP * rfp.room_block * nights) - 1) * 100);
    return {
      name, risk, color, adr,
      pickupRate:     Math.round(pickup * 100),
      conversionProb: Math.round(conv * 100),
      gviIndex:       Math.round(totalRev / 1000),
      roomRevenue:    roomRev,
      fnbRevenue:     fnbRev,
      spaceRevenue:   spaceRev,
      totalRevenue:   totalRev,
      dispCost,
      expectedProfit: profit,
      riskAdjustedValue: Math.round(profit * conv),
      roiVsBaseline:  (roiPct >= 0 ? '+' : '') + roiPct + '%',
      recommended,
      includes,
      subtitle,
    };
  };

  return [
    make('Conservative Capture', 'Low Risk',    'success', 0.93, 1.08, 1.12, 0.90, 1.00, false,
      ['3 comp rooms', `$30/person F&B credit`, '50% space discount', 'Free WiFi', 'Late checkout', 'Welcome reception'],
      'Select Conservative Strategy'),
    make('Optimal Balance',      'Medium Risk', 'warning', 1.00, 1.00, 1.00, 1.00, 1.40, true,
      ['2 comp rooms', `$25/person F&B credit`, '30% space discount', 'Free WiFi', 'Welcome reception', 'Late checkout'],
      'Select Recommended Strategy'),
    make('Premium Position',     'Higher Risk', 'error',   1.15, 0.94, 0.88, 1.20, 1.70, false,
      ['1 comp room', `$20/person F&B credit`, '15% space discount', 'Free WiFi', 'Welcome amenity'],
      'Select Premium Strategy'),
  ];
}

// ─── SVG CHARTS ──────────────────────────────────────────────────────────────

function ParetoMiniChart({ history, pareto, width = 480, height = 320 }) {
  if (!history || history.length === 0) return null;
  const m = { t: 20, r: 20, b: 40, l: 50 };
  const w = width - m.l - m.r, h = height - m.t - m.b;
  const allH = history.map(d => d.hotelUtility).concat(pareto.map(d => d.h));
  const allC = history.map(d => d.clientUtility).concat(pareto.map(d => d.c));
  const xMin = Math.min(...allH) - 0.02, xMax = Math.max(...allH) + 0.02;
  const yMin = Math.min(...allC) - 0.02, yMax = Math.max(...allC) + 0.02;
  const sx = v => m.l + ((v - xMin) / (xMax - xMin || 1)) * w;
  const sy = v => m.t + h - ((v - yMin) / (yMax - yMin || 1)) * h;

  const accepted = history.filter(d => d.accepted);
  const rejected = history.filter(d => !d.accepted);
  const last = accepted[accepted.length - 1];
  const first = accepted[0];
  const aPath = accepted.map((d, i) => `${i === 0 ? 'M' : 'L'}${sx(d.hotelUtility)},${sy(d.clientUtility)}`).join(' ');
  const pPath = pareto.length > 1 ? pareto.map((d, i) => `${i === 0 ? 'M' : 'L'}${sx(d.h)},${sy(d.c)}`).join(' ') : '';

  return (
    <svg width={width} height={height} style={{ background: '#0c1322', borderRadius: 10 }}>
      {[0.25, 0.5, 0.75].map(f => (
        <React.Fragment key={f}>
          <line x1={m.l} y1={m.t + h * f} x2={m.l + w} y2={m.t + h * f} stroke="#1a2640" strokeWidth={0.5} />
          <line x1={m.l + w * f} y1={m.t} x2={m.l + w * f} y2={m.t + h} stroke="#1a2640" strokeWidth={0.5} />
        </React.Fragment>
      ))}
      <line x1={m.l} y1={m.t + h} x2={m.l + w} y2={m.t + h} stroke="#253050" />
      <line x1={m.l} y1={m.t} x2={m.l} y2={m.t + h} stroke="#253050" />
      <text x={m.l + w / 2} y={height - 5} textAnchor="middle" fill="#3b82f6" fontSize={10} fontWeight={600}>Hotel Utility →</text>
      <text transform="rotate(-90)" x={-(m.t + h / 2)} y={12} textAnchor="middle" fill="#10b981" fontSize={10} fontWeight={600}>Client Utility →</text>
      {pPath && <path d={pPath} fill="none" stroke="#f43f5e" strokeWidth={2} strokeDasharray="5,3" opacity={0.55} />}
      {rejected.map((d, i) => <circle key={`r${i}`} cx={sx(d.hotelUtility)} cy={sy(d.clientUtility)} r={1.2} fill="#475569" opacity={0.12} />)}
      {aPath && <path d={aPath} fill="none" stroke="#f59e0b" strokeWidth={1.5} opacity={0.35} />}
      {accepted.map((d, i) => (
        <circle key={`a${i}`} cx={sx(d.hotelUtility)} cy={sy(d.clientUtility)}
          r={i === accepted.length - 1 ? 5 : i === 0 ? 4 : 1.8}
          fill={i === accepted.length - 1 ? '#f59e0b' : i === 0 ? '#64748b' : '#f59e0b'}
          opacity={i === accepted.length - 1 ? 1 : 0.45}
          stroke={i === accepted.length - 1 ? '#fff' : 'none'} strokeWidth={2} />
      ))}
      {first && <text x={sx(first.hotelUtility) + 7} y={sy(first.clientUtility) + 3} fill="#64748b" fontSize={8} fontFamily="monospace">START</text>}
      {last && <text x={sx(last.hotelUtility) + 8} y={sy(last.clientUtility) + 3} fill="#f59e0b" fontSize={9} fontWeight={700} fontFamily="monospace">FINAL</text>}
      <line x1={width - 100} y1={13} x2={width - 86} y2={13} stroke="#f43f5e" strokeWidth={2} strokeDasharray="3,2" />
      <text x={width - 82} y={16} fill="#f43f5e" fontSize={7}>Pareto</text>
      <circle cx={width - 93} cy={26} r={3} fill="#f59e0b" />
      <text x={width - 82} y={29} fill="#f59e0b" fontSize={7}>Accepted</text>
    </svg>
  );
}

function TemperatureMiniChart({ history, width = 230, height = 80 }) {
  if (!history || history.length < 2) return null;
  const mg = { t: 6, r: 8, b: 6, l: 8 };
  const w = width - mg.l - mg.r, h = height - mg.t - mg.b;
  const maxT = Math.max(...history.map(d => d.temperature));
  const path = history.map((d, i) => {
    const x = mg.l + (i / (history.length - 1)) * w;
    const y = mg.t + h - (d.temperature / (maxT * 1.1)) * h;
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');
  const area = path + ` L${mg.l + w},${mg.t + h} L${mg.l},${mg.t + h} Z`;
  return (
    <svg width={width} height={height} style={{ borderRadius: 6 }}>
      <defs><linearGradient id="tGrad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#a855f7" stopOpacity={0.3} /><stop offset="100%" stopColor="#a855f7" stopOpacity={0.02} /></linearGradient></defs>
      <path d={area} fill="url(#tGrad)" /><path d={path} fill="none" stroke="#a855f7" strokeWidth={1.5} opacity={0.8} />
    </svg>
  );
}

// ─── NEGOTIATION PANEL ───────────────────────────────────────────────────────

const NegotiationPanel = ({ rfp, predictions, onApplyStrategy }) => {
  const [phase, setPhase] = useState('config');
  const [result, setResult] = useState(null);
  const [pareto, setPareto] = useState([]);
  const [negCtx, setNegCtx] = useState(null);
  const [animIdx, setAnimIdx] = useState(0);
  const [speed, setSpeed] = useState(8);
  const animRef = useRef(null);
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [bestOfN, setBestOfN] = useState(5);
  const [runSummary, setRunSummary] = useState(null); // { total, winner, scores }

  const nights = Math.ceil((new Date(rfp.departure_date) - new Date(rfp.arrival_date)) / (1000 * 60 * 60 * 24)) || 1;

  const runNeg = useCallback((singleRun = false) => {
    const ctx = buildContext(predictions, rfp);
    setNegCtx(ctx);
    setPhase('running');
    setAnimIdx(0);
    const p = estimatePareto(ctx);
    setPareto(p);

    const n = singleRun ? 1 : bestOfN;
    let bestRes = null;
    let bestSW = -Infinity;
    let bestIdx = 0;
    const scores = [];

    for (let i = 0; i < n; i++) {
      const res = runNegotiation(ctx, config);
      const sw = res.bestAgreement
        ? ctx.hotelUtility(res.bestAgreement) + ctx.clientUtility(res.bestAgreement)
        : 0;
      scores.push(sw);
      if (sw > bestSW) {
        bestSW = sw;
        bestRes = res;
        bestIdx = i;
      }
    }

    setResult(bestRes);
    setRunSummary(n > 1 ? { total: n, winner: bestIdx + 1, scores } : null);
  }, [predictions, rfp, config, bestOfN]);

  useEffect(() => {
    if (phase !== 'running' || !result) return;
    if (animIdx >= result.history.length) { setPhase('results'); return; }
    animRef.current = setTimeout(() => setAnimIdx(i => i + speed), 16);
    return () => clearTimeout(animRef.current);
  }, [phase, animIdx, result, speed]);

  const vis = result ? result.history.slice(0, Math.min(animIdx, result.history.length)) : [];
  const latest = vis.length > 0 ? vis[vis.length - 1] : null;
  const final = result?.bestAgreement;
  const accN = vis.filter(d => d.accepted).length;
  const annN = vis.filter(d => d.event === 'annealing_accept').length;
  const ovrN = vis.filter(d => d.event === 'hotel_override' || d.event === 'client_override').length;

  const handleApply = () => {
    if (!final || !negCtx) return;
    const strategy = agreementToStrategy(final, negCtx);
    onApplyStrategy(strategy);
  };

  const issues = negCtx?.issues || [];

  return (
    <div className="negotiation-panel">
      {/* Header */}
      <div className="neg-header">
        <div className="neg-header-left">
          <div className="neg-icon"><Zap size={16} /></div>
          <div>
            <div className="neg-title">Annealing Mediator Protocol</div>
            <div className="neg-subtitle">Klein, Faratin, Sayama & Bar-Yam · Revenue-calibrated</div>
          </div>
        </div>
        <div className="neg-header-actions">
          {phase === 'config' && (
            <button className="btn-negotiate" onClick={() => runNeg(false)}><Play size={14} /> Best of {bestOfN}</button>
          )}
          {phase === 'results' && (
            <>
              <button className="btn-back-small" onClick={() => { setPhase('config'); setResult(null); setAnimIdx(0); setRunSummary(null); }}><Settings2 size={14} /> Reconfigure</button>
              <button className="btn-back-small" onClick={() => runNeg(true)}><RefreshCw size={14} /> Re-run ×1</button>
              <button className="btn-negotiate" onClick={() => runNeg(false)}><Zap size={14} /> Best of {bestOfN}</button>
            </>
          )}
        </div>
      </div>

      {/* RFP + Predictions context */}
      <div className="neg-rfp-bar">
        <span className="neg-rfp-label">Negotiating:</span>
        <strong>{rfp.event_name}</strong>
        <span className="neg-rfp-sep">·</span>
        <span>{rfp.attendees} attendees</span>
        <span className="neg-rfp-sep">·</span>
        <span>{rfp.room_block} rooms</span>
        <span className="neg-rfp-sep">·</span>
        <span>{nights} nights</span>
        <span className="neg-rfp-sep">·</span>
        <span style={{ color: '#3b82f6' }}>ADR: ${Math.round(predictions.baseline_adr)}</span>
        <span className="neg-rfp-sep">·</span>
        <span style={{ color: '#10b981' }}>Pickup: {Math.round(predictions.pickup_rate * 100)}%</span>
        <span className="neg-rfp-sep">·</span>
        <span style={{ color: '#a855f7' }}>F&B: ${Math.round(predictions.fnb_per_person)}/pp</span>
        {negCtx?.leverage && (
          <>
            <span className="neg-rfp-sep">·</span>
            <span style={{ color: negCtx.leverage.demandPressure > 0.6 ? '#f43f5e' : negCtx.leverage.demandPressure > 0.35 ? '#f59e0b' : '#10b981' }}>
              Demand: {negCtx.leverage.demandPressure > 0.6 ? '🔥 High' : negCtx.leverage.demandPressure > 0.35 ? '⚖️ Normal' : '❄️ Low'}
              {' '}({(negCtx.leverage.demandPressure * 100).toFixed(0)}%)
            </span>
            <span className="neg-rfp-sep">·</span>
            <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
              Profile: {rfp.event_type || 'Corporate'}
            </span>
          </>
        )}
      </div>

      {/* CONFIG PHASE */}
      {phase === 'config' && (
        <div className="neg-config-grid">
          {/* Left: Model calibration info */}
          <div className="neg-config-section">
            <div className="neg-section-header">
              <div className="neg-dot" style={{ background: '#3b82f6' }} />
              <h4>Calibrated Issue Ranges</h4>
            </div>
            {(() => {
              const tempCtx = buildContext(predictions, rfp);
              const { issues: tempIssues, leverage: lev, profile: prof } = tempCtx;
              const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              const maxAdr = Math.max(...(lev?.monthlyAdrs || [160]));
              const minAdr = Math.min(...(lev?.monthlyAdrs || [160]));
              const currentMonth = new Date(rfp.arrival_date).getMonth();
              const fnbMarginPct = Math.round((1 - prof.fnb_cogs) * 100);
              return (
                <>
                  <p className="neg-config-hint">
                    Calibrated from 1,899 property events (2023-2025). {rfp.event_type || 'Corporate'} profile: F&B ${Math.round(prof.fnb_pp)}/pp avg, pickup {Math.round(prof.pickup * 100)}%.
                  </p>
                  {tempIssues.map(is => (
                    <div key={is.key} className="neg-issue-preview">
                      <span className="neg-slider-label">{is.label}</span>
                      <span className="neg-range-badge">
                        {is.type === 'binary' ? 'Yes / No' : `${is.unit === '€' ? '$' : ''}${is.min}${is.unit === '%' ? '%' : ''} – ${is.unit === '€' ? '$' : ''}${is.max}${is.unit === '%' ? '%' : ''}`}
                      </span>
                    </div>
                  ))}

                  <div className="neg-economics-box">
                    <h5>Seasonal Leverage (XGBoost sensitivity)</h5>
                    {lev ? (
                      <>
                        <div className="neg-leverage-bar-row">
                          <span className="neg-slider-label">Demand Pressure</span>
                          <div className="neg-leverage-track">
                            <div className="neg-leverage-fill" style={{
                              width: `${lev.demandPressure * 100}%`,
                              background: lev.demandPressure > 0.6 ? '#f43f5e' : lev.demandPressure > 0.35 ? '#f59e0b' : '#10b981',
                            }} />
                          </div>
                          <span className="neg-slider-value" style={{ color: lev.demandPressure > 0.6 ? '#f43f5e' : lev.demandPressure > 0.35 ? '#f59e0b' : '#10b981' }}>
                            {(lev.demandPressure * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="neg-monthly-adrs">
                          {lev.monthlyAdrs.map((adr, i) => {
                            const h = maxAdr > minAdr ? ((adr - minAdr) / (maxAdr - minAdr)) * 28 + 4 : 16;
                            return (
                              <div key={i} className={`neg-month-bar ${i === currentMonth ? 'current' : ''}`}>
                                <div className="neg-month-fill" style={{ height: h }} />
                                <span className="neg-month-label">{months[i][0]}</span>
                              </div>
                            );
                          })}
                        </div>
                        <p style={{ fontSize: '0.5625rem', color: '#94a3b8', marginTop: '0.25rem' }}>
                          This month: \${lev.currentAdr.toFixed(0)} ADR vs \${lev.annualAvgAdr.toFixed(0)} annual avg ({lev.adrLeverage > 1 ? '+' : ''}{((lev.adrLeverage - 1) * 100).toFixed(1)}%)
                        </p>
                      </>
                    ) : <p>Computing...</p>}
                  </div>

                  <div className="neg-economics-box">
                    <h5>Hotel Utility = Net Revenue ($)</h5>
                    <p>Room rev + F&B margin ({fnbMarginPct}% for {rfp.event_type || 'Corporate'}) + Space rev − concession costs</p>
                    <h5>Client Utility = Perceived Value ($)</h5>
                    <p>Rate savings (×{(0.8 + prof.price_sensitivity).toFixed(2)} price sens.) + F&B value (×{prof.client_fnb_multiplier}) + space (×{prof.client_space_multiplier}) + amenities</p>
                    <p className="neg-economics-note">Both normalized to [0,1]. All weights from 1,899 real events. Priority: {rfp.client_priority} → ×{rfp.client_priority === 'High' ? '0.85' : rfp.client_priority === 'Low' ? '1.15' : '1.00'}</p>
                  </div>
                </>
              );
            })()}
          </div>

          {/* Right: Algorithm params + explainer */}
          <div className="neg-config-right">
            <div className="neg-config-section">
              <div className="neg-section-header" style={{ cursor: 'pointer' }} onClick={() => setShowAdvanced(!showAdvanced)}>
                <div className="neg-dot" style={{ background: '#a855f7' }} />
                <h4>Algorithm Parameters</h4>
                <ChevronRight size={14} className={`neg-chevron ${showAdvanced ? 'open' : ''}`} />
              </div>
              {showAdvanced && (
                <div className="neg-advanced-params">
                  {[
                    { key: 'maxRounds', label: 'Max Rounds', min: 50, max: 600, step: 50 },
                    { key: 'initialTemp', label: 'Temperature', min: 0.5, max: 5, step: 0.1 },
                    { key: 'coolingRate', label: 'Cooling Rate', min: 0.95, max: 0.999, step: 0.001 },
                    { key: 'initialTokens', label: 'Parity Tokens', min: 1, max: 10, step: 1 },
                  ].map(p => (
                    <div key={p.key} className="neg-slider-row">
                      <label htmlFor={`cfg-${p.key}`} className="neg-slider-label">{p.label}</label>
                      <input
                        id={`cfg-${p.key}`} name={`cfg-${p.key}`} autoComplete="off"
                        type="range" min={p.min} max={p.max} step={p.step}
                        value={config[p.key]}
                        onChange={e => setConfig(c => ({ ...c, [p.key]: parseFloat(e.target.value) }))}
                        className="neg-slider" style={{ accentColor: '#a855f7' }}
                      />
                      <span className="neg-slider-value" style={{ color: '#a855f7' }}>{config[p.key]}</span>
                    </div>
                  ))}
                  <div className="neg-slider-row">
                    <label htmlFor="cfg-bestOfN" className="neg-slider-label">Best of N</label>
                    <input
                      id="cfg-bestOfN" name="cfg-bestOfN" autoComplete="off"
                      type="range" min={1} max={20} step={1}
                      value={bestOfN}
                      onChange={e => setBestOfN(parseInt(e.target.value))}
                      className="neg-slider" style={{ accentColor: '#f59e0b' }}
                    />
                    <span className="neg-slider-value" style={{ color: '#f59e0b' }}>{bestOfN} runs</span>
                  </div>
                </div>
              )}
            </div>

            <div className="neg-protocol-summary">
              <h4>How It Works</h4>
              <div className="neg-steps">
                <div className="neg-step"><span className="neg-step-num">1</span> XGBoost predictions set issue ranges & utility anchors</div>
                <div className="neg-step"><span className="neg-step-num">2</span> Mediator proposes mutations to current agreement</div>
                <div className="neg-step"><span className="neg-step-num">3</span> Both parties vote based on $ impact to their position</div>
                <div className="neg-step"><span className="neg-step-num">4</span> Annealing escapes local optima in the utility landscape</div>
                <div className="neg-step"><span className="neg-step-num">5</span> Tokens enforce parity — truthful voting is dominant strategy</div>
              </div>
              <p className="neg-protocol-note">
                Interdependencies are natural: comp rooms cost ADR × nights, higher F&B credit generates revenue but costs margin. The algorithm finds deals near the Pareto frontier where neither party can improve without hurting the other.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* RUNNING / RESULTS */}
      {(phase === 'running' || phase === 'results') && (
        <div className="neg-results-grid">
          <div className="neg-charts-col">
            <div className="neg-chart-card">
              <div className="neg-chart-title">Utility Space & Pareto Frontier</div>
              <ParetoMiniChart history={vis} pareto={pareto} width={480} height={320} />
            </div>
            <div className="neg-chart-row">
              <div className="neg-chart-card-small">
                <div className="neg-chart-title-small">Annealing Temperature</div>
                <TemperatureMiniChart history={vis} width={230} height={70} />
              </div>
              <div className="neg-chart-card-small">
                <div className="neg-chart-title-small">Stats</div>
                <div className="neg-stats-mini-grid">
                  <div className="neg-stat-mini"><span className="neg-stat-label">Accepted</span><span className="neg-stat-val" style={{ color: '#10b981' }}>{accN}</span></div>
                  <div className="neg-stat-mini"><span className="neg-stat-label">Annealing</span><span className="neg-stat-val" style={{ color: '#a855f7' }}>{annN}</span></div>
                  <div className="neg-stat-mini"><span className="neg-stat-label">Overrides</span><span className="neg-stat-val" style={{ color: '#f59e0b' }}>{ovrN}</span></div>
                  <div className="neg-stat-mini"><span className="neg-stat-label">Round</span><span className="neg-stat-val">{latest?.round || 0}</span></div>
                </div>
              </div>
            </div>
            {phase === 'running' && (
              <div className="neg-progress-bar-row">
                <div className="neg-progress-track">
                  <div className="neg-progress-fill" style={{ width: `${(animIdx / (result?.history.length || 1)) * 100}%` }} />
                </div>
                <span className="neg-progress-text">{Math.min(animIdx, result?.history.length || 0)}/{result?.history.length || 0}</span>
                <div className="neg-speed-btns">
                  {[{ s: 2, l: '1×' }, { s: 8, l: '4×' }, { s: 20, l: '10×' }].map(b => (
                    <button key={b.s} className={`neg-speed-btn ${speed === b.s ? 'active' : ''}`} onClick={() => setSpeed(b.s)}>{b.l}</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="neg-right-col">
            {/* Agreement */}
            <div className={`neg-agreement-card ${phase === 'results' ? 'final' : ''}`}>
              <h4 className="neg-agreement-title">{phase === 'results' ? '✦ Final Agreement' : 'Current Agreement'}</h4>
              {phase === 'results' && <div className="neg-agreement-subtitle">Best social welfare found across all rounds</div>}
              {phase === 'results' && runSummary && (
                <div className="neg-bestof-summary">
                  <span className="neg-bestof-badge">Best of {runSummary.total}</span>
                  <span className="neg-bestof-detail">
                    Run {runSummary.winner} selected · SW {runSummary.scores.map((s, i) => (
                      <span key={i} className={i === runSummary.winner - 1 ? 'neg-bestof-winner' : 'neg-bestof-other'}>
                        {s.toFixed(3)}{i < runSummary.scores.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              <div className="neg-issue-list">
                {issues.map(is => {
                  const agreement = phase === 'results' ? final : latest?.agreement;
                  const val = agreement?.[is.key];
                  let dv = '—';
                  if (val !== undefined) {
                    if (is.type === 'binary') dv = val ? 'Yes' : 'No';
                    else dv = `${is.unit === '€' ? '$' : ''}${val}${is.unit === '%' ? '%' : ''}`;
                  }
                  const n = val !== undefined ? issueNorm(issues, is.key, val) : 0;
                  return (
                    <div key={is.key} className="neg-issue-row">
                      <span className="neg-issue-label">{is.label}</span>
                      <div className="neg-issue-bar-track">
                        <div className="neg-issue-bar-fill" style={{ width: `${n * 100}%` }} />
                      </div>
                      <span className="neg-issue-value">{dv}</span>
                    </div>
                  );
                })}
              </div>
              {phase === 'results' && final && negCtx && (
                <div className="neg-utility-scores">
                  <div className="neg-utility-item">
                    <div className="neg-utility-label" style={{ color: '#3b82f6' }}>Hotel Utility</div>
                    <div className="neg-utility-val" style={{ color: '#3b82f6' }}>{negCtx.hotelUtility(final).toFixed(3)}</div>
                    <div className="neg-utility-euros" style={{ color: '#60a5fa' }}>{safeFmt(Math.round(negCtx.hotelEuros(final)))}</div>
                  </div>
                  <div className="neg-utility-item">
                    <div className="neg-utility-label" style={{ color: '#10b981' }}>Client Utility</div>
                    <div className="neg-utility-val" style={{ color: '#10b981' }}>{negCtx.clientUtility(final).toFixed(3)}</div>
                    <div className="neg-utility-euros" style={{ color: '#34d399' }}>{safeFmt(Math.round(negCtx.clientEuros(final)))} value</div>
                  </div>
                  <div className="neg-utility-item">
                    <div className="neg-utility-label" style={{ color: '#f59e0b' }}>Social Welfare</div>
                    <div className="neg-utility-val" style={{ color: '#f59e0b' }}>{(negCtx.hotelUtility(final) + negCtx.clientUtility(final)).toFixed(3)}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Log */}
            <div className="neg-log-card">
              <h4 className="neg-log-title">Event Log</h4>
              <div className="neg-log-scroll">
                {[...vis].reverse().slice(0, 30).map((d, i) => (
                  <div key={i} className="neg-log-row">
                    <span className="neg-log-round">R{d.round}</span>
                    <span className={`neg-log-dot ${d.event === 'mutual_accept' || d.event === 'weak_accept' ? 'accept' : d.event === 'annealing_accept' ? 'anneal' : d.event?.includes('override') ? 'override' : 'reject'}`} />
                    <span className="neg-log-event">{d.event?.replace(/_/g, ' ')}</span>
                    <span className={`neg-log-proposer ${d.proposer === 'hotel' ? 'hotel' : 'client'}`}>{d.proposer || ''}</span>
                  </div>
                ))}
              </div>
            </div>

            {phase === 'results' && (
              <button className="btn-apply-negotiated" onClick={handleApply}>
                <Check size={16} /> Apply as Strategy →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── MAIN STRATEGIES VIEW ────────────────────────────────────────────────────

const StrategiesView = ({ rfp, onBack, onEdit, onRfpChange, inEditMode = false }) => {
  const [strategies, setStrategies] = useState(null);
  const [selectedStrategyName, setSelectedStrategyName] = useState(rfp?.selected_strategy || null);
  const [predictions, setPredictions] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [modelStatus, setModelStatus] = useState('Initializing...');
  const [usingFallback, setUsingFallback] = useState(false);
  const [activeTab, setActiveTab] = useState('strategies');
  const [negotiatedStrategy, setNegotiatedStrategy] = useState(null);
  const [xgbStatus, setXgbStatus] = useState('idle'); // idle | loading | loaded | failed

  const handleSelectStrategy = async (strategy) => {
    setSelectedStrategyName(strategy.name);
    try {
      const col = rfp._col || 'rfps';
      await updateDoc(doc(db, col, rfp.id), {
        selected_strategy: strategy.name,
        selected_adr: strategy.adr,
        selected_total_revenue: strategy.totalRevenue,
        selected_at: serverTimestamp(),
        status: rfp.status || 'pending',
      });
      if (onRfpChange) onRfpChange({ ...rfp, selected_strategy: strategy.name });
    } catch (e) {
      console.warn('Could not save strategy selection:', e);
    }
  };

  const { signals } = useMarketSignals();
  const { config }  = useHotelConfig();
  const nights = (() => {
    const arr = new Date(rfp.arrival_date || rfp.Arrival_Date);
    const dep = new Date(rfp.departure_date || rfp.Departure_Date);
    const n = Math.ceil((dep - arr) / (1000 * 60 * 60 * 24));
    return isNaN(n) || n <= 0 ? 1 : n;
  })();

  // Default predictions for fallback
  const roomBlock = Number(rfp.room_block || rfp.Peak_Room_Block || 50);
  const attendeesCount = Number(rfp.attendees || rfp.Attendees || Math.round(roomBlock * 1.4));

  const fallbackPredictions = {
    baseline_adr: 220,
    pickup_rate: 0.79,
    conversion_prob: 0.65,
    fnb_per_person: 60,
    room_nights: rfp.room_block * nights,
    meeting_space_base: 8000,
  };

  // Generate fallback strategies from RFP data (no Pyodide needed)
  const buildFallbackStrategies = useCallback(() => {
    const baseAdr = 220;
    const pickupRate = 0.79;
    const convProb = 0.70;
    const fnbPP = 60;
    const baseRevenue = baseAdr * roomBlock * nights * pickupRate;
    const baseFnb = attendeesCount * fnbPP;
    const baseSpace = 8000;

    setPredictions({
      baseline_adr: baseAdr,
      pickup_rate: pickupRate,
      conversion_prob: convProb,
      fnb_per_person: fnbPP,
      room_nights: rfp.room_block * nights,
      meeting_space_base: baseSpace,
    });

    setStrategies([
      { name: 'Conservative Capture', risk: 'Low Risk', adr: Math.round(baseAdr * 0.95), pickupRate: Math.round(Math.min(0.99, pickupRate * 1.06) * 100), conversionProb: Math.round(Math.min(0.99, convProb * 1.15) * 100), gviIndex: 225, roomRevenue: Math.round(baseRevenue * 0.95), fnbRevenue: Math.round(baseFnb * 0.9), spaceRevenue: Math.round(baseSpace), totalRevenue: Math.round(baseRevenue * 0.95 + baseFnb * 0.9 + baseSpace), expectedProfit: Math.round((baseRevenue * 0.95 + baseFnb * 0.9 + baseSpace) * 0.44), riskAdjustedValue: Math.round((baseRevenue * 0.95 + baseFnb * 0.9 + baseSpace) * 0.44 * 0.80), roiVsBaseline: '+71%', color: 'success', includes: ['3 comp rooms', '$30/person F&B credit', '50% space discount', 'Free WiFi', 'Late checkout', 'Welcome reception'], subtitle: 'Select Conservative Strategy' },
      { name: 'Optimal Balance', risk: 'Medium Risk', adr: baseAdr, pickupRate: Math.round(pickupRate * 100), conversionProb: Math.round(convProb * 100), gviIndex: 261, roomRevenue: Math.round(baseRevenue), fnbRevenue: Math.round(baseFnb), spaceRevenue: Math.round(baseSpace * 1.4), totalRevenue: Math.round(baseRevenue + baseFnb + baseSpace * 1.4), expectedProfit: Math.round((baseRevenue + baseFnb + baseSpace * 1.4) * 0.44), riskAdjustedValue: Math.round((baseRevenue + baseFnb + baseSpace * 1.4) * 0.44 * 0.70), roiVsBaseline: '+103%', color: 'warning', recommended: true, includes: ['2 comp rooms', '$25/person F&B credit', '30% space discount', 'Free WiFi', 'Welcome reception', 'Late checkout'], subtitle: 'Select Recommended Strategy' },
      { name: 'Premium Position', risk: 'Higher Risk', adr: Math.round(baseAdr * 1.15), pickupRate: Math.round(pickupRate * 0.95 * 100), conversionProb: Math.round(convProb * 0.85 * 100), gviIndex: 289, roomRevenue: Math.round(baseRevenue * 1.05), fnbRevenue: Math.round(baseFnb * 1.2), spaceRevenue: Math.round(baseSpace * 1.7), totalRevenue: Math.round(baseRevenue * 1.05 + baseFnb * 1.2 + baseSpace * 1.7), expectedProfit: Math.round((baseRevenue * 1.05 + baseFnb * 1.2 + baseSpace * 1.7) * 0.43), riskAdjustedValue: Math.round((baseRevenue * 1.05 + baseFnb * 1.2 + baseSpace * 1.7) * 0.43 * 0.55), roiVsBaseline: '+128%', color: 'error', includes: ['1 comp room', '$20/person F&B credit', '15% space discount', 'Free WiFi', 'Welcome amenity'], subtitle: 'Select Premium Strategy' },
    ]);
  }, [rfp, nights]);

  useEffect(() => {
    // Load fallback instantly so the UI is never stuck
    buildFallbackStrategies();
    setIsLoading(false);
    setUsingFallback(true);
    setModelStatus('Rule-based predictions');

    // Try XGBoost in background with timeout
    tryXGBoost();
  }, []);

  const tryXGBoost = async () => {
    setXgbStatus('loading');

    // ── Path 1: JS trees (pickup_ipw) — instant, no Pyodide ──────────────────
    if (XGBOOST_TREES?.pickup_ipw) {
      try {
        const preds = runJSXGBoost(rfp, signals, config);
        setPredictions(preds);
        setStrategies(buildJSStrategies(rfp, preds, nights));
        setUsingFallback(false);
        setModelStatus('XGBoost JS trees · pickup_ipw (IPW-corrected)');
        setXgbStatus('loaded');
        return;
      } catch (err) {
        console.warn('JS XGBoost failed, trying Pyodide:', err.message);
      }
    }

    // ── Path 2: Pyodide + pkl (legacy fallback) ───────────────────────────────
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000));
      const load = (async () => {
        await initPyodide();
        await loadModel('/rfp_xgboost_models_compatible.pkl');
        return await predictStrategies(rfp);
      })();

      const result = await Promise.race([load, timeout]);

      if (result.success) {
        setStrategies(result.strategies);
        const optimal = result.strategies.find(s => s.recommended) || result.strategies[1] || result.strategies[0];
        setPredictions({
          baseline_adr: optimal.adr,
          pickup_rate: optimal.pickupRate / 100,
          conversion_prob: optimal.conversionProb / 100,
          fnb_per_person: (nights > 0 && rfp.attendees > 0) ? Math.round(optimal.fnbRevenue / (rfp.attendees * nights)) : 60,
          room_nights: rfp.room_block * nights,
          meeting_space_base: 8000,
        });
        setUsingFallback(false);
        setModelStatus(`XGBoost predictions (${result.prediction_method})`);
        setXgbStatus('loaded');
      } else {
        throw new Error('Prediction failed');
      }
    } catch (err) {
      console.warn('XGBoost unavailable:', err.message);
      setXgbStatus('failed');
    }
  };

  const handleApplyNegotiated = (strategy) => {
    setNegotiatedStrategy(strategy);
    setActiveTab('strategies');
  };

  const allStrategies = strategies ? [...strategies, ...(negotiatedStrategy ? [negotiatedStrategy] : [])] : null;
  const activePredictions = predictions || fallbackPredictions;

  return (
    <div className="strategies-container">
      {/* Top bar */}
      <div className="strategies-top-bar">
        {!inEditMode && <button onClick={onBack} className="btn-back"><ArrowLeft size={16} /> Edit RFP</button>}
        <div className="strategies-tabs">
          <button className={`strategies-tab ${activeTab === 'strategies' ? 'active' : ''}`} onClick={() => setActiveTab('strategies')}>
            <BarChart3 size={15} /> Pricing Strategies
            {negotiatedStrategy && <span className="tab-badge">+1</span>}
          </button>
          <button className={`strategies-tab ${activeTab === 'negotiate' ? 'active' : ''}`} onClick={() => setActiveTab('negotiate')}>
            <Zap size={15} /> Negotiate
          </button>
        </div>
        <button onClick={tryXGBoost} disabled={isLoading || xgbStatus === 'loading'} className="btn-primary-green">
          <RefreshCw size={16} className={xgbStatus === 'loading' ? 'spin' : ''} />
          {xgbStatus === 'loading' ? 'Loading XGBoost...' : xgbStatus === 'loaded' ? 'XGBoost ✓' : 'Try XGBoost'}
        </button>
      </div>

      {xgbStatus === 'failed' && activeTab === 'strategies' && <div className="notice notice-warn">ℹ️ Using rule-based predictions. Click "Try XGBoost" to attempt ML-powered predictions.</div>}
      {xgbStatus === 'loaded' && activeTab === 'strategies' && <div className="notice notice-success">✅ {modelStatus}</div>}

      {/* RFP Summary */}
      <div className="rfp-summary-bar">
        <h2 className="rfp-summary-title">{rfp.event_name}</h2>
        <p className="rfp-summary-dates">
          {new Date(rfp.arrival_date).toLocaleDateString()} – {new Date(rfp.departure_date).toLocaleDateString()} ({nights} nights)
        </p>
        <div className="rfp-summary-stats">
          <div className="rfp-stat-chip"><span className="rfp-stat-label">Attendees</span><span className="rfp-stat-value">{rfp.attendees}</span></div>
          <div className="rfp-stat-chip"><span className="rfp-stat-label">Room Block</span><span className="rfp-stat-value">{rfp.room_block}</span></div>
          <div className="rfp-stat-chip"><span className="rfp-stat-label">Client Priority</span><span className="rfp-stat-value">{rfp.client_priority}</span></div>
        </div>
      </div>

      {/* STRATEGIES TAB */}
      {activeTab === 'strategies' && (
        <>
          <h3 className="strategies-section-title">Recommended Pricing Strategies</h3>
          <p className="strategies-section-subtitle">
            {negotiatedStrategy
              ? <>The <span style={{ color: '#f59e0b', fontWeight: 600 }}>negotiated strategy</span> was generated via the annealing mediator protocol calibrated by XGBoost.</>
              : <>The <span style={{ color: '#5b5fc7', fontWeight: 600 }}>highlighted option</span> is recommended based on current market conditions.</>}
          </p>

          {isLoading ? (
            <div className="strategies-loading"><RefreshCw className="spin" size={48} /><p>{modelStatus}</p></div>
          ) : (
            <div className={`strategies-grid ${allStrategies && allStrategies.length > 3 ? 'four-col' : ''}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 220px))', gap: '0.75rem', justifyContent: 'start' }}>
              {allStrategies && allStrategies.map((strategy, index) => (
                <div key={index} className={`strategy-card-detailed ${strategy.recommended ? 'recommended' : ''} ${strategy.negotiated ? 'negotiated' : ''}`} style={{ fontSize: '0.82rem', padding: '1rem' }}>
                  {strategy.recommended && <div className="recommended-badge"><span>✓ RECOMMENDED</span></div>}
                  {strategy.recommended && <div style={{ fontSize: '0.75rem', color: '#5b5fc7', marginBottom: '0.5rem', fontStyle: 'italic' }}>Best balance of win probability and total revenue contribution.</div>}
                  {strategy.negotiated && <div className="negotiated-badge"><span>⚡ NEGOTIATED</span></div>}

                  <div style={{ marginBottom: '1.25rem' }}>
                    <h4 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>{strategy.name}</h4>
                    <span className={`risk-badge risk-${strategy.color}`}>{strategy.risk}</span>
                  </div>

                  <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{ fontSize: '0.875rem', color: '#718096', marginBottom: '0.25rem' }}>ADR Offer</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${strategy.adr}</div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.4rem', marginBottom: '0.75rem' }}>
                    {[{ label: 'Pickup', val: `${strategy.pickupRate}%` }, { label: 'Win Prob.', val: `${strategy.conversionProb}%` }, { label: 'GVI ⓘ', val: isNaN(strategy.gviIndex) ? '—' : strategy.gviIndex }].map(m => (
                      <div key={m.label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#718096', marginBottom: '0.25rem' }}>{m.label}</div>
                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{m.val}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: '0.6875rem', color: '#94a3b8', marginTop: '-0.75rem', marginBottom: '1rem', textAlign: 'center' }}>
                    GVI (Group Value Index): 0–300 scale. Above 200 = strong deal; 260+ = premium.
                  </div>
                  <div className="revenue-breakdown">
                    {[{ l: 'Room Revenue', v: strategy.roomRevenue, c: '#4299e1' }, { l: 'F&B Revenue', v: strategy.fnbRevenue, c: '#9f7aea' }, { l: 'Space Revenue', v: strategy.spaceRevenue, c: '#ed8936' }].map(r => (
                      <div key={r.l} className="rev-row"><span className="rev-label">{r.l}</span><span className="rev-val" style={{ color: r.c }}>{safeFmt(r.v)}</span></div>
                    ))}
                    <div className="rev-row rev-total"><span className="rev-label-total">Total Revenue</span><span className="rev-val-total">{safeFmt(strategy.totalRevenue)}</span></div>
                  </div>

                  <div className="profit-section">
                    {strategy.dispCost > 0 && (
                      <div className="profit-row-sub" style={{ color: '#e53e3e' }}><span>Displacement Cost</span><span>−${strategy.dispCost.toLocaleString()}</span></div>
                    )}
                    <div className="profit-row"><span>Expected Profit</span><span className="profit-val">{safeFmt(strategy.expectedProfit)}</span></div>
                    <div className="profit-row-sub"><span>Risk-Adjusted Value</span><span>{safeFmt(strategy.riskAdjustedValue)}</span></div>
                    <div className="profit-row-sub"><span>ROI vs Baseline</span><span className={`profit-roi ${(strategy.roiVsBaseline||'').startsWith('-') ? 'negative' : ''}`}>{strategy.roiVsBaseline?.includes('NaN') ? '—' : strategy.roiVsBaseline}</span></div>
                  </div>

                  {strategy.negotiated && (
                    <div className="neg-card-utilities">
                      <div className="neg-card-util"><span style={{ color: '#3b82f6' }}>Hotel:</span><strong style={{ color: '#3b82f6' }}>{strategy.hotelUtility.toFixed(3)}</strong><span style={{ color: '#60a5fa', fontSize: '0.625rem', marginLeft: 4 }}>{safeFmt(strategy.hotelNetRevEuros)}</span></div>
                      <div className="neg-card-util"><span style={{ color: '#10b981' }}>Client:</span><strong style={{ color: '#10b981' }}>{strategy.clientUtility.toFixed(3)}</strong><span style={{ color: '#34d399', fontSize: '0.625rem', marginLeft: 4 }}>{safeFmt(strategy.clientValueEuros)}</span></div>
                    </div>
                  )}

                  <div style={{ marginBottom: '1.5rem' }}>
                    <strong style={{ fontSize: '0.875rem', display: 'block', marginBottom: '0.5rem' }}>PACKAGE INCLUDES:</strong>
                    <ul style={{ listStyle: 'none', padding: 0, fontSize: '0.8125rem', color: '#4a5568' }}>
                      {strategy.includes.map((item, i) => <li key={i} style={{ marginBottom: '0.25rem' }}>• {item}</li>)}
                    </ul>
                  </div>

                 

                  <button
  className={strategy.recommended ? 'btn-strategy-recommended' : strategy.negotiated ? 'btn-strategy-negotiated' : 'btn-strategy'}
  style={{ width: '100%', padding: '0.875rem', border: 'none', fontSize: '0.9375rem', fontWeight: 600, borderRadius: '0.5rem', cursor: 'pointer' }}
  onClick={() => {
    const subject = `Hotel Proposal: ${rfp.event_name} – ${strategy.name}`;
    const body = `Dear ${rfp.contact_name || 'Valued Guest'},

Thank you for your inquiry regarding ${rfp.event_name}.

We are pleased to present our ${strategy.name} proposal:

DATES & GROUP
Arrival: ${rfp.arrival_date}
Departure: ${rfp.departure_date} (${nights} nights)
Attendees: ${rfp.attendees}
Room Block: ${rfp.room_block} rooms

PRICING
ADR: ${strategy.adr} per room/night
Pickup Rate: ${strategy.pickupRate}%
Conversion Probability: ${strategy.conversionProb}%

REVENUE SUMMARY
Room Revenue: ${strategy.roomRevenue?.toLocaleString()}
F&B Revenue: ${strategy.fnbRevenue?.toLocaleString()}
Space Revenue: ${strategy.spaceRevenue?.toLocaleString()}
Total Revenue: ${strategy.totalRevenue?.toLocaleString()}

PACKAGE INCLUDES
${strategy.includes?.map(i => `• ${i}`).join('\n')}

${rfp.special_requirements ? `SPECIAL REQUIREMENTS\n${rfp.special_requirements}\n` : ''}
We look forward to hosting your event.

Best regards,
Hotel Revenue Team`;

    window.location.href = `mailto:${rfp.contact_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }}
>
  {selectedStrategyName === strategy.name ? '✓ Selected' : (strategy.subtitle || 'Select This Strategy')}
</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* NEGOTIATE TAB */}
      {activeTab === 'negotiate' && (
        <NegotiationPanel rfp={rfp} predictions={activePredictions} onApplyStrategy={handleApplyNegotiated} />
      )}
    </div>
  );
};

export default StrategiesView;
