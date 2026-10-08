import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import {
  TrendingUp, AlertTriangle, CheckCircle2, XCircle, Clock,
  RefreshCw, ChevronDown, ChevronUp, Zap, DollarSign,
  Building2, Sparkles, Filter, Star, ArrowUp, ArrowDown,
  Minus, SlidersHorizontal, X, AlertCircle,
} from 'lucide-react';
import { XGBOOST_TREES } from '../xgboost_trees_data_v7.js';
import { useMarketSignals, computeMarketSignals, SIGNAL_DEFAULTS, useHotelConfig, CONFIG_DEFAULTS } from '../marketSignals';
import './RankingView.css';

// ─── XGBoost engine ──────────────────────────────────────────────────────────

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
  const m = XGBOOST_TREES[name];
  if (!m) return null;
  return xgbPredict(m, m.f.map(f => dict[f] ?? 0));
}

const SEASON_MAP   = { 12:0,1:0,2:0, 3:1,4:1,5:1, 6:2,7:2,8:2, 9:3,10:3,11:3 };
const TODAY        = new Date('2026-04-21');
const TOTAL_ROOMS  = 220;
const BASELINE_ADR = 164; // Hotel rack rate baseline

// Cyclical encoding (must match training pipeline)
const cosMonth = m => Math.cos(2 * Math.PI * m / 12);
const sinMonth = m => Math.sin(2 * Math.PI * m / 12);
const sinQ     = m => Math.sin(2 * Math.PI * Math.ceil(m / 3) / 4);
const sigmoid  = x => 1 / (1 + Math.exp(-x));

function scoreRFP(rfp, bookedMap, signals = SIGNAL_DEFAULTS, config = CONFIG_DEFAULTS) {
  const arrival   = new Date(rfp.Arrival_Date   || rfp.arrival_date);
  const departure = new Date(rfp.Departure_Date || rfp.departure_date);
  const inquiry   = new Date(rfp.Inquiry_Date   || rfp.inquiry_date || TODAY);
  const nights    = Math.max(1, Math.round((departure - arrival)  / 86400000));
  const leadTime  = Math.max(0, Math.round((arrival  - inquiry)   / 86400000));
  const month     = arrival.getMonth() + 1;
  const season    = SEASON_MAP[month] ?? 2;
  const roomBlock = Number(rfp.Peak_Room_Block || rfp.room_block || 50);
  const attendees = Number(rfp.Attendees || rfp.attendees || roomBlock * 1.4);
  const trn       = roomBlock * nights;
  const hasMtgNum = Number(
    rfp.Has_Meeting_Space || rfp.has_meeting_space ||
    rfp.Uses_Ballroom || rfp.uses_ballroom ||
    rfp.Uses_Boardroom || rfp.uses_boardroom ||
    (Number(rfp.Num_Meeting_Rooms || rfp.num_meeting_rooms || 0) > 0) ||
    rfp.num_meeting_rooms_count > 0 ||
    0
  );
  const usesBal   = Number(rfp.Uses_Ballroom || rfp.uses_ballroom || 0);

  // on_books_occupancy_pct is stored as 0–100 in the model (not 0–1)
  let occPct = Number(rfp.Forecasted_Occupancy || rfp.forecasted_occupancy || 0.72);
  if (occPct <= 1) occPct = occPct * 100; // normalise to 0–100

  // Conflict detection
  let conflictRooms = false, conflictSpace = false, maxTaken = 0;
  for (let d = new Date(arrival); d < departure; d.setDate(d.getDate() + 1)) {
    const bk = bookedMap[d.toISOString().slice(0, 10)] || { rooms: 0, ballroom: false };
    maxTaken = Math.max(maxTaken, bk.rooms);
    if (bk.rooms + roomBlock > TOTAL_ROOMS * 0.90) conflictRooms = true;
    if (hasMtgNum && usesBal && bk.ballroom) conflictSpace = true;
  }
  const feasible       = !conflictRooms && !conflictSpace;
  const roomsAvailPeak = Math.max(0, TOTAL_ROOMS - maxTaken);

  // Days to nearest peak season (spring peak ~day 75, fall peak ~day 258)
  const dayOfYear  = Math.floor((arrival - new Date(arrival.getFullYear(), 0, 0)) / 86400000);
  const dtsPeak    = Math.min(Math.abs(dayOfYear - 75), Math.abs(dayOfYear - 258));
  const isShoulderSeason = (season === 1 || season === 3) ? 1 : 0;

  // Feature dict keyed exactly to model feature names, with correct scales
  const bf = {
    // Time (cyclical)
    arrival_month_cos:   cosMonth(month),
    arrival_month_sin:   sinMonth(month),
    arrival_quarter_sin: sinQ(month),

    // Volume
    total_room_nights:        trn,
    Rooms_Available_Peak_Date: roomsAvailPeak,
    Meeting_Space_Ratio:      hasMtgNum ? Math.min(2.0, 1 / Math.max(1, roomBlock) * 10) : 0,

    // Occupancy (0–100 scale to match training data)
    on_books_occupancy_pct: occPct,
    avg_room_utilization:   occPct / 100,  // this one stays 0–1

    // Temporal context
    days_to_peak_season: Math.min(132, dtsPeak),
    is_shoulder_season:  isShoulderSeason,

    // Pricing (dollar-scale features)
    pricing_pressure_index: occPct > 80 ? 1.4 : occPct > 65 ? 1.1 : 0.95,
    rate_spread:            BASELINE_ADR * 0.10,  // ~$16 typical group discount spread
    Flag_Rate_Below_Baseline: 0,

    // F&B
    fnb_ratio: hasMtgNum ? 0.40 : 0.10,

    // Demand signals (capacity_pressure_score is 0–0.25 range in training)
    Displacement_Risk_Score:     occPct > 75 ? 0.65 : 0.30,
    displacement_ratio:          Math.min(0.30, occPct / 100 * 0.25),
    capacity_pressure_score:     Math.min(0.25, occPct / 100 * 0.22),
    displacement_velocity_30_90d: signals.displacement_velocity_30_90d,
    displacement_acceleration:    signals.displacement_acceleration,

    // Market signals — computed from Firestore by marketSignals.js
    avg_discount_nearby_30d:   signals.avg_discount_nearby_30d,
    rfp_volume_acceleration:   signals.rfp_volume_acceleration,
    occupancy_velocity_30_90d: signals.occupancy_velocity_30_90d,
    smerf_demand_30d:          signals.smerf_demand_30d,
    booking_pace_7_30d:        signals.booking_pace_7_30d,
    revenue_velocity_30_90d:   signals.revenue_velocity_30_90d,
    revenue_acceleration:      signals.revenue_acceleration,

    // Account/pipeline (Urgency_Index range 0.01–0.22 in training)
    win_streak:                    3,
    win_rate_velocity_30_90d:      signals.win_rate_velocity_30_90d,
    business_momentum_score:       0.50,
    Urgency_Index:                 Math.max(0.01, Math.min(0.20, (365 - leadTime) / 3650)),
    budget_amount:                 Math.min(65000, trn * BASELINE_ADR * 0.85),
    Account_Prior_Booked:          8,
    competing_rfps_same_week_segment: signals.competing_rfps_same_week_segment,
    arrival_clustering_score:      0.07,
    days_since_last_segment_rfp:   7,
    days_since_last_account_rfp:   25,
    destinations_considered:       2,
    lead_source_encoded:           2,
  };

  // quoted_adr: now enabled — real market signals make this prediction meaningful.
  // Falls back to rack-rate × 0.88 if the model key is absent.
  const adrRaw    = predictSingle('quoted_adr', bf);
  const quotedADR = adrRaw !== null && adrRaw > 80 && adrRaw < 400
    ? Math.round(adrRaw)
    : Math.round(BASELINE_ADR * 0.88);

  const pickupRaw = predictSingle('pickup_ipw', bf);
  const convRaw   = predictSingle('conversion', bf);
  const fnbRaw    = predictSingle('fnb', bf);

  const pickup = pickupRaw !== null
    ? Math.min(0.98, Math.max(0.35, sigmoid(pickupRaw)))
    : 0.70;
  const conv = convRaw !== null
    ? Math.min(0.98, Math.max(0.15, sigmoid(convRaw)))
    : 0.60;
  const fnbPP = Math.max(hasMtgNum ? 25 : 0, fnbRaw ?? 55);

  const roomRev  = quotedADR * trn * pickup;
  const fnbRev   = fnbPP * attendees * (hasMtgNum ? 1 : 0.25);
  const mtgRev   = hasMtgNum ? roomBlock * config.meeting_rate_per_room_night * nights : 0;
  const grossRev = roomRev + fnbRev + mtgRev;
  const dispCost = BASELINE_ADR * roomBlock * nights * config.displacement_factor * (occPct / 100);
  const netValue = grossRev - dispCost;
  const expValue = netValue * conv * (feasible ? 1 : 0.35);

  const rd  = new Date(inquiry);
  rd.setDate(rd.getDate() + (Number(rfp.Response_Due_Days || rfp.response_due_days || 10)));
  const dtr = Math.round((rd - TODAY) / 86400000);
  const urgency = dtr <= 0 ? 'Overdue' : dtr <= 3 ? 'Critical' : dtr <= 7 ? 'High' : dtr <= 14 ? 'Medium' : 'Low';
  const daysUntilArrival = Math.max(0, Math.round((arrival - TODAY) / 86400000));

  return {
    baseADR: Math.round(BASELINE_ADR), quotedADR: Math.round(quotedADR),
    adrFromModel: adrRaw !== null && adrRaw > 80 && adrRaw < 400,
    pickup, conv, fnbPP: Math.round(fnbPP),
    roomRev: Math.round(roomRev), fnbRev: Math.round(fnbRev), mtgRev: Math.round(mtgRev),
    grossRev: Math.round(grossRev), dispCost: Math.round(dispCost),
    netValue: Math.round(netValue), expValue: Math.round(expValue),
    feasible, conflictRooms, conflictSpace,
    roomsAvail: roomsAvailPeak,
    nights, leadTime, season: ['Winter', 'Spring', 'Summer', 'Fall'][season],
    urgency, daysToRespond: dtr, daysUntilArrival,
    trn, roomBlock, attendees, hasMtg: !!hasMtgNum,
    occ: occPct / 100,
    // config values used — lets the UI note exactly what was applied
    meetingRateUsed:      config.meeting_rate_per_room_night,
    displacementFactorUsed: config.displacement_factor,
  };
}

// ─── Ranking Method Definitions ───────────────────────────────────────────────

const RANKING_METHODS = [
  {
    id: 'composite',
    label: 'Composite Score',
    icon: '⚖️',
    color: '#5b5fc7',
    tagline: 'Balanced across 5 dimensions',
    description: 'A weighted score combining estimated deal value (45%), win likelihood (20%), F&B and meeting space potential (15%), arrival season (10%), and room availability (10%). Pickup and win probability are AI-predicted from your live booking history. Best as your default view — no single factor can dominate the ranking.',
    proscons: [
      { pro: true,  text: 'Balances multiple business goals simultaneously' },
      { pro: true,  text: 'Transparent formula — easy to explain to ownership' },
      { pro: false, text: 'Weights are manually tuned and may not match your quarter\'s priorities' },
      { pro: false, text: 'Can bury high-certainty small deals under uncertain big ones' },
    ],
    compute: (sc) => {
      const sm = { Winter: 0.85, Spring: 1.10, Summer: 0.95, Fall: 1.20 }[sc.season] ?? 1.0;
      return (sc.expValue / 1500) * 0.45 + sc.conv * 35 * 0.20 +
        (sc.hasMtg ? 8 : 0) * 0.15 + sm * 10 * 0.10 + (sc.feasible ? 10 : 0) * 0.10;
    },
    formatScore: v => v.toFixed(1),
    scoreLabel: 'Score',
  },
  {
    id: 'ev',
    label: 'Expected Value',
    icon: '💰',
    color: '#10b981',
    tagline: 'Net revenue × win probability',
    description: 'Ranks purely by (net group revenue − transient displacement cost) × conversion probability. Net revenue is built from XGBoost-predicted ADR (falling back to rack rate × group discount from hotel_config/settings), XGBoost pickup rate, and Firestore-configured meeting and F&B rates. Displacement cost uses the factor stored in hotel_config/settings, scaled by forecasted occupancy. All market signals feeding the models are computed live from booked_events, rfps, and incoming_rfps.',
    proscons: [
      { pro: true,  text: 'Directly tied to P&L — easy to defend to ownership' },
      { pro: true,  text: 'Pickup, conversion, F&B, and ADR all come from XGBoost' },
      { pro: false, text: 'Treats a 40% shot at $100K the same as 80% shot at $50K' },
      { pro: false, text: 'Ignores strategic value of new client relationships' },
    ],
    compute: (sc) => sc.expValue,
    formatScore: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : Math.round(v)),
    scoreLabel: 'EV',
  },
  {
    id: 'riskadjusted',
    label: 'Risk-Adjusted EV',
    icon: '🛡️',
    color: '#8b5cf6',
    tagline: 'EV penalized for uncertainty',
    description: 'EV − λ × √variance, where variance = EV² × (1−conversion). Conversion probability is XGBoost-predicted. The λ slider controls risk aversion: at λ=0 this equals pure EV; at λ=1 it strongly favors reliable smaller deals over uncertain large ones. The "All Method Scores" panel always shows this at default λ=0.5 — the slider only applies when this method is active.',
    proscons: [
      { pro: true,  text: 'Captures real preference for certainty over maximizing upside' },
      { pro: true,  text: 'Risk tolerance is explicit and adjustable in real time' },
      { pro: false, text: 'λ is subjective — different managers will calibrate it differently' },
      { pro: false, text: 'Can over-penalize high-value deals that are merely competitive' },
    ],
    compute: (sc, w) => {
      const lambda = w?.riskAversion ?? 0.5;
      const variance = Math.pow(sc.expValue, 2) * (1 - sc.conv);
      return sc.expValue - lambda * Math.sqrt(variance) * 0.01;
    },
    formatScore: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : Math.round(v)),
    scoreLabel: 'Risk-Adj EV',
    hasSlider: true,
    sliderKey: 'riskAversion',
    sliderLabel: 'Risk Aversion (λ)',
    sliderMin: 0, sliderMax: 1, sliderStep: 0.05, sliderDefault: 0.5,
    sliderHints: ['λ=0: pure EV', 'λ=1: max caution'],
  },
  {
    id: 'revpar',
    label: 'RevPAR Uplift',
    icon: '📐',
    color: '#f59e0b',
    tagline: 'Net revenue per room-night consumed',
    description: 'Net value ÷ total room-nights consumed by this group. Normalizes for group size — a 20-room high-F&B wedding can outrank a 100-room commodity booking if its revenue per room-night is higher. Net value is derived from XGBoost pickup and ADR predictions plus configured meeting and F&B rates, minus displacement cost at the configured factor. This is how Marriott and Hilton corporate revenue managers evaluate displacement: every room-night has an opportunity cost.',
    proscons: [
      { pro: true,  text: 'Fair comparison between groups of very different sizes' },
      { pro: true,  text: 'Directly answers "is this group worth displacing transient?"' },
      { pro: false, text: 'Can rank tiny high-margin events above strategically important large groups' },
      { pro: false, text: 'Doesn\'t capture absolute dollar magnitude' },
    ],
    compute: (sc) => sc.trn > 0 ? sc.netValue / sc.trn : 0,
    formatScore: v => '$' + Math.round(v) + '/rn',
    scoreLabel: '$/room-night',
  },
  {
    id: 'displacement',
    label: 'Displacement-First',
    icon: '🔄',
    color: '#ef4444',
    tagline: 'Rank by net benefit over displacement cost',
    description: 'Score = (grossRevenue − displacementCost) / displacementCost. Asks: how well does this group compensate for the transient revenue it displaces? Displacement cost is computed as rack rate × rooms × nights × displacement_factor (from hotel_config/settings) × forecasted occupancy — so it scales with how busy those dates are. High scores mean the group more than justifies what it displaces. Most meaningful when occupancy is above 70%.',
    proscons: [
      { pro: true,  text: 'Correct framing on high-demand dates where displacement is real' },
      { pro: true,  text: 'Surfaces groups that bring strong total revenue beyond rooms' },
      { pro: false, text: 'On slow dates displacement is minimal — collapses to gross revenue ranking' },
      { pro: false, text: 'Requires accurate transient demand forecasts to be truly meaningful' },
    ],
    compute: (sc) => sc.dispCost > 10 ? (sc.grossRev - sc.dispCost) / sc.dispCost : sc.grossRev / 5000,
    formatScore: v => v.toFixed(2) + '×',
    scoreLabel: 'Net/Disp Ratio',
  },
  {
    id: 'timedecay',
    label: 'Time-Discounted EV',
    icon: '⏳',
    color: '#06b6d4',
    tagline: 'EV weighted by days until arrival',
    description: 'EV × e^(−δ × daysUntilArrival / 365). Near-term deals rank higher because there is less time to replace them if lost. EV itself is fully XGBoost-informed — pickup, conversion, F&B, and (when available) ADR all come from models fed by live Firestore market signals. The δ slider controls decay aggressiveness. The "All Method Scores" panel always uses the default δ=0.4 — the slider only applies when this method is active.',
    proscons: [
      { pro: true,  text: 'Naturally surfaces urgent near-term opportunities' },
      { pro: true,  text: 'Mirrors the economic reality of perishable room inventory' },
      { pro: false, text: 'Systematically depresses long-lead pipeline — can cause short-termism' },
      { pro: false, text: 'Decay rate is hard to calibrate without outcome tracking' },
    ],
    compute: (sc, w) => {
      const delta = w?.decayRate ?? 0.4;
      return sc.expValue * Math.exp(-delta * sc.daysUntilArrival / 365);
    },
    formatScore: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : Math.round(v)),
    scoreLabel: 'Discounted EV',
    hasSlider: true,
    sliderKey: 'decayRate',
    sliderLabel: 'Decay Rate (δ)',
    sliderMin: 0.05, sliderMax: 1.5, sliderStep: 0.05, sliderDefault: 0.4,
    sliderHints: ['δ=0.05: gentle', 'δ=1.5: aggressive'],
  },
  {
    id: 'mcda',
    label: 'Custom Weights',
    icon: '🎛️',
    color: '#ec4899',
    tagline: 'You set what matters most this quarter',
    description: 'Multi-Criteria Decision Analysis with live weight sliders. Each criterion is normalized 0–100 across the current pipeline, then multiplied by its weight. Criteria include XGBoost-predicted expected value and win probability, plus feasibility, occupancy context, and lead time. Makes implicit priorities explicit — weights can be saved as a quarterly preference document and shared with the team.',
    proscons: [
      { pro: true,  text: 'Fully transparent — everyone sees exactly why #1 is #1' },
      { pro: true,  text: 'Weights can be tuned per quarter or market condition' },
      { pro: false, text: 'Requires deliberate setup — wrong weights produce wrong answers' },
      { pro: false, text: 'Normalization can make small changes feel disproportionately large' },
    ],
    compute: null,
    formatScore: v => v.toFixed(1),
    scoreLabel: 'MCDA Score',
    hasMcda: true,
  },
];

const MCDA_CRITERIA = [
  { key: 'expValue',  label: 'Expected Value',     desc: 'Net revenue × win probability', default: 35 },
  { key: 'conv',      label: 'Win Probability',     desc: 'XGBoost conversion prediction', default: 20 },
  { key: 'hasMtg',    label: 'F&B / Meeting Space', desc: 'Groups using meeting space', default: 15 },
  { key: 'occ',       label: 'Occupancy Context',   desc: 'Higher occ = more displacement pressure', default: 10 },
  { key: 'leadTime',  label: 'Lead Time (inverse)', desc: 'Short lead = respond now', default: 10 },
  { key: 'feasible',  label: 'Feasibility',         desc: 'No room or space conflicts', default: 10 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt$   = v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : Math.round(v));
const fmtPct = v => (v * 100).toFixed(0) + '%';

const URGENCY_CFG = {
  Overdue:  { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: XCircle },
  Critical: { color: '#f97316', bg: 'rgba(249,115,22,0.12)', icon: AlertTriangle },
  High:     { color: '#eab308', bg: 'rgba(234,179,8,0.12)',  icon: AlertCircle },
  Medium:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', icon: Clock },
  Low:      { color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  icon: CheckCircle2 },
};

function RankShift({ current, baseline }) {
  if (baseline === undefined || baseline === null) return null;
  const diff = baseline - current;
  if (diff === 0) return <span className="shift-none"><Minus size={10} /></span>;
  if (diff > 0)   return <span className="shift-up"><ArrowUp size={10} />{diff}</span>;
  return              <span className="shift-down"><ArrowDown size={10} />{Math.abs(diff)}</span>;
}

// ─── Method Picker Modal ──────────────────────────────────────────────────────

function MethodPicker({ selected, onSelect, onClose }) {
  return (
    <div className="method-picker-overlay" onClick={onClose}>
      <div className="method-picker-panel" onClick={e => e.stopPropagation()}>
        <div className="mp-header">
          <h3 className="mp-title">Choose a Ranking Method</h3>
          <p className="mp-subtitle">Each method answers a different strategic question. Pick the one that matches your decision context right now.</p>
          <button className="mp-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="mp-grid">
          {RANKING_METHODS.map(m => (
            <button
              key={m.id}
              className={`mp-card ${selected === m.id ? 'active' : ''}`}
              style={{ '--method-color': m.color }}
              onClick={() => { onSelect(m.id); onClose(); }}
            >
              <div className="mp-card-top">
                <span className="mp-icon">{m.icon}</span>
                <div className="mp-card-labels">
                  <span className="mp-card-label">{m.label}</span>
                  <span className="mp-card-tagline">{m.tagline}</span>
                </div>
                {selected === m.id && <span className="mp-active-badge">Active</span>}
              </div>
              <p className="mp-card-desc">{m.description}</p>
              <div className="mp-proscons">
                {m.proscons.map((pc, i) => (
                  <div key={i} className={`mp-procon ${pc.pro ? 'pro' : 'con'}`}>
                    <span className="mp-procon-icon">{pc.pro ? '✓' : '✗'}</span>
                    <span>{pc.text}</span>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Slider Panel ─────────────────────────────────────────────────────────────

function SliderPanel({ method, weights, onChange }) {
  if (!method) return null;
  if (method.hasMcda) {
    const total = MCDA_CRITERIA.reduce((s, c) => s + (weights[c.key] ?? c.default), 0);
    return (
      <div className="slider-panel mcda-panel">
        <div className="sp-header">
          <SlidersHorizontal size={13} />
          <span>Criterion Weights · total: <strong style={{ color: total === 100 ? '#10b981' : '#f97316' }}>{total}%</strong></span>
          {total !== 100 && <span className="sp-warn">(adjust to reach 100%)</span>}
        </div>
        <div className="mcda-grid">
          {MCDA_CRITERIA.map(c => {
            const v = weights[c.key] ?? c.default;
            return (
              <div key={c.key} className="sp-row">
                <div className="sp-label-col">
                  <span className="sp-label">{c.label}</span>
                  <span className="sp-desc">{c.desc}</span>
                </div>
                <input
                  type="range" min={0} max={60} step={1} value={v}
                  onChange={e => onChange({ ...weights, [c.key]: Number(e.target.value) })}
                  className="sp-slider"
                />
                <span className="sp-val">{v}%</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  if (method.hasSlider) {
    const v = weights[method.sliderKey] ?? method.sliderDefault;
    return (
      <div className="slider-panel">
        <div className="sp-header">
          <SlidersHorizontal size={13} />
          <span>{method.sliderLabel}: <strong>{v.toFixed(2)}</strong></span>
          <span className="sp-hints">
            {method.sliderHints?.map((h, i) => <span key={i} className="sp-hint">{h}</span>)}
          </span>
        </div>
        <div className="sp-row single">
          <input
            type="range"
            min={method.sliderMin} max={method.sliderMax} step={method.sliderStep} value={v}
            onChange={e => onChange({ ...weights, [method.sliderKey]: Number(e.target.value) })}
            className="sp-slider wide"
          />
          <span className="sp-val">{v.toFixed(2)}</span>
        </div>
      </div>
    );
  }
  return null;
}

// ─── RFP Table Row ────────────────────────────────────────────────────────────

function RFPRow({ rfp, score, rank, baselineRank, methodScore, methodFmt, methodLabel,
                  isExpanded, onToggle, onViewStrategies, onStatusChange, onEditRfp, onDeleteRfp, demandEvents, allMethodScores }) {
  const urg     = URGENCY_CFG[score.urgency] || URGENCY_CFG.Low;
  const UrgIcon = urg.icon;
  const acct    = rfp.Account_Name || rfp.account_name || '—';
  const evType  = rfp.Event_Type   || rfp.event_type   || '—';
  const arrDate = (rfp.Arrival_Date || rfp.arrival_date || '').slice(0, 10);
  const rooms   = rfp.Peak_Room_Block || rfp.room_block || 0;

  return (
    <>
      <tr
        className={`rfp-row ${isExpanded ? 'expanded' : ''} ${!score.feasible ? 'conflict' : ''}`}
        onClick={onToggle}
      >
        {/* Rank + shift */}
        <td className="col-rank">
          <div className="rank-cell">
            <div className={`rank-badge rank-${rank <= 3 ? rank : 'n'}`}>
              {rank <= 3 && <Star size={9} />}{rank}
            </div>
            <RankShift current={rank} baseline={baselineRank} />
          </div>
        </td>

        {/* Account */}
        <td className="col-account">
          <div className="account-name">{acct}</div>
          <div className="event-type-tag">{evType}</div>
          {(rfp.organization || rfp.Organization) && (
            <div style={{ fontSize: '0.7rem', color: '#a0aec0', marginTop: '0.1rem' }}>
              {rfp.organization || rfp.Organization}
            </div>
          )}
          {(rfp.selected_strategy) && (
            <div style={{ fontSize: '0.65rem', marginTop: '0.2rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
              background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
              borderRadius: '3px', padding: '0.05rem 0.35rem', fontWeight: 600 }}>
              ✓ {rfp.selected_strategy}
            </div>
          )}
          {(() => {
            if (!demandEvents?.length) return null;
            const arr = rfp.arrival_date || rfp.Arrival_Date;
            const dep = rfp.departure_date || rfp.Departure_Date;
            if (!arr) return null;
            const DCOLORS = { Low: '#3b82f6', Medium: '#f59e0b', High: '#f97316', Critical: '#ef4444' };
            const ORDER = { Critical: 4, High: 3, Medium: 2, Low: 1 };
            const overlap = demandEvents.filter(ev => ev.start_date <= (dep||arr) && ev.end_date >= arr);
            if (!overlap.length) return null;
            const top = overlap.reduce((t, ev) => !t || (ORDER[ev.impact]||0) > (ORDER[t.impact]||0) ? ev : t, null);
            return (
              <div style={{ fontSize: '0.62rem', marginTop: '0.2rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
                background: (DCOLORS[top.impact]||'#f97316') + '18', color: DCOLORS[top.impact]||'#f97316',
                border: `1px solid ${DCOLORS[top.impact]||'#f97316'}55`,
                borderRadius: '3px', padding: '0.05rem 0.35rem', fontWeight: 600 }}
                title={`${top.impact} demand: ${top.name}`}>
                ⚡ {top.impact} demand
              </div>
            );
          })()}
        </td>

        {/* Dates */}
        <td className="col-dates">
          <div className="dates">{arrDate}</div>
          <div className="dates-sub">{score.nights}n · {stayPattern(rfp) || score.season}</div>
        </td>

        {/* Rooms */}
        <td className="col-rooms">
          <span className="stat-val">{rooms}</span>
          <span className="stat-sub">pk rms</span>
        </td>

        {/* Mtg Space */}
        <td className="col-mtg">
          {(() => {
            const hasMtg = rfp.Has_Meeting_Space || rfp.has_meeting_space;
            const att = Number(rfp.Attendees || rfp.attendees || 0);
            const rms = Number(rfp.Peak_Room_Block || rfp.room_block || 1);
            const poor = hasMtg && att / rms > 3;
            return hasMtg
              ? <span title={poor ? 'High attendee-to-room ratio' : 'Meeting space required'}
                  style={{ color: poor ? '#e53e3e' : '#38a169', fontWeight: 600, fontSize: '0.75rem' }}>
                  {poor ? '⚠' : '✓'}
                </span>
              : <span style={{ color: '#cbd5e0' }}>—</span>;
          })()}
        </td>

        {/* XGBoost signals */}
        <td className="col-xgb">
          <div className="xgb-scores">
            <div className="xgb-chip" title="Pickup probability">
              <span className="xgb-label">PU</span>
              <span className="xgb-val">{fmtPct(score.pickup)}</span>
            </div>
            <div className="xgb-chip" title="Conversion probability">
              <span className="xgb-label">CV</span>
              <span className="xgb-val">{fmtPct(score.conv)}</span>
            </div>
          </div>
        </td>

        {/* Active method score */}
        <td className="col-method-score">
          <div className="method-score-val">{methodFmt(methodScore)}</div>
          <div className="method-score-label">{methodLabel}</div>
        </td>

        {/* EV (always) */}
        <td className="col-ev">
          <div className="ev-val">{fmt$(score.expValue)}</div>
          <div className="ev-sub">net {fmt$(score.netValue)}</div>
        </td>

        {/* Feasibility */}
        <td className="col-feasibility">
          {score.feasible
            ? <span className="badge badge-ok"><CheckCircle2 size={11} /> Clear</span>
            : <span className="badge badge-conflict">
                {score.conflictRooms
                  ? <><AlertTriangle size={11} /> Rooms</>
                  : <><XCircle size={11} /> Space</>}
              </span>
          }
        </td>

        {/* Urgency */}
        <td className="col-urgency">
          <span className="urgency-badge" style={{ color: urg.color, background: urg.bg }}>
            <UrgIcon size={11} />
            {score.urgency}
            <span className="days-tag">
              {score.daysToRespond <= 0 ? 'expired' : `${score.daysToRespond}d`}
            </span>
          </span>
        </td>

        {/* Actions */}
        <td onClick={e => e.stopPropagation()} style={{ whiteSpace: "nowrap", padding: "0.4rem 0.5rem" }}>
          <button
            onClick={(e) => { e.stopPropagation(); onEditRfp && onEditRfp(rfp); }}
            title="Edit RFP details and view pricing strategies"
            style={{ padding: '0.25rem 0.6rem', border: '1px solid #5b5fc7', borderRadius: '6px',
              background: '#eff0fd', cursor: 'pointer', color: '#5b5fc7', fontWeight: 600, fontSize: '0.72rem',
              fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
            <Zap size={12} /> Edit &amp; Strategies
          </button>
          {(() => {
            const st = (rfp.Status || rfp.status || '').toLowerCase();
            return (<>
              <button
                title={st === 'approved' ? 'Click to reset to Pending' : 'Mark as Won'}
                onClick={(e) => { e.stopPropagation(); onStatusChange(rfp.id, st === 'approved' ? 'pending' : 'approved', rfp._col || 'rfps'); }}
                style={{ padding: '0.2rem 0.4rem', border: `1px solid ${st === 'approved' ? '#38a169' : '#e2e8f0'}`, borderRadius: '5px',
                  background: st === 'approved' ? '#c6f6d5' : '#fff', cursor: 'pointer',
                  color: st === 'approved' ? '#166534' : '#6b7280', fontWeight: st === 'approved' ? 700 : 400,
                  fontSize: '0.72rem', fontFamily: 'inherit' }}>
                {st === 'approved' ? '✓ Won' : 'Won'}
              </button>
              <button
                title={st === 'lost' ? 'Click to reset to Pending' : 'Client went elsewhere'}
                onClick={(e) => { e.stopPropagation(); onStatusChange(rfp.id, st === 'lost' ? 'pending' : 'lost', rfp._col || 'rfps'); }}
                style={{ padding: '0.2rem 0.4rem', border: `1px solid ${st === 'lost' ? '#e53e3e' : '#e2e8f0'}`, borderRadius: '5px',
                  background: st === 'lost' ? '#fee2e2' : '#fff', cursor: 'pointer',
                  color: st === 'lost' ? '#991b1b' : '#6b7280', fontWeight: st === 'lost' ? 700 : 400,
                  fontSize: '0.72rem', fontFamily: 'inherit' }}>
                {st === 'lost' ? '✗ Lost' : 'Lost'}
              </button>
              <button
                title={st === 'declined' ? 'Click to reset to Pending' : 'Hotel declines to pursue'}
                onClick={(e) => { e.stopPropagation(); onStatusChange(rfp.id, st === 'declined' ? 'pending' : 'declined', rfp._col || 'rfps'); }}
                style={{ padding: '0.2rem 0.4rem', border: `1px solid ${st === 'declined' ? '#7c3aed' : '#e2e8f0'}`, borderRadius: '5px',
                  background: st === 'declined' ? '#f5f3ff' : '#fafafa', cursor: 'pointer',
                  color: st === 'declined' ? '#5b21b6' : '#6b7280', fontWeight: st === 'declined' ? 700 : 400,
                  fontSize: '0.72rem', fontFamily: 'inherit' }}>
                {st === 'declined' ? '⊘ Declined' : 'Decline'}
              </button>
            </>);
          })()}
          <button title="Delete RFP"
            onClick={() => {
              const name = rfp.Account_Name || rfp.account_name || rfp.organization || rfp.event_name || 'this RFP';
              if (window.confirm(`Delete "${name}"? This cannot be undone.`)) {
                onDeleteRfp && onDeleteRfp(rfp.id, rfp._col);
              }
            }}
            style={{ padding: '0.3rem 0.5rem', border: '1px solid #fee2e2', borderRadius: '0.375rem',
              background: '#fff', cursor: 'pointer', color: '#e53e3e' }}>
            Del
          </button>
        </td>

        <td className="col-expand">
          {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </td>
      </tr>

      {/* Expanded detail */}
      {isExpanded && (
        <tr className="detail-row">
          <td colSpan={12}>
            <div className="detail-panel">
              {/* Revenue breakdown */}
              <div className="detail-section">
                <h4 className="detail-section-title"><DollarSign size={13} /> Revenue Breakdown</h4>
                <div className="rev-grid">
                  {[
                    { label: 'Baseline ADR',  val: fmt$(score.baseADR),         note: rfp.quoted_adr ? `$${rfp.quoted_adr} from RFP form` : 'Rack rate · config' },
                    { label: 'Quoted ADR',    val: fmt$(score.quotedADR),        note: score.adrFromModel ? 'XGBoost predicted' : '−12% group disc. · fixed formula' },
                    { label: 'Room Revenue',  val: fmt$(score.roomRev),          note: `${fmtPct(score.pickup)} pickup · XGBoost` },
                    { label: 'F&B Revenue',   val: fmt$(score.fnbRev),
                      note: score.hasMtg
                        ? (rfp.fnb_budget ? `$${rfp.fnb_budget} from form` : `${fmt$(score.fnbPP)}/pax · predicted`)
                        : `${fmt$(score.fnbPP)}/pax · predicted` },
                    { label: 'Meeting Rev.',  val: fmt$(score.mtgRev),
                      note: score.hasMtg
                        ? (rfp.uses_ballroom || rfp.Uses_Ballroom ? 'Ballroom · ' : '') +
                          (rfp.uses_boardroom || rfp.Uses_Boardroom ? 'Boardroom · ' : '') +
                          `$${score.meetingRateUsed}/rm · config`
                        : 'no meeting space' },
                    { label: 'Gross Revenue', val: fmt$(score.grossRev),         note: '', highlight: true },
                    { label: 'Displacement',  val: '−' + fmt$(score.dispCost),  note: `${Math.round(score.displacementFactorUsed * 100)}% factor · config`, negative: true },
                    { label: 'Net Value',     val: fmt$(score.netValue),         note: '', highlight: true },
                    { label: 'Exp. Value',    val: fmt$(score.expValue),         note: `${fmtPct(score.conv)} conv. · XGBoost`, accent: true },
                  ].map(r => (
                    <div key={r.label} className={`rev-cell ${r.highlight ? 'hl' : ''} ${r.negative ? 'neg' : ''} ${r.accent ? 'accent' : ''}`}>
                      <div className="rev-label">{r.label}</div>
                      <div className="rev-val">{r.val}</div>
                      {r.note && <div className="rev-note">{r.note}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {/* All method scores side-by-side */}
              <div className="detail-section">
                <h4 className="detail-section-title"><Sparkles size={13} /> All Method Scores</h4>
                <div className="all-methods-grid">
                  {RANKING_METHODS.filter(m => m.id !== 'mcda').map(m => (
                    <div key={m.id} className="method-mini-card" style={{ '--mc': m.color }}>
                      <div className="mmc-icon">{m.icon}</div>
                      <div className="mmc-name">{m.label}</div>
                      <div className="mmc-score">
                        {m.compute ? m.formatScore(m.compute(score, {})) : '—'}
                      </div>
                      <div className="mmc-label">{m.scoreLabel}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RankingView({ onViewStrategies, onStatusChange, onEditRfp, onDeleteRfp, onNewRfp }) {
  const [rfps,        setRfps]        = useState([]);
  const [booked,      setBooked]      = useState([]);
  const [scores,      setScores]      = useState({});
  const [isScoring,   setIsScoring]   = useState(false);
  const [lastRun,     setLastRun]     = useState(null);
  const [expanded,    setExpanded]    = useState(null);
  const [methodId,    setMethodId]    = useState('composite');
  const [weights,     setWeights]     = useState({});
  const [showPicker,  setShowPicker]  = useState(false);
  const [filter,      setFilter]      = useState('All');
  const [statusFilter,setStatusFilter]= useState('Pending');
  const [sigRefreshing, setSigRefreshing] = useState(false);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  const [showBooked, setShowBooked] = useState(false);
  const computeRef = useRef(null);

  const { signals, loading: sigLoading, age: sigAge } = useMarketSignals();
  const { config } = useHotelConfig();

  const method = RANKING_METHODS.find(m => m.id === methodId) || RANKING_METHODS[0];

  // Merge rfps + incoming_rfps into one unified list
  const [rfpsMain,    setRfpsMain]    = useState([]);
  const [demandEvents, setDemandEvents] = useState([]);
  const [rfpsIncoming,setRfpsIncoming]= useState([]);

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'booked_events'), s =>
      setBooked(s.docs.map(d => ({ id: d.id, _col: 'booked_events', ...d.data() }))));
    const u2 = onSnapshot(collection(db, 'rfps'), s =>
      setRfpsMain(s.docs.map(d => ({ id: d.id, _col: 'rfps', ...d.data() }))));
    const u3 = onSnapshot(collection(db, 'incoming_rfps'), s =>
      setRfpsIncoming(s.docs.map(d => ({ id: d.id, _col: 'incoming_rfps', ...d.data() }))));
    return () => { u1(); u2(); u3(); };
  }, []);

  // Deduplicate by id, rfps takes precedence over incoming_rfps
  useEffect(() => {
    const seen = new Set();
    const merged = [...rfpsMain, ...rfpsIncoming].filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    setRfps(merged);
  }, [rfpsMain, rfpsIncoming]);

  useEffect(() => {
    if (!rfps.length) return;
    if (computeRef.current) clearTimeout(computeRef.current);
    computeRef.current = setTimeout(runScoring, 250);
  }, [rfps, booked]);

  const buildBookedMap = useCallback((evts) => {
    const map = {};
    evts.forEach(ev => {
      const arr = ev.Arrival_Date   || ev.arrival_date;
      const dep = ev.Departure_Date || ev.departure_date;
      if (!arr || !dep) return;
      const rooms = Number(ev.Peak_Room_Block || ev.room_block || 0);
      const bal   = Number(ev.Uses_Ballroom   || ev.uses_ballroom   || 0);
      for (let d = new Date(arr); d < new Date(dep); d.setDate(d.getDate() + 1)) {
        const k = d.toISOString().slice(0, 10);
        if (!map[k]) map[k] = { rooms: 0, ballroom: false };
        map[k].rooms += rooms;
        if (bal) map[k].ballroom = true;
      }
    });
    return map;
  }, []);

  const runScoring = useCallback(() => {
    setIsScoring(true);
    const bmap = buildBookedMap(booked);
    const ns = {};
    rfps.forEach(r => { try { ns[r.id] = scoreRFP(r, bmap, signals, config); } catch (e) { console.warn(e); } });
    setScores(ns);
    setLastRun(new Date());
    setIsScoring(false);
  }, [rfps, booked, buildBookedMap, signals, config]);

  // MCDA normalization
  const mcdaScores = useMemo(() => {
    if (methodId !== 'mcda') return {};
    const ids = Object.keys(scores);
    const out  = {};
    MCDA_CRITERIA.forEach(c => {
      const vals = ids.map(id => {
        const sc = scores[id];
        if (!sc) return 0;
        if (c.key === 'hasMtg')   return sc.hasMtg ? 100 : 0;
        if (c.key === 'feasible') return sc.feasible ? 100 : 0;
        return sc[c.key] ?? 0;
      });
      const mn = Math.min(...vals), mx = Math.max(...vals);
      ids.forEach((id, i) => {
        if (!out[id]) out[id] = 0;
        let norm = mx > mn ? (vals[i] - mn) / (mx - mn) * 100 : 50;
        if (c.key === 'leadTime') norm = 100 - norm;
        out[id] += norm * (weights[c.key] ?? c.default) / 100;
      });
    });
    return out;
  }, [scores, methodId, weights]);

  // Composite ranks as baseline for shift arrows
  const compositeRanks = useMemo(() => {
    const sm = s => ({ Winter: 0.85, Spring: 1.10, Summer: 0.95, Fall: 1.20 }[s] ?? 1.0);
    const sorted = Object.keys(scores).sort((a, b) => {
      const sa = scores[a], sb = scores[b];
      if (!sa || !sb) return 0;
      const scoreOf = sc => (sc.expValue / 1500) * 0.45 + sc.conv * 35 * 0.20 +
        (sc.hasMtg ? 8 : 0) * 0.15 + sm(sc.season) * 10 * 0.10 + (sc.feasible ? 10 : 0) * 0.10;
      return scoreOf(sb) - scoreOf(sa);
    });
    const r = {}; sorted.forEach((id, i) => r[id] = i + 1); return r;
  }, [scores]);

  const getMethodScore = useCallback((sc, id) => {
    if (methodId === 'mcda') return mcdaScores[id] ?? 0;
    if (!method.compute || !sc) return 0;
    return method.compute(sc, weights);
  }, [methodId, method, weights, mcdaScores]);

  const TODAY_MS = Date.now();

  const displayed = useMemo(() => rfps
    .filter(r => {
      // Hide past events (departure date in the past)
      const dep = new Date(r.Departure_Date || r.departure_date);
      if (!isNaN(dep) && dep.getTime() < TODAY_MS) return false;

      const rawSt = (r.Status || r.status || 'Pending').toLowerCase();
      const st = rawSt === 'reviewing' ? 'pending' : rawSt;
      if (statusFilter !== 'All' && st !== statusFilter.toLowerCase()) return false;
      const sc = scores[r.id];
      if (!sc) return true;
      if (filter === 'Feasible')  return sc.feasible;
      if (filter === 'Conflict')  return !sc.feasible;
      if (filter === 'Urgent')    return ['Overdue', 'Critical'].includes(sc.urgency);
      if (filter === 'HighValue') return sc.expValue > 40000;
      return true;
    })
    .sort((a, b) => {
      const sa = scores[a.id], sb = scores[b.id];
      if (!sa || !sb) return 0;
      const dir = sortDir === 'desc' ? -1 : 1;
      if (!sortCol) return getMethodScore(sb, b.id) - getMethodScore(sa, a.id);
      if (sortCol === 'score')    return dir * (getMethodScore(sb, b.id) - getMethodScore(sa, a.id));
      if (sortCol === 'ev')       return dir * (sb.expValue - sa.expValue);
      if (sortCol === 'rooms')    return dir * (sb.roomBlock - sa.roomBlock);
      if (sortCol === 'dates')    return dir * (new Date(a.arrival_date || a.Arrival_Date) - new Date(b.arrival_date || b.Arrival_Date));
      if (sortCol === 'urgency') {
        const ord = { Overdue: 0, Critical: 1, High: 2, Medium: 3, Low: 4 };
        return dir * ((ord[sa.urgency] ?? 5) - (ord[sb.urgency] ?? 5));
      }
      if (sortCol === 'account')  return dir * (a.event_name || a.Account_Name || '').localeCompare(b.event_name || b.Account_Name || '');
      return 0;
    }),
    [rfps, scores, filter, statusFilter, sortCol, sortDir, getMethodScore]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const totalEV   = useMemo(() => Object.values(scores).reduce((s, sc) => s + (sc?.expValue ?? 0), 0), [scores]);
  const overdue   = useMemo(() => Object.values(scores).filter(sc => sc?.urgency === 'Overdue').length, [scores]);
  const conflicts = useMemo(() => Object.values(scores).filter(sc => !sc?.feasible).length, [scores]);

  return (
    <div className="ranking-view" style={{ maxWidth: "100%", padding: "0" }}>

      {/* ── Header ── */}
      <div className="ranking-header">
        <div className="ranking-header-left">
          <div className="ranking-title-row">
            <TrendingUp size={20} className="title-icon" />
            <h2 className="ranking-title">Dashboard</h2>
            {isScoring && <span className="ranking-badge pulse">Scoring…</span>}
          </div>
          {lastRun && (
            <p className="last-run">
              Scored · {lastRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        <div className="ranking-header-right">
          {/* Market signals freshness */}
          <div className="signals-status" title="Live demand signals computed from your property's booking history and RFP pipeline (updated every time you click refresh)">
            <span className="signals-dot" style={{ background: sigAge === null ? '#94a3b8' : sigAge < 60 ? '#10b981' : sigAge < 360 ? '#f59e0b' : '#ef4444' }} />
            <span className="signals-label">
              {sigLoading ? 'Loading signals…' : sigAge === null ? 'No signals' : `Signals · ${sigAge < 60 ? `${sigAge}m ago` : `${Math.round(sigAge / 60)}h ago`}`}
            </span>
            <button
              className="signals-refresh-btn"
              title="Recompute market signals from Firestore"
              disabled={sigRefreshing}
              onClick={async () => {
                setSigRefreshing(true);
                try { await computeMarketSignals(); } catch (e) { console.error(e); }
                setSigRefreshing(false);
              }}
            >
              <RefreshCw size={11} className={sigRefreshing ? 'spin' : ''} />
            </button>
          </div>
          <button
            className="method-selector-btn"
            style={{ '--mc': method.color }}
            onClick={() => setShowPicker(true)}
          >
            <span className="msb-icon">{method.icon}</span>
            <span className="msb-text">
              <span className="msb-sublabel">Ranking by</span>
              <span className="msb-label">{method.label}</span>
            </span>
            <ChevronDown size={14} />
          </button>
          <button
            className={`rerank-btn ${isScoring ? 'loading' : ''}`}
            onClick={runScoring}
            disabled={isScoring}
          >
            <RefreshCw size={14} className={isScoring ? 'spin' : ''} />
            {isScoring ? 'Scoring…' : 'Re-rank Now'}
          </button>
        </div>
      </div>



      {/* ── Slider / MCDA panel ── */}
      {(method.hasSlider || method.hasMcda) && (
        <SliderPanel method={method} weights={weights} onChange={setWeights} />
      )}

      {/* ── Summary strip ── */}
      <div className="summary-strip">
        <div className="summary-card">
          <div className="summary-icon-wrap blue"><DollarSign size={15} /></div>
          <div>
            <div className="summary-label">Pipeline EV</div>
            <div className="summary-val">{fmt$(totalEV)}</div>
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-icon-wrap green"><Building2 size={15} /></div>
          <div>
            <div className="summary-label">RFPs in Queue</div>
            <div className="summary-val">{rfps.length}</div>
          </div>
        </div>
        <div className={`summary-card ${overdue > 0 ? 'alert' : ''}`}>
          <div className="summary-icon-wrap red"><AlertTriangle size={15} /></div>
          <div>
            <div className="summary-label">Overdue</div>
            <div className="summary-val">{overdue}</div>
          </div>
        </div>
        <div className={`summary-card ${conflicts > 0 ? 'warn' : ''}`}>
          <div className="summary-icon-wrap orange"><XCircle size={15} /></div>
          <div>
            <div className="summary-label">Conflicts</div>
            <div className="summary-val">{conflicts}</div>
          </div>
        </div>
        {displayed[0] && scores[displayed[0].id] && (
          <div className="summary-card highlight">
            <div className="summary-icon-wrap gold"><Star size={15} /></div>
            <div>
              <div className="summary-label">Top Deal EV</div>
              <div className="summary-val">{fmt$(scores[displayed[0].id].expValue)}</div>
              <div className="summary-note">{displayed[0].Account_Name || displayed[0].account_name}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Controls ── */}
      <div className="controls-bar">
        <div className="filter-group">
          <Filter size={12} className="filter-icon" />
          {['All', 'Feasible', 'Conflict', 'Urgent', 'HighValue'].map(f => (
            <button key={f} className={`filter-pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'HighValue' ? '>$40K EV' : f}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-label">Status:</span>
          {[['All','All'], ['Pending','pending'], ['Booked','approved'], ['Lost','lost'], ['Declined','declined']].map(([label, val]) => (
            <button key={val} className={`filter-pill ${statusFilter === val ? 'active' : ''}`} onClick={() => setStatusFilter(val)}>
              {label}
            </button>
          ))}
        </div>
        {methodId !== 'composite' && (
          <div className="shift-legend">
            <span className="shift-up"><ArrowUp size={10} />3</span> moved up vs Composite&nbsp;
            <span className="shift-down"><ArrowDown size={10} />2</span> moved down
          </div>
        )}
      </div>

      {/* ── Table ── */}
      {displayed.length === 0 ? (
        <div className="empty-state">
          <Sparkles size={28} className="empty-icon" />
          <p>No RFPs match the current filter.</p>
        </div>
      ) : (
        <div style={{ width: "100%", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <table className="ranking-table" style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th className="col-rank" style={{ width: 36, minWidth: 36 }}># <span className="th-sub">shift</span></th>
                <th style={{ minWidth: 150, cursor:'pointer' }} onClick={() => toggleSort('account')} title="Sort by name">
                  Account / Type {sortCol==='account' ? (sortDir==='desc'?'↓':'↑') : <span style={{opacity:0.3}}>↕</span>}
                </th>
                <th style={{ width: 75, cursor:'pointer' }} onClick={() => toggleSort('dates')} title="Sort by arrival date">
                  Dates {sortCol==='dates' ? (sortDir==='desc'?'↓':'↑') : <span style={{opacity:0.3}}>↕</span>}
                </th>
                <th style={{ width: 36, cursor:'pointer' }} onClick={() => toggleSort('rooms')} title="Sort by peak room block">
                  Rms {sortCol==='rooms' ? (sortDir==='desc'?'↓':'↑') : <span style={{opacity:0.3}}>↕</span>}
                </th>
                <th className="col-mtg" style={{ width: 26 }}>Mtg</th>
                <th className="col-xgb" style={{ width: 76 }}>PU/Win%</th>
                <th className="col-method-score" style={{ color: method.color, width: 44, cursor:'pointer' }} onClick={() => toggleSort('score')}>
                  {method.scoreLabel} {sortCol==='score'||!sortCol ? (sortDir==='desc'?'↓':'↑') : <span style={{opacity:0.3}}>↕</span>}
                </th>
                <th style={{ width: 72, cursor:'pointer' }} onClick={() => toggleSort('ev')} title="Sort by estimated value">
                  Est. Value {sortCol==='ev' ? (sortDir==='desc'?'↓':'↑') : <span style={{opacity:0.3}}>↕</span>}
                </th>
                <th className="col-feasibility" style={{ width: 60 }}>Feas.</th>
                <th style={{ width: 90, cursor:'pointer' }} onClick={() => toggleSort('urgency')} title="Sort by urgency">
                  Urgency {sortCol==='urgency' ? (sortDir==='desc'?'↓':'↑') : <span style={{opacity:0.3}}>↕</span>}
                </th>
                
                <th className="col-expand" style={{ width: 14 }} />
              </tr>
            </thead>
            <tbody>
              {displayed.map((rfp, i) => {
                const sc = scores[rfp.id];
                if (!sc) return null;
                return (
                  <RFPRow
                    key={rfp.id}
                    rfp={rfp} score={sc}
                    rank={i + 1}
                    baselineRank={methodId !== 'composite' ? compositeRanks[rfp.id] : undefined}
                    methodScore={getMethodScore(sc, rfp.id)}
                    methodFmt={method.formatScore}
                    methodLabel={method.scoreLabel}
                    isExpanded={expanded === rfp.id}
                    onToggle={() => setExpanded(expanded === rfp.id ? null : rfp.id)}
                    onViewStrategies={onViewStrategies}
                    onStatusChange={onStatusChange}
                    onEditRfp={onEditRfp}
                    onDeleteRfp={onDeleteRfp}
                    demandEvents={demandEvents}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Method picker modal ── */}
      {showPicker && (
        <MethodPicker
          selected={methodId}
          onSelect={id => { setMethodId(id); setWeights({}); }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
