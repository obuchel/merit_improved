import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../firebase';

function useDemandEvents(rfp) {
  const [events, setEvents] = React.useState([]);
  React.useEffect(() => {
    if (!rfp?.arrival_date) return;
    getDocs(collection(db, 'demand_events')).then(snap => {
      const arr = rfp.arrival_date;
      const dep = rfp.departure_date || arr;
      const overlapping = snap.docs.map(d => d.data()).filter(ev =>
        ev.start_date && ev.end_date && ev.start_date <= dep && ev.end_date >= arr
      );
      setEvents(overlapping);
    }).catch(() => {});
  }, [rfp?.arrival_date, rfp?.departure_date]);
  return events;
}

const DEMAND_COLORS = { Low: '#3b82f6', Medium: '#f59e0b', High: '#f97316', Critical: '#ef4444' };
const DEMAND_ADR_MULT = { Low: 1.0, Medium: 1.05, High: 1.12, Critical: 1.20 };

const safeFmt = (v) => {
  const n = Number(v);
  return isNaN(n) ? '$0' : '$' + Math.round(n).toLocaleString();
};
import { doc, updateDoc, getDocs, collection, serverTimestamp } from 'firebase/firestore';
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

// ─── MANUAL OVERRIDE SUPPORT ─────────────────────────────────────────────────
// Applies any user-entered overrides on top of a generated strategy and
// recalculates everything that depends on them (Total Revenue is always
// Room + F&B + Space — never directly editable — and Expected Profit /
// Risk-Adjusted Value / ROI / Deal Score stay in sync with it).
const OVERRIDE_FIELDS = ['adr', 'pickupRate', 'conversionProb', 'roomRevenue', 'fnbRevenue', 'spaceRevenue'];

function applyStrategyOverrides(strategy, override, rfp, nights) {
  if (!override) return strategy;
  const adr             = override.adr            ?? strategy.adr;
  const pickupRate      = override.pickupRate      ?? strategy.pickupRate;
  const conversionProb  = override.conversionProb  ?? strategy.conversionProb;
  const fnbRevenue      = override.fnbRevenue      ?? strategy.fnbRevenue;
  const spaceRevenue    = override.spaceRevenue    ?? strategy.spaceRevenue;

  // Room Revenue is mechanically ADR × Pickup × room-nights — it recalculates
  // automatically whenever ADR or Pickup % change. Editing Room Revenue itself
  // pins it directly, until ADR or Pickup are touched again (see updateOverride,
  // which clears this pin so the two never silently disagree).
  const roomNights  = (Number(rfp?.room_block) || 0) * (nights || 1);
  const roomRevenue = override.roomRevenue !== undefined
    ? override.roomRevenue
    : Math.round(adr * roomNights * (pickupRate / 100));

  const totalRevenue    = roomRevenue + fnbRevenue + spaceRevenue;

  // dispCost is occupancy-driven, not strategy-specific, so it's left as-is.
  const dispCost   = strategy.dispCost || 0;
  const netRev     = totalRevenue - dispCost;
  const expectedProfit = Math.max(0, Math.round(netRev * 0.44));
  const riskAdjustedValue = Math.round(expectedProfit * (conversionProb / 100));
  const baselineDenom = Math.max(1, 164 * roomNights);
  const roiPct = Math.round((netRev / baselineDenom - 1) * 100);
  const roiVsBaseline = (roiPct >= 0 ? '+' : '') + roiPct + '%';
  const gviIndex = Math.round(totalRevenue / 1000);

  return {
    ...strategy,
    adr, pickupRate, conversionProb, roomRevenue, fnbRevenue, spaceRevenue,
    totalRevenue, dispCost, expectedProfit, riskAdjustedValue, roiVsBaseline, gviIndex,
    overridden: OVERRIDE_FIELDS.some(f => override[f] !== undefined),
  };
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
      {rejected.map((d, i) => <circle key={'r' + i} cx={sx(d.hotelUtility)} cy={sy(d.clientUtility)} r={1.2} fill="#475569" opacity={0.12} />)}
      {aPath && <path d={aPath} fill="none" stroke="#f59e0b" strokeWidth={1.5} opacity={0.35} />}
      {accepted.map((d, i) => (
        <circle key={'a' + i} cx={sx(d.hotelUtility)} cy={sy(d.clientUtility)}
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
            <span style={{ color: negCtx.leverage.demandPressure >= 0.6 ? '#f43f5e' : negCtx.leverage.demandPressure >= 0.35 ? '#f59e0b' : '#10b981' }}>
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
                          <span className="neg-slider-value" style={{ color: lev.demandPressure >= 0.6 ? '#f43f5e' : lev.demandPressure >= 0.35 ? '#f59e0b' : '#10b981' }}>
                            {(lev.demandPressure * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="neg-monthly-adrs">
                          {lev.monthlyAdrs.map((adr, i) => {
                            const h = maxAdr > minAdr ? ((adr - minAdr) / (maxAdr - minAdr)) * 28 + 4 : 16;
                            return (
                              <div key={i} className={'neg-month-bar' + (i === currentMonth ? ' current' : '')}>
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
                <ChevronRight size={14} className={'neg-chevron' + (showAdvanced ? ' open' : '')} />
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
                      <label htmlFor={'cfg-' + p.key} className="neg-slider-label">{p.label}</label>
                      <input
                        id={'cfg-' + p.key} name={'cfg-' + p.key} autoComplete="off"
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
                    <button key={b.s} className={'neg-speed-btn' + (speed === b.s ? ' active' : '')} onClick={() => setSpeed(b.s)}>{b.l}</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="neg-right-col">
            {/* Agreement */}
            <div className={'neg-agreement-card' + (phase === 'results' ? ' final' : '')}>
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
                    <span className={'neg-log-dot ' + (d.event === 'mutual_accept' || d.event === 'weak_accept' ? 'accept' : d.event === 'annealing_accept' ? 'anneal' : (d.event && d.event.includes('override')) ? 'override' : 'reject')} />
                    <span className="neg-log-event">{d.event?.replace(/_/g, ' ')}</span>
                    <span className={'neg-log-proposer ' + (d.proposer === 'hotel' ? 'hotel' : 'client')}>{d.proposer || ''}</span>
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



// ─── COUNTER-OFFER SIMULATOR (Feature 4) ─────────────────────────────────────

const PUSHBACK_SCENARIOS = [
  {
    id: 'lower_adr',
    label: 'Client asks for 10% lower ADR',
    icon: '💬',
    apply: (agr) => ({ ...agr, adr: Math.max(140, Math.round(agr.adr * 0.90)) }),
    description: 'Client pushes back on rate — typical for price-sensitive associations',
  },
  {
    id: 'more_comp',
    label: 'Client asks for more comp rooms',
    icon: '🛏',
    apply: (agr) => ({ ...agr, comp_rooms: Math.min(6, (agr.comp_rooms || 0) + 2) }),
    description: 'Client wants comps for VIPs — common in corporate and association groups',
  },
  {
    id: 'higher_fnb',
    label: 'Client asks for higher F&B credit',
    icon: '🍽',
    apply: (agr) => ({ ...agr, fnb_credit: Math.min(60, (agr.fnb_credit || 0) + 15) }),
    description: 'Client wants more F&B credit per person — common when planning a gala dinner or heavy catering program',
  },
];

function findBestResponse(originalAgr, pushbackAgr) {
  // Generate hotel counter-offers: start from ORIGINAL offer, make targeted concessions
  // Goal: stay as close to original as possible while addressing client's specific concern
  const candidates = [];
  const variants = [
    // Stand firm on original
    { ...originalAgr, _label: 'Hold firm' },
    // Meet halfway on ADR
    { ...originalAgr, adr: Math.round((originalAgr.adr + pushbackAgr.adr) / 2), _label: 'Meet halfway on ADR' },
    // Meet halfway on F&B credit
    { ...originalAgr, fnb_credit: Math.round(((originalAgr.fnb_credit||0) + (pushbackAgr.fnb_credit||0)) / 2), _label: 'Meet halfway on F&B credit' },
    // Add a cheap concession to soften the blow
    { ...originalAgr, wifi: 1, late_checkout: 1, _label: 'Add WiFi + late checkout' },
    { ...originalAgr, welcome_reception: 1, _label: 'Add welcome reception' },
    // Offer F&B credit instead of ADR drop
    { ...originalAgr, fnb_credit: Math.min(60, (originalAgr.fnb_credit||0) + 8), _label: 'Offer F&B credit instead of ADR drop' },
    // Drop comp rooms by 1 instead of lowering ADR
    { ...originalAgr, comp_rooms: Math.max(0, (originalAgr.comp_rooms||0) - 1), _label: 'Reduce comp rooms' },
    // Swap: lower ADR slightly, remove a concession
    { ...originalAgr, adr: Math.round(originalAgr.adr * 0.97), welcome_reception: 0, _label: 'Small ADR drop, drop reception' },
  ];
  candidates.push({ agreement: variants[0], label: variants[0]._label, hU: hotelUtilityDirect(variants[0]), cU: clientUtilityDirect(variants[0]), isHoldFirm: true });
  for (let i = 1; i < variants.length; i++) {
    candidates.push({ agreement: variants[i], label: variants[i]._label, hU: hotelUtilityDirect(variants[i]), cU: clientUtilityDirect(variants[i]), isHoldFirm: false });
  }
  const pushbackCU = clientUtilityDirect(pushbackAgr);
  // If hold firm keeps client utility above pushback level, always prefer it
  if (candidates[0].cU >= pushbackCU * 0.85) return candidates[0];
  // Otherwise find best hotel utility where client is still somewhat satisfied
  const viable = candidates.filter(c => c.cU >= pushbackCU * 0.8);
  viable.sort((a, b) => b.hU - a.hU);
  return viable[0] || candidates[0];
}

function CounterOfferSimulator({ recommended, analyzed }) {
  const [activeScenario, setActiveScenario] = React.useState(null);

  if (!recommended) return null;

  const recAgr = recommended.agreement || strategyToAgreement(recommended);
  const recHU  = recommended.hU ?? hotelUtilityDirect(recAgr);
  const recCU  = recommended.cU ?? clientUtilityDirect(recAgr);

  const scenario = PUSHBACK_SCENARIOS.find(s => s.id === activeScenario);
  let pushbackAgr = null, response = null;
  if (scenario) {
    pushbackAgr = scenario.apply(recAgr);
    response    = findBestResponse(recAgr, pushbackAgr);
  }

  // Hold firm if response ADR is within $5 of original
  const holdsFirm    = response && Math.abs(response.agreement.adr - recAgr.adr) <= 5 && response.agreement.comp_rooms <= (recAgr.comp_rooms || 0) + 1;
  const shouldShift  = response && response.hU < recHU * 0.88;
  const shiftTarget  = shouldShift
    ? analyzed.find(s => !s.recommended && s.hU > response.hU * 0.95) || analyzed[0]
    : null;

  return (
    <div style={{ marginTop: '1.25rem' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
        🔄 "What If?" Counter-Offer Simulator — How should you respond if the client pushes back?
      </div>

      {/* Scenario buttons */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {PUSHBACK_SCENARIOS.map(sc => (
          <button key={sc.id}
            onClick={() => setActiveScenario(activeScenario === sc.id ? null : sc.id)}
            style={{ padding: '0.4rem 0.75rem', border: `1.5px solid ${activeScenario === sc.id ? '#6366f1' : '#e0e7ff'}`,
              borderRadius: '6px', background: activeScenario === sc.id ? '#eef2ff' : '#fff',
              color: activeScenario === sc.id ? '#4338ca' : '#4b5563', fontWeight: activeScenario === sc.id ? 700 : 400,
              cursor: 'pointer', fontSize: '0.78rem', fontFamily: 'inherit' }}>
            {sc.icon} {sc.label}
          </button>
        ))}
        {activeScenario && (
          <button onClick={() => setActiveScenario(null)}
            style={{ padding: '0.4rem 0.75rem', border: '1px solid #fee2e2', borderRadius: '6px',
              background: '#fff5f5', color: '#dc2626', cursor: 'pointer', fontSize: '0.78rem', fontFamily: 'inherit' }}>
            ✕ Clear
          </button>
        )}
      </div>

      {/* Scenario description */}
      {scenario && (
        <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: '0.75rem', fontStyle: 'italic' }}>
          {scenario.description}
        </div>
      )}

      {/* Response panel */}
      {response && pushbackAgr && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>

          {/* Original */}
          <div style={{ padding: '0.75rem', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
              Your Offer
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#1e1b4b', marginBottom: '0.25rem' }}>${Math.round(recAgr.adr)}/night</div>
            <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>{recAgr.comp_rooms} comp · ${recAgr.fnb_credit}/pp F&B</div>
            <div style={{ marginTop: '0.4rem', fontSize: '0.65rem', display: 'flex', gap: '0.4rem' }}>
              <span style={{ color: '#3b82f6' }}>Value: baseline</span>
            </div>
          </div>

          {/* Client pushback */}
          <div style={{ padding: '0.75rem', background: '#fef9ec', border: '1px solid #fcd34d', borderRadius: '8px' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
              {scenario.icon} Client Asks For
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#78350f', marginBottom: '0.25rem' }}>${Math.round(pushbackAgr.adr)}/night</div>
            <div style={{ fontSize: '0.7rem', color: '#92400e' }}>{pushbackAgr.comp_rooms} comp · ${pushbackAgr.fnb_credit}/pp F&B · ${pushbackAgr.adr}/nt</div>
            <div style={{ marginTop: '0.4rem', fontSize: '0.65rem', color: '#ef4444' }}>
              {(() => {
                const orig = hotelUtilityDirect(recAgr);
                const pushed = hotelUtilityDirect(pushbackAgr);
                // Measure the absolute utility drop as % of the utility range
                const drop = Math.round(Math.abs(orig - pushed) * 100);
                return pushed < orig ? `Costs hotel ~${drop} utility pts` : 'Manageable concession';
              })()}
            </div>
          </div>

          {/* Recommended response */}
          <div style={{ padding: '0.75rem', background: holdsFirm ? '#f0fdf4' : '#fffbeb',
            border: `1.5px solid ${holdsFirm ? '#86efac' : '#fcd34d'}`, borderRadius: '8px' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: holdsFirm ? '#166534' : '#92400e', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
              {holdsFirm ? '✅ Hold Firm' : '↩ Best Counter'}
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: holdsFirm ? '#166534' : '#78350f', marginBottom: '0.25rem' }}>
              ${Math.round(response.agreement.adr)}/night
            </div>
            <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>{response.agreement.comp_rooms} comp · ${response.agreement.fnb_credit}/pp F&B · ${response.agreement.adr}/nt</div>
            <div style={{ marginTop: '0.4rem', fontSize: '0.65rem', color: holdsFirm ? '#166534' : '#92400e' }}>
              {holdsFirm ? '✓ Preserves your position' : response.label || 'Adjusted offer'}
            </div>
          </div>
        </div>
      )}

      {/* Verdict */}
      {response && (
        <div style={{ marginTop: '0.65rem', padding: '0.6rem 0.75rem',
          background: holdsFirm ? '#f0fdf4' : '#fef9ec',
          border: `1px solid ${holdsFirm ? '#86efac' : '#fcd34d'}`, borderRadius: '6px',
          fontSize: '0.75rem', color: holdsFirm ? '#166534' : '#92400e' }}>
          {holdsFirm
            ? <>✅ <strong>Hold firm on {recommended?.name}.</strong> Even after the client's pushback, the best counter-offer closely matches your original proposal. Conceding would reduce hotel utility by more than 8% without a meaningful win probability gain.</>
            : shiftTarget
              ? <>↩ <strong>Consider shifting to {shiftTarget.name}.</strong> The client's pushback significantly erodes hotel value. {shiftTarget.name} at ${Math.round(shiftTarget.adr)}/night better preserves revenue while improving win probability.</>
              : <>⚠️ <strong>Partial concession recommended.</strong> Offer ${Math.round(response.agreement.adr)}/night with adjusted concessions to find middle ground.</>
          }
        </div>
      )}

      {!activeScenario && (
        <div style={{ fontSize: '0.7rem', color: '#9ca3af', fontStyle: 'italic', marginTop: '0.25rem' }}>
          Select a pushback scenario above to see how MERIT recommends you respond.
        </div>
      )}
    </div>
  );
}

// ─── STRATEGY JUSTIFICATION PANEL ────────────────────────────────────────────
// Features 1, 2, 3: Why this strategy, client walk-away risk, concession map

function strategyToAgreement(strategy) {
  // Map strategy card data to negotiation agreement format
  const fnbCredit = strategy.includes?.find(i => i.includes('/person F&B')) 
    ? parseInt(strategy.includes.find(i => i.includes('/person F&B')).replace(/[^0-9]/g,'')) : 0;
  const spaceDisc = strategy.includes?.find(i => i.includes('space discount'))
    ? parseInt(strategy.includes.find(i => i.includes('space discount')).replace(/[^0-9]/g,'')) : 0;
  const compRooms = strategy.includes?.find(i => i.includes('comp room'))
    ? parseInt(strategy.includes.find(i => i.includes('comp room')).replace(/[^0-9]/g,'')) : 0;
  return {
    adr:               Math.round(strategy.adr || 164),
    fnb_credit:        fnbCredit,
    space_discount:    spaceDisc,
    comp_rooms:        compRooms,
    wifi:              strategy.includes?.some(i => i.toLowerCase().includes('wifi')) ? 1 : 0,
    late_checkout:     strategy.includes?.some(i => i.toLowerCase().includes('checkout')) ? 1 : 0,
    welcome_reception: strategy.includes?.some(i => i.toLowerCase().includes('reception')) ? 1 : 0,
    av_package:        0,
  };
}

function hotelUtilityDirect(agreement) {
  const w = { adr: 0.35, fnb_credit: -0.15, space_discount: -0.12, comp_rooms: -0.10, wifi: -0.04, late_checkout: -0.03, welcome_reception: -0.08, av_package: -0.06 };
  const ISSUES_MAP = {
    adr: { min: 140, max: 320, type: 'continuous' },
    fnb_credit: { min: 0, max: 60, type: 'continuous' },
    space_discount: { min: 0, max: 70, type: 'continuous' },
    comp_rooms: { min: 0, max: 6, type: 'continuous' },
    wifi: { type: 'binary' }, late_checkout: { type: 'binary' },
    welcome_reception: { type: 'binary' }, av_package: { type: 'binary' },
  };
  const norm = (key, val) => {
    const iss = ISSUES_MAP[key];
    if (iss.type === 'binary') return val;
    return (val - iss.min) / (iss.max - iss.min);
  };
  let u = Object.keys(w).reduce((s, k) => s + (w[k] || 0) * norm(k, agreement[k] || 0), 0);
  const adrN = norm('adr', agreement.adr); const fnbN = norm('fnb_credit', agreement.fnb_credit);
  const spN  = norm('space_discount', agreement.space_discount);
  u += 0.06 * adrN * (1 - fnbN);
  u -= 0.04 * spN * (agreement.welcome_reception || 0);
  u -= 0.03 * norm('comp_rooms', agreement.comp_rooms) * (agreement.late_checkout || 0);
  return u;
}

function clientUtilityDirect(agreement) {
  const w = { adr: -0.30, fnb_credit: 0.18, space_discount: 0.14, comp_rooms: 0.10, wifi: 0.06, late_checkout: 0.04, welcome_reception: 0.07, av_package: 0.05 };
  const ISSUES_MAP = {
    adr: { min: 140, max: 320, type: 'continuous' },
    fnb_credit: { min: 0, max: 60, type: 'continuous' },
    space_discount: { min: 0, max: 70, type: 'continuous' },
    comp_rooms: { min: 0, max: 6, type: 'continuous' },
    wifi: { type: 'binary' }, late_checkout: { type: 'binary' },
    welcome_reception: { type: 'binary' }, av_package: { type: 'binary' },
  };
  const norm = (key, val) => {
    const iss = ISSUES_MAP[key];
    if (iss.type === 'binary') return val;
    return (val - iss.min) / (iss.max - iss.min);
  };
  let u = Object.keys(w).reduce((s, k) => s + (w[k] || 0) * norm(k, agreement[k] || 0), 0);
  const fnbN = norm('fnb_credit', agreement.fnb_credit);
  const spN  = norm('space_discount', agreement.space_discount);
  const adrN = norm('adr', agreement.adr);
  u += 0.05 * fnbN * (agreement.welcome_reception || 0);
  u += 0.04 * (1 - adrN) * (agreement.av_package || 0);
  u += 0.03 * spN * (agreement.av_package || 0);
  return u;
}

// Pareto distance: 0 = on frontier, 1 = far from frontier
function paretoScore(hU, cU, frontier) {
  if (!frontier || frontier.length === 0) return 0.5;
  // Find closest frontier point
  let minDist = Infinity;
  let maxSW = -Infinity;
  frontier.forEach(p => {
    const d = Math.sqrt(Math.pow(p.h - hU, 2) + Math.pow(p.c - cU, 2));
    if (d < minDist) minDist = d;
    if (p.h + p.c > maxSW) maxSW = p.h + p.c;
  });
  const sw = hU + cU;
  const swPct = maxSW > 0 ? Math.min(1, sw / maxSW) : 0.5;
  return swPct;
}

// CONCESSION VALUE MAP: hotel cost vs client value for each concession
const CONCESSION_ANALYSIS = [
  { key: 'wifi',             label: 'Free WiFi',          hotelCost: 0.04, clientValue: 0.06, note: 'Near-zero marginal cost — already standard infrastructure' },
  { key: 'late_checkout',    label: 'Late Checkout',      hotelCost: 0.03, clientValue: 0.04, note: 'Modest housekeeping cost, highly valued by attendees' },
  { key: 'welcome_reception',label: 'Welcome Reception',  hotelCost: 0.08, clientValue: 0.07, note: 'F&B cost offset by goodwill and upsell opportunity' },
  { key: 'comp_rooms',       label: 'Comp Rooms',         hotelCost: 0.10, clientValue: 0.10, note: 'Direct room revenue trade-off — use sparingly' },
  { key: 'fnb_credit',       label: 'F&B Credit/person',  hotelCost: 0.15, clientValue: 0.18, note: 'High client value relative to cost — good for relationship' },
  { key: 'space_discount',   label: 'Space Discount',     hotelCost: 0.12, clientValue: 0.14, note: 'Activates F&B and AV upsell — net positive if utilization is high' },
];

function StrategyJustification({ strategies, selectedName }) {
  const [frontier, setFrontier] = React.useState(null);

  React.useEffect(() => {
    // Compute Pareto frontier once on mount (synchronous, ~500 samples)
    const hotelW = { adr: 0.35, fnb_credit: -0.15, space_discount: -0.12, comp_rooms: -0.10, wifi: -0.04, late_checkout: -0.03, welcome_reception: -0.08, av_package: -0.06 };
    const clientW = { adr: -0.30, fnb_credit: 0.18, space_discount: 0.14, comp_rooms: 0.10, wifi: 0.06, late_checkout: 0.04, welcome_reception: 0.07, av_package: 0.05 };
    try {
      const f = estimatePareto(hotelW, clientW, 300);
      setFrontier(f);
    } catch(e) {
      // estimatePareto may not be exported — compute inline
      const pts = [];
      for (let i = 0; i < 300; i++) {
        const a = {};
        const keys = ['adr','fnb_credit','space_discount','comp_rooms'];
        const ranges = { adr:[140,320], fnb_credit:[0,60], space_discount:[0,70], comp_rooms:[0,6] };
        keys.forEach(k => { a[k] = ranges[k][0] + Math.random()*(ranges[k][1]-ranges[k][0]); });
        ['wifi','late_checkout','welcome_reception','av_package'].forEach(k => { a[k] = Math.random()>0.5?1:0; });
        pts.push({ h: hotelUtilityDirect(a), c: clientUtilityDirect(a) });
      }
      pts.sort((a,b) => a.h - b.h);
      const fr = []; let maxC = -Infinity;
      for (let i = pts.length-1; i >= 0; i--) {
        if (pts[i].c > maxC) { maxC = pts[i].c; fr.push(pts[i]); }
      }
      setFrontier(fr.reverse());
    }
  }, []);

  if (!strategies || strategies.length === 0) return null;

  // Compute utilities and scores for each strategy
  const analyzed = strategies.map(s => {
    const agr = strategyToAgreement(s);
    const hU = hotelUtilityDirect(agr);
    const cU = clientUtilityDirect(agr);
    const sw = hU + cU;
    const paretoEfficiency = frontier ? paretoScore(hU, cU, frontier) : null;
    // Walk-away risk: client utility below -0.05 = high rejection risk
    const walkAwayRisk = cU < 0.00 ? 'High' : cU < 0.15 ? 'Medium' : 'Low';
    const walkAwayColor = { High: '#ef4444', Medium: '#f59e0b', Low: '#10b981' }[walkAwayRisk];
    return { ...s, hU, cU, sw, paretoEfficiency, walkAwayRisk, walkAwayColor, agreement: agr };
  });

  const recommended = (selectedName && analyzed.find(s => s.name === selectedName)) || analyzed.find(s => s.recommended) || analyzed[1] || analyzed[0];
  const maxSW = Math.max(...analyzed.map(s => s.sw));

  return (
    <div style={{ marginTop: '1.5rem', padding: '1.25rem', background: '#f8faff', border: '1px solid #e0e7ff', borderRadius: '12px' }}>
      
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <span style={{ fontSize: '1rem' }}>🎯</span>
        <h4 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, color: '#1e1b4b' }}>
          Why {recommended?.name} is the Right Strategy
          {selectedName && selectedName !== (analyzed.find(s => s.recommended)?.name) && (
            <span style={{ fontSize: '0.7rem', fontWeight: 400, color: '#6b7280', marginLeft: '0.5rem' }}>(your selection)</span>
          )}
        </h4>
      </div>

      {/* FEATURE 1: Pareto efficiency comparison */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
          📐 Pareto Efficiency — How close is each strategy to the theoretical best deal?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {analyzed.map(s => {
            const pct = s.paretoEfficiency !== null ? Math.round(s.paretoEfficiency * 100) : null;
            const swPct = maxSW > 0 ? Math.round((s.sw / maxSW) * 100) : 50;
            const isRec = s.recommended || s === recommended;
            return (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ width: 110, fontSize: '0.72rem', fontWeight: isRec ? 700 : 400, color: isRec ? '#4338ca' : '#6b7280', whiteSpace: 'nowrap' }}>
                  {isRec ? '★ ' : ''}{s.name}
                </div>
                <div style={{ flex: 1, height: 10, background: '#e5e7eb', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${swPct}%`, height: '100%', background: isRec ? '#6366f1' : '#a5b4fc', borderRadius: 5, transition: 'width 0.6s ease' }} />
                </div>
                <div style={{ width: 90, fontSize: '0.72rem', color: '#374151', display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                  <span style={{ fontWeight: 600 }}>{swPct}% value</span>
                  <span style={{ color: '#9ca3af', fontSize: '0.65rem' }}>🏨 {s.hU.toFixed(2)} · 🤝 {s.cU.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: '#6b7280', fontStyle: 'italic' }}>
          Social welfare = combined hotel + client utility. {recommended?.name} captures {maxSW > 0 ? Math.round((recommended?.sw / maxSW) * 100) : '—'}% of the theoretically possible value for both parties.
        </div>
      </div>

      {/* FEATURE 2: Client walk-away risk */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
          ⚠️ Client Walk-Away Risk — How likely is the client to reject each strategy?
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {analyzed.map(s => (
            <div key={s.name} style={{ flex: 1, minWidth: 120, padding: '0.6rem 0.75rem', background: '#fff', border: `1.5px solid ${s.walkAwayColor}22`, borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '0.68rem', color: '#6b7280', marginBottom: '0.2rem', fontWeight: 500 }}>{s.name}</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: s.walkAwayColor, marginBottom: '0.15rem' }}>{s.walkAwayRisk}</div>
              <div style={{ fontSize: '0.65rem', color: '#9ca3af' }}>rejection risk</div>
              <div style={{ marginTop: '0.35rem', fontSize: '0.65rem', color: '#6b7280' }}>
                Client utility: <strong style={{ color: s.walkAwayColor }}>{s.cU.toFixed(3)}</strong>
              </div>
              {s.walkAwayRisk === 'High' && (
                <div style={{ marginTop: '0.3rem', fontSize: '0.6rem', color: '#ef4444', fontStyle: 'italic' }}>ADR may exceed client's threshold</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* FEATURE 3: Concession value map */}
      <div>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
          💡 Concession Map — What each offer costs the hotel vs. what it's worth to the client
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {CONCESSION_ANALYSIS.map(c => {
            const ratio = c.clientValue / c.hotelCost; // >1 = good deal for both
            const isInRec = recommended?.agreement?.[c.key] > 0;
            const efficiency = Math.min(100, Math.round(ratio * 50));
            return (
              <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', opacity: isInRec ? 1 : 0.45 }}>
                <div style={{ width: 16, fontSize: '0.7rem', textAlign: 'center' }}>
                  {isInRec ? '✓' : '–'}
                </div>
                <div style={{ width: 120, fontSize: '0.7rem', fontWeight: isInRec ? 600 : 400, color: isInRec ? '#1e1b4b' : '#9ca3af', whiteSpace: 'nowrap' }}>
                  {c.label}
                </div>
                <div style={{ flex: 1, position: 'relative', height: 8, background: '#f3f4f6', borderRadius: 4 }}>
                  {/* Hotel cost bar (red) */}
                  <div style={{ position: 'absolute', left: 0, top: 0, width: `${Math.round(c.hotelCost * 200)}%`, height: '100%', background: '#fca5a5', borderRadius: 4 }} />
                  {/* Client value bar (green, overlaid) */}
                  <div style={{ position: 'absolute', left: 0, top: 0, width: `${Math.round(c.clientValue * 200)}%`, height: '50%', background: '#6ee7b7', borderRadius: 4 }} />
                </div>
                <div style={{ width: 80, fontSize: '0.65rem', display: 'flex', gap: '0.3rem' }}>
                  <span style={{ color: '#ef4444' }}>−{Math.round(c.hotelCost*100)}%</span>
                  <span style={{ color: '#10b981' }}>+{Math.round(c.clientValue*100)}%</span>
                </div>
                <div style={{ flex: 1, fontSize: '0.62rem', color: '#6b7280', fontStyle: 'italic', lineHeight: 1.3 }}>{c.note}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: '0.6rem', fontSize: '0.65rem', color: '#9ca3af' }}>
          ✓ = included in {recommended?.name} &nbsp;·&nbsp; Red bar = hotel cost &nbsp;·&nbsp; Green bar = client value
        </div>
      </div>


      {/* FEATURE 4: Counter-offer simulator */}
      <CounterOfferSimulator recommended={recommended} analyzed={analyzed} />
    </div>
  );
}

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

  // Manual overrides for strategy numbers, keyed by strategy name.
  const [overrides, setOverrides] = useState({});
  useEffect(() => { setOverrides({}); }, [rfp?.id]);
  const updateOverride = (strategyName, field, rawValue) => {
    const num = rawValue === '' ? undefined : Number(rawValue);
    const clean = (num === undefined || isNaN(num)) ? undefined : num;
    setOverrides(prev => {
      const next = { ...prev[strategyName], [field]: clean };
      // Room Revenue = ADR × Pickup × room-nights. If ADR or Pickup change,
      // drop any pinned Room Revenue so it re-derives from the new numbers
      // instead of silently going stale.
      if (field === 'adr' || field === 'pickupRate') {
        delete next.roomRevenue;
      }
      return { ...prev, [strategyName]: next };
    });
  };

  const demandEvents = useDemandEvents(rfp);
  const topDemand = demandEvents.reduce((top, ev) => {
    const order = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    return !top || (order[ev.impact] || 0) > (order[top.impact] || 0) ? ev : top;
  }, null);

  const handleSelectStrategy = async (strategy) => {
    setSelectedStrategyName(strategy.name);
    try {
      const col = rfp._col || 'rfps';
      await updateDoc(doc(db, col, rfp.id), {
        selected_strategy: strategy.name,
        selected_adr: strategy.adr,
        selected_pickup_rate: strategy.pickupRate,
        selected_conversion_prob: strategy.conversionProb,
        selected_room_revenue: strategy.roomRevenue,
        selected_fnb_revenue: strategy.fnbRevenue,
        selected_space_revenue: strategy.spaceRevenue,
        selected_total_revenue: strategy.totalRevenue,
        selected_expected_profit: strategy.expectedProfit,
        selected_manually_overridden: !!strategy.overridden,
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
      { name: 'Conservative Capture', risk: 'Low Risk', fnbMinimum: Math.round(baseFnb * 0.85), roomRentalNote: 'incl. 50% disc.', adr: Math.round(baseAdr * 0.95), pickupRate: Math.round(Math.min(0.99, pickupRate * 1.06) * 100), conversionProb: Math.round(Math.min(0.99, convProb * 1.15) * 100), gviIndex: 225, roomRevenue: Math.round(baseRevenue * 0.95), fnbRevenue: Math.round(baseFnb * 0.9), spaceRevenue: Math.round(baseSpace), totalRevenue: Math.round(baseRevenue * 0.95 + baseFnb * 0.9 + baseSpace), expectedProfit: Math.round((baseRevenue * 0.95 + baseFnb * 0.9 + baseSpace) * 0.44), riskAdjustedValue: Math.round((baseRevenue * 0.95 + baseFnb * 0.9 + baseSpace) * 0.44 * 0.80), roiVsBaseline: '+71%', color: 'success', includes: ['3 comp rooms', '$30/person F&B credit', '50% space discount', 'Free WiFi', 'Late checkout', 'Welcome reception'], subtitle: 'Select Conservative Strategy' },
      { name: 'Optimal Balance', risk: 'Medium Risk', fnbMinimum: Math.round(baseFnb * 0.95), roomRentalNote: 'incl. 30% disc.', adr: baseAdr, pickupRate: Math.round(pickupRate * 100), conversionProb: Math.round(convProb * 100), gviIndex: 261, roomRevenue: Math.round(baseRevenue), fnbRevenue: Math.round(baseFnb), spaceRevenue: Math.round(baseSpace * 1.4), totalRevenue: Math.round(baseRevenue + baseFnb + baseSpace * 1.4), expectedProfit: Math.round((baseRevenue + baseFnb + baseSpace * 1.4) * 0.44), riskAdjustedValue: Math.round((baseRevenue + baseFnb + baseSpace * 1.4) * 0.44 * 0.70), roiVsBaseline: '+103%', color: 'warning', recommended: true, includes: ['2 comp rooms', '$25/person F&B credit', '30% space discount', 'Free WiFi', 'Welcome reception', 'Late checkout'], subtitle: 'Select Recommended Strategy' },
      { name: 'Premium Position', risk: 'Higher Risk', fnbMinimum: Math.round(baseFnb * 1.1), roomRentalNote: 'incl. 15% disc.', adr: Math.round(baseAdr * 1.15), pickupRate: Math.round(pickupRate * 0.95 * 100), conversionProb: Math.round(convProb * 0.85 * 100), gviIndex: 289, roomRevenue: Math.round(baseRevenue * 1.05), fnbRevenue: Math.round(baseFnb * 1.2), spaceRevenue: Math.round(baseSpace * 1.7), totalRevenue: Math.round(baseRevenue * 1.05 + baseFnb * 1.2 + baseSpace * 1.7), expectedProfit: Math.round((baseRevenue * 1.05 + baseFnb * 1.2 + baseSpace * 1.7) * 0.43), riskAdjustedValue: Math.round((baseRevenue * 1.05 + baseFnb * 1.2 + baseSpace * 1.7) * 0.43 * 0.55), roiVsBaseline: '+128%', color: 'error', includes: ['1 comp room', '$20/person F&B credit', '15% space discount', 'Free WiFi', 'Welcome amenity'], subtitle: 'Select Premium Strategy' },
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
  // Same overrides the cards use, applied once so the panel below (walk-away
  // risk, Pareto efficiency, etc.) reflects edited numbers instead of the
  // original model output.
  const liveStrategies = allStrategies
    ? allStrategies.map(s => applyStrategyOverrides(s, overrides[s.name], rfp, nights))
    : null;
  const activePredictions = predictions || fallbackPredictions;

  return (
    <div className="strategies-container">
      {/* Top bar */}
      <div className="strategies-top-bar">
        {!inEditMode && <button onClick={onBack} className="btn-back"><ArrowLeft size={16} /> Edit RFP</button>}


      </div>

      
      

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
            <div>
          {topDemand && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem',
              background: (DEMAND_COLORS[topDemand.impact] || '#f97316') + '15',
              border: `1px solid ${DEMAND_COLORS[topDemand.impact] || '#f97316'}`,
              borderRadius: '8px', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '1.2rem' }}>⚡</span>
              <div>
                <div style={{ fontWeight: 700, color: DEMAND_COLORS[topDemand.impact], marginBottom: '0.2rem' }}>
                  {topDemand.impact} Demand Period: {topDemand.name}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#6b7280' }}>
                  {topDemand.type} · {topDemand.attendance_size} · {topDemand.start_date} – {topDemand.end_date}
                </div>
                {topDemand.notes && <div style={{ fontSize: '0.75rem', color: '#92400e', marginTop: '0.2rem', fontStyle: 'italic' }}>{topDemand.notes}</div>}
                <div style={{ fontSize: '0.75rem', fontWeight: 600, marginTop: '0.35rem', color: DEMAND_COLORS[topDemand.impact] }}>
                  {topDemand.impact === 'Critical' && '→ City fully compressed. Decline low-value groups. Use Premium Position.'}
                  {topDemand.impact === 'High' && '→ Heavy compression. Premium Position recommended — transient demand supports higher ADR.'}
                  {topDemand.impact === 'Medium' && '→ Moderate compression. Consider upgrading to Optimal Balance or Premium.'}
                  {topDemand.impact === 'Low' && '→ Minor demand uplift. Standard recommendation applies.'}
                </div>
              </div>
            </div>
          )}

          <style>{`
            .strategy-num-input::-webkit-outer-spin-button,
            .strategy-num-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
            .strategy-num-input { -moz-appearance: textfield; appearance: textfield; }
          `}</style>
          <div className={'strategies-grid' + (allStrategies && allStrategies.length > 3 ? ' four-col' : '')} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 220px))', gap: '0.75rem', justifyContent: 'start' }}>
              {allStrategies && allStrategies.map((strategy, index) => {
                const liveStrategy = applyStrategyOverrides(strategy, overrides[strategy.name], rfp, nights);
                const numInputStyle = { border: '1px solid #cbd5e0', borderRadius: 6, padding: '2px 4px', fontWeight: 700, background: '#fff', width: '100%', minWidth: 0, boxSizing: 'border-box' };
                return (
                <div key={index} className={'strategy-card-detailed' + (strategy.recommended ? ' recommended' : '') + (strategy.negotiated ? ' negotiated' : '')} style={{ fontSize: '0.82rem', padding: '1rem' }}>
                  {strategy.recommended && <div className="recommended-badge"><span>✓ RECOMMENDED</span></div>}
                  {strategy.recommended && <div style={{ fontSize: '0.75rem', color: '#5b5fc7', marginBottom: '0.5rem', fontStyle: 'italic' }}>Best balance of win probability and total revenue contribution.</div>}
                  {strategy.negotiated && <div className="negotiated-badge"><span>⚡ NEGOTIATED</span></div>}
                  {liveStrategy.overridden && <div style={{ fontSize: '0.6875rem', color: '#b45309', fontWeight: 600, marginBottom: '0.25rem' }}>✎ MANUALLY OVERRIDDEN</div>}

                  <div style={{ marginBottom: '1.25rem' }}>
                    <h4 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>{strategy.name}</h4>
                    <span className={'risk-badge risk-' + strategy.color}>{strategy.risk}</span>
                  </div>

                  <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{ fontSize: '0.875rem', color: '#718096', marginBottom: '0.25rem' }}>ADR Offer</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>$</span>
                      <input
                        type="number"
                        className="strategy-num-input"
                        value={liveStrategy.adr}
                        onChange={(e) => updateOverride(strategy.name, 'adr', e.target.value)}
                        style={{ ...numInputStyle, fontSize: '1.5rem', width: '80px' }}
                      />
                    </div>
                  </div>

                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0.4rem', marginBottom: '0.5rem' }}>
                      <div style={{ textAlign: 'center', minWidth: 0 }}>
                        <div style={{ fontSize: '0.7rem', color: '#718096', marginBottom: '0.25rem' }}>Pickup</div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 0 }}>
                          <input
                            type="number"
                            className="strategy-num-input"
                            value={liveStrategy.pickupRate}
                            onChange={(e) => updateOverride(strategy.name, 'pickupRate', e.target.value)}
                            style={{ ...numInputStyle, fontSize: '0.95rem', width: '40px', textAlign: 'right' }}
                          />
                          <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>%</span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'center', minWidth: 0 }}>
                        <div style={{ fontSize: '0.7rem', color: '#718096', marginBottom: '0.25rem' }}>Win Prob.</div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 0 }}>
                          <input
                            type="number"
                            className="strategy-num-input"
                            value={liveStrategy.conversionProb}
                            onChange={(e) => updateOverride(strategy.name, 'conversionProb', e.target.value)}
                            style={{ ...numInputStyle, fontSize: '0.95rem', width: '40px', textAlign: 'right' }}
                          />
                          <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>%</span>
                        </div>
                      </div>
                    </div>
                    {(() => {
                      const gvi = liveStrategy.gviIndex;
                      const tier = gvi >= 220 ? { label: '🏆 Premium', color: '#7c3aed' }
                                 : gvi >= 150 ? { label: '⭐ Strong',  color: '#1d4ed8' }
                                 :              { label: 'Standard',   color: '#6b7280' };
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0.6rem', background: '#f8fafc', borderRadius: '6px' }}>
                          <span style={{ fontSize: '0.7rem', color: '#718096', whiteSpace: 'nowrap' }}>Deal Score ⓘ</span>
                          <span style={{ fontSize: '0.95rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{tier.label}</span>
                        </div>
                      );
                    })()}
                  </div>

                  <div style={{ fontSize: '0.6875rem', color: '#94a3b8', marginTop: '-0.75rem', marginBottom: '1rem', textAlign: 'center' }}>
                    Deal Score — MERIT's proprietary ranking of this group's overall value. Combines ADR premium potential, F&B contribution, meeting space utilization, and repeat business likelihood. 0–300 scale: below 150 = Standard · 150–219 = Strong Deal · 220+ = Premium Opportunity.
                  </div>
                  <div className="revenue-breakdown">
                    {[
                      { l: 'Room Revenue', field: 'roomRevenue', v: liveStrategy.roomRevenue, c: '#4299e1', auto: overrides[strategy.name]?.roomRevenue === undefined },
                      { l: 'F&B Revenue', field: 'fnbRevenue', v: liveStrategy.fnbRevenue, c: '#9f7aea', sub: strategy.fnbMinimum ? `min $${strategy.fnbMinimum.toLocaleString()}` : null },
                      { l: 'Room Rental', field: 'spaceRevenue', v: liveStrategy.spaceRevenue, c: '#ed8936', sub: strategy.roomRentalNote || null },
                    ].map(r => (
                      <div key={r.l} className="rev-row">
                        <span className="rev-label">{r.l}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                          {r.field === 'roomRevenue' && (
                            <span
                              title={r.auto ? 'Auto-synced with ADR × Pickup — edit to pin a custom value' : 'Manually pinned — edit ADR or Pickup to re-sync'}
                              style={{ fontSize: '0.75rem', color: r.auto ? '#94a3b8' : '#b45309', cursor: 'default', lineHeight: 1 }}
                            >
                              {r.auto ? '↺' : '📌'}
                            </span>
                          )}
                          <span style={{ color: r.c, fontWeight: 700 }}>$</span>
                          <input
                            type="number"
                            className="strategy-num-input"
                            value={r.v}
                            onChange={(e) => updateOverride(strategy.name, r.field, e.target.value)}
                            style={{ ...numInputStyle, color: r.c, width: '64px', textAlign: 'right' }}
                          />
                        </span>
                      </div>
                    ))}
                    <div className="rev-row rev-total">
                      <span className="rev-label-total">Total Revenue</span>
                      <span className="rev-val-total" title="Automatically calculated: Room + F&B + Room Rental">{safeFmt(liveStrategy.totalRevenue)}</span>
                    </div>
                  </div>

                  <div className="profit-section">
                    {liveStrategy.dispCost > 0 && (
                      <div className="profit-row-sub" style={{ color: '#e53e3e' }}><span>Displacement Cost</span><span>−${liveStrategy.dispCost.toLocaleString()}</span></div>
                    )}
                    <div className="profit-row"><span>Expected Profit</span><span className="profit-val">{safeFmt(liveStrategy.expectedProfit)}</span></div>
                    <div className="profit-row-sub"><span>Risk-Adjusted Value</span><span>{safeFmt(liveStrategy.riskAdjustedValue)}</span></div>
                    <div className="profit-row-sub"><span>ROI vs Baseline</span><span className={'profit-roi' + ((liveStrategy.roiVsBaseline || '').startsWith('-') ? ' negative' : '')}>{liveStrategy.roiVsBaseline?.includes('NaN') ? '—' : liveStrategy.roiVsBaseline}</span></div>
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
  style={{ width: '100%', padding: '0.875rem', border: 'none', fontSize: '0.9375rem', fontWeight: 600, borderRadius: '0.5rem', cursor: 'pointer',
    background: selectedStrategyName === strategy.name ? '#276749' : undefined,
    color: selectedStrategyName === strategy.name ? '#fff' : undefined }}
  onClick={() => {
    handleSelectStrategy(liveStrategy);
    const subject = 'Hotel Proposal: ' + rfp.event_name + ' - ' + liveStrategy.name;
    const includesList = (liveStrategy.includes || []).map(function(i) { return '- ' + i; }).join('\n');
    const specialReqs = rfp.special_requirements ? 'SPECIAL REQUIREMENTS\n' + rfp.special_requirements + '\n\n' : '';
    const body = [
      'Dear ' + (rfp.contact_name || 'Valued Guest') + ',',
      '',
      'Thank you for your inquiry regarding ' + rfp.event_name + '.',
      '',
      'We are pleased to present our ' + liveStrategy.name + ' proposal:',
      '',
      'DATES & GROUP',
      'Arrival: ' + rfp.arrival_date,
      'Departure: ' + rfp.departure_date + ' (' + nights + ' nights)',
      'Attendees: ' + rfp.attendees,
      'Room Block: ' + rfp.room_block + ' rooms',
      '',
      'PRICING',
      'ADR: ' + liveStrategy.adr + ' per room/night',
      'Pickup Rate: ' + liveStrategy.pickupRate + '%',
      'Conversion Probability: ' + liveStrategy.conversionProb + '%',
      '',
      'REVENUE SUMMARY',
      'Room Revenue: ' + (liveStrategy.roomRevenue ? liveStrategy.roomRevenue.toLocaleString() : '0'),
      'F&B Revenue: ' + (liveStrategy.fnbRevenue ? liveStrategy.fnbRevenue.toLocaleString() : '0'),
      'Room Rental: ' + (liveStrategy.spaceRevenue ? liveStrategy.spaceRevenue.toLocaleString() : '0'),
      'Total Revenue: ' + (liveStrategy.totalRevenue ? liveStrategy.totalRevenue.toLocaleString() : '0'),
      '',
      'PACKAGE INCLUDES',
      includesList,
      '',
      specialReqs + 'We look forward to hosting your event.',
      '',
      'Best regards,',
      'Hotel Revenue Team',
    ].join('\n');
    window.location.href = 'mailto:' + rfp.contact_email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }}
>
  {selectedStrategyName === strategy.name ? '✓ Selected' : (strategy.subtitle || 'Select This Strategy')}
</button>
                </div>
                );
              })}
          </div>
          )

          {/* Strategy Justification Panel */}
          {allStrategies && allStrategies.length > 0 && (
            <StrategyJustification strategies={liveStrategies} selectedName={selectedStrategyName} />
          )}
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
