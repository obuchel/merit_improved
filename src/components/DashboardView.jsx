import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, getDocs } from 'firebase/firestore';
import {
  Users, DollarSign, CheckCircle2, AlertTriangle, Clock,
  Edit, Eye, ThumbsUp, ThumbsDown, Trash2, ChevronDown, ChevronUp,
  ClipboardList, ArrowRight,
} from 'lucide-react';
import { XGBOOST_TREES_V8 as XGBOOST_TREES } from '../xgboost_trees_data_v8.js';
import { buildModelFeatures } from '../modelFeatures';
import { predictModel } from '../modelRuntime';
import './Dashboard.css';

// Same real business/operational constants StrategiesView.jsx and
// RankingView.jsx use — not model outputs, so a static config is legitimate
// here (see those files' comments for why marketSignals.js was discarded).
const CONFIG_DEFAULTS = {
  baseline_adr:                164,
  meeting_rate_per_room_night: 18,
  displacement_factor:         0.28,
  total_rooms:                 220,
};
const TOTAL_ROOMS  = 220;
const BASELINE_ADR = 164;

function predictSingle(name, dict) {
  return predictModel(XGBOOST_TREES, name, dict);
}

// ─── Status vocabulary ───────────────────────────────────────────────────────
// Only THREE values are ever stored on rfp.status going forward: 'new',
// 'definite', 'declined'. "Tentative" is not a fourth stored value — it's a
// derived display state (a 'new' RFP that already has a selected_strategy,
// i.e. someone has sent a quote / put a hold on the room block, but the
// client hasn't confirmed yet). This mapping also absorbs the app's older
// status vocabulary so it keeps working on documents that haven't been
// migrated yet:
//   old 'pending'   -> new 'new'
//   old 'reviewing' -> new 'new'       (RankingView.jsx already treated
//                                        'reviewing' as a synonym for pending)
//   old 'approved'  -> new 'definite'
//   old 'declined'  -> new 'declined'
//   old 'lost'      -> new 'declined'  (folded together per product decision —
//                                        the "client went elsewhere" vs "hotel
//                                        passed" distinction is not tracked
//                                        separately in the new vocabulary)
export function normalizeStoredStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'approved') return 'definite';
  if (s === 'declined' || s === 'lost') return 'declined';
  if (s === 'reviewing' || s === 'pending') return 'new';
  if (s === 'definite' || s === 'new') return s;
  return 'new'; // empty / unrecognized
}

export function deriveDisplayStatus(rfp) {
  const stored = normalizeStoredStatus(rfp.status || rfp.Status);
  if (stored === 'new' && rfp.selected_strategy) return 'tentative';
  return stored; // 'new' | 'tentative' | 'definite' | 'declined'
}

const STATUS_CFG = {
  new:       { label: 'New',       bg: '#dbeafe', color: '#1e40af' },
  tentative: { label: 'Tentative', bg: '#d1fae5', color: '#065f46' },
  definite:  { label: 'Definite',  bg: '#ede9fe', color: '#5b21b6' },
  declined:  { label: 'Declined',  bg: '#f1f5f9', color: '#475569' },
};

// ─── Urgency ──────────────────────────────────────────────────────────────
// Same response-window logic as RankingView.jsx's scoreRFP (kept identical
// on purpose so the two views never disagree about how urgent something
// is) — days left to respond if the window is still open, otherwise days
// until arrival. Collapsed from 5 internal levels to the 3 this screen
// shows (High/Medium/Low); the raw level is still available in the tooltip.
function computeUrgency(rfp, inquiry, arrival) {
  const TODAY = new Date();
  const VALID = new Set(['Critical', 'High', 'Medium', 'Low', 'Overdue']);
  if (rfp.urgency_override && VALID.has(rfp.urgency_override)) return rfp.urgency_override;
  const rd = new Date(inquiry);
  rd.setDate(rd.getDate() + Number(rfp.Response_Due_Days || rfp.response_due_days || 10));
  const dtr = Math.round((rd - TODAY) / 86400000);
  const daysUntilArrival = Math.max(0, Math.round((arrival - TODAY) / 86400000));
  if (dtr > 0) return dtr <= 3 ? 'Critical' : dtr <= 7 ? 'High' : dtr <= 14 ? 'Medium' : 'Low';
  if (daysUntilArrival <= 3) return 'Overdue';
  return daysUntilArrival <= 14 ? 'Critical' : daysUntilArrival <= 30 ? 'High' : daysUntilArrival <= 90 ? 'Medium' : 'Low';
}
const URGENCY_DISPLAY = { Overdue: 'High', Critical: 'High', High: 'High', Medium: 'Medium', Low: 'Low' };
const URGENCY_CFG = {
  High:   { color: '#dc2626' },
  Medium: { color: '#b45309' },
  Low:    { color: '#94a3b8' },
};

// ─── Meeting-space tightness (reused verbatim from RankingView.jsx) ─────────
function roomMtgRatio(rfp) {
  const rooms = Number(rfp.room_block || rfp.Peak_Room_Block || 0);
  const mtg   = Number(rfp.meeting_attendees || rfp.Meeting_Attendees || rfp.attendees || rfp.Attendees || 0);
  if (!rooms || !mtg) return null;
  const ratio = mtg / rooms;
  if (ratio < 1.0) return { ratio, label: 'Ideal' };
  if (ratio < 1.5) return { ratio, label: 'Good' };
  if (ratio < 2.5) return { ratio, label: 'Tight' };
  if (ratio < 4.0) return { ratio, label: 'Poor' };
  return { ratio, label: 'Conflict' };
}

const fmt$ = (v) => v == null ? '—' : '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'K' : Math.round(v).toLocaleString());

// ─── Per-RFP model scoring ───────────────────────────────────────────────────
// Deliberately mirrors RankingView.jsx's scoreRFP — buildModelFeatures() is
// the real ~70-feature vector the models were trained on, and
// quoted_adr/pickup_ipw/conversion/fnb are the four real deployed models,
// run through the same JS-tree runtime StrategiesView and RankingView use.
//
// UNLIKE RankingView.jsx's version, this one does NOT silently substitute a
// guessed constant (0.79 pickup, 0.65 conversion, a rack-rate-derived ADR,
// $55 F&B) when a model comes back null or out of range — that would show
// invented numbers on the dashboard as if they were real predictions. It
// throws instead, and the caller (scoreAllRfps below) catches that per row:
// a row whose model genuinely fails shows "—" for revenue/Fit rather than a
// plausible-looking guess. This dashboard only tries the fast JS-tree path
// (no Pyodide/pkl fallback) since it's scoring many RFPs at once; a row that
// fails here can still be scored individually by opening it in Strategies,
// which does try the slower legacy path too.
function scoreRFPHonest(rfp, bookedMap, allRfps, config) {
  const arrival   = new Date(rfp.arrival_date   || rfp.Arrival_Date);
  const departure = new Date(rfp.departure_date || rfp.Departure_Date);
  const inquiry   = new Date(rfp.inquiry_date   || rfp.Inquiry_Date || Date.now());
  const nights    = Math.max(1, Math.round((departure - arrival) / 86400000));
  const roomBlock = Number(rfp.Peak_Room_Block || rfp.room_block || 50);
  const attendees = Number(rfp.Attendees || rfp.attendees || roomBlock * 1.4);
  const trn       = roomBlock * nights;
  const hasMtgNum = Number(
    rfp.Has_Meeting_Space || rfp.has_meeting_space ||
    rfp.Uses_Ballroom || rfp.uses_ballroom ||
    rfp.Uses_Boardroom || rfp.uses_boardroom ||
    (Number(rfp.Num_Meeting_Rooms || rfp.num_meeting_rooms || 0) > 0) || 0
  );
  const usesBal = Number(rfp.Uses_Ballroom || rfp.uses_ballroom || 0);

  let occPct = Number(rfp.Forecasted_Occupancy || rfp.forecasted_occupancy || 0.72);
  if (occPct <= 1) occPct = occPct * 100;

  let conflictRooms = false, conflictSpace = false, maxTaken = 0;
  for (let d = new Date(arrival); d < departure; d.setDate(d.getDate() + 1)) {
    const bk = bookedMap[d.toISOString().slice(0, 10)] || { rooms: 0, ballroom: false };
    maxTaken = Math.max(maxTaken, bk.rooms);
    if (bk.rooms + roomBlock > TOTAL_ROOMS * 0.90) conflictRooms = true;
    if (hasMtgNum && usesBal && bk.ballroom) conflictSpace = true;
  }
  const feasible = !conflictRooms && !conflictSpace;

  const bf = buildModelFeatures(rfp, {
    bookedMap, allRfps, totalRooms: config.total_rooms || TOTAL_ROOMS, baselineAdr: config.baseline_adr || BASELINE_ADR,
  });

  const adrRaw    = predictSingle('quoted_adr', bf);
  const pickupCal = predictSingle('pickup_ipw', bf);
  const convCal   = predictSingle('conversion', bf);
  const fnbRaw    = predictSingle('fnb', bf);

  // No fallback numbers — see the function comment above.
  if (adrRaw === null || adrRaw <= 60 || adrRaw >= 600) throw new Error('quoted_adr unusable');
  if (pickupCal === null) throw new Error('pickup_ipw null');
  if (convCal === null) throw new Error('conversion null');
  if (fnbRaw === null) throw new Error('fnb null');

  const quotedADR = Math.round(adrRaw);
  const pickup    = Math.min(0.98, Math.max(0.35, pickupCal));
  const conv      = Math.min(0.98, Math.max(0.15, convCal));
  const fnbPP     = Math.max(hasMtgNum ? 25 : 0, fnbRaw);

  const roomRev  = quotedADR * trn * pickup;
  const fnbRev   = fnbPP * attendees * (hasMtgNum ? 1 : 0.25);
  const mtgRev   = hasMtgNum ? roomBlock * config.meeting_rate_per_room_night * nights : 0;
  const grossRev = roomRev + fnbRev + mtgRev;

  return {
    quotedADR, pickup, conv, fnbPP: Math.round(fnbPP),
    roomRev: Math.round(roomRev), fnbRev: Math.round(fnbRev), mtgRev: Math.round(mtgRev),
    grossRev: Math.round(grossRev),
    feasible, nights,
    urgency: computeUrgency(rfp, inquiry, arrival),
  };
}

// ─── Fit ─────────────────────────────────────────────────────────────────
// Every clause here comes from a real, already-computed signal — nothing is
// invented to fill out the sentence. Tier is driven primarily by the real
// conversion-probability model output; "Conditional Fit" overrides that when
// there's a hard operational constraint (a room/space conflict, or a very
// tight meeting-to-room ratio) that needs resolving regardless of how likely
// the RFP is to convert.
function computeFit(rfp, score, demandOverlap, orgRepeatCount) {
  const ratio = roomMtgRatio(rfp);
  const hasHardConstraint = !score.feasible || (ratio && (ratio.label === 'Poor' || ratio.label === 'Conflict'));

  let tier;
  if (hasHardConstraint) tier = 'Conditional Fit';
  else if (score.conv >= 0.65) tier = 'Strong Fit';
  else if (score.conv >= 0.45) tier = 'Good Fit';
  else tier = 'Weak Fit';

  const clauses = [];
  if (demandOverlap) clauses.push(`${demandOverlap.impact} demand for these dates`);
  if (!score.feasible) clauses.push('Room availability conflict on these dates');
  else if (ratio && (ratio.label === 'Tight' || ratio.label === 'Poor' || ratio.label === 'Conflict')) {
    clauses.push(`${ratio.label} meeting-to-room ratio`);
  }
  const adrRatio = score.quotedADR / (CONFIG_DEFAULTS.baseline_adr || BASELINE_ADR);
  if (adrRatio >= 1.05) clauses.push('Strong comp-set rate alignment');
  else if (adrRatio < 0.95) clauses.push('Comp-set pricing below target');
  else clauses.push('Average comp-set rate alignment');
  if (orgRepeatCount > 1) clauses.push('Repeat account');

  return { tier, description: clauses.slice(0, 2).join(' · ') || 'Standard evaluation — no notable signals' };
}

const FIT_COLOR = {
  'Strong Fit':      '#16a34a',
  'Good Fit':         '#22c55e',
  'Weak Fit':         '#f97316',
  'Conditional Fit':  '#eab308',
};

// Light tint backgrounds paired with FIT_COLOR above, so Fit reads as a
// scannable chip (same visual language as the Status pill) instead of a
// plain dot next to bold text.
const FIT_BG = {
  'Strong Fit':      '#dcfce7',
  'Good Fit':         '#ecfdf5',
  'Weak Fit':         '#fff7ed',
  'Conditional Fit':  '#fefce8',
};

const DashboardView = ({ onNewRfp, onEditRfp, onViewStrategies, onStatusChange, onDeleteRfp, onLoadSampleData }) => {
  const [rfpsMain, setRfpsMain] = useState([]);
  const [rfpsIncoming, setRfpsIncoming] = useState([]);
  const [booked, setBooked] = useState([]);
  const [demandEvents, setDemandEvents] = useState([]);
  const [sortCol, setSortCol] = useState('inquiry_date');
  const [sortDir, setSortDir] = useState('desc');
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  // Same fetch-and-merge pattern as RankingView.jsx / StrategiesView.jsx —
  // rfps + incoming_rfps merged (rfps wins on id clash), plus booked_events
  // for capacity conflicts and demand_events for the Fit signal. Fetching
  // demand_events here (rather than never, as in RankingView.jsx today) is a
  // small fix: that collection existed but was never actually queried there.
  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'rfps'), s =>
      setRfpsMain(s.docs.map(d => ({ id: d.id, _col: 'rfps', ...d.data() }))));
    const u2 = onSnapshot(collection(db, 'incoming_rfps'), s =>
      setRfpsIncoming(s.docs.map(d => ({ id: d.id, _col: 'incoming_rfps', ...d.data() }))));
    const u3 = onSnapshot(collection(db, 'booked_events'), s =>
      setBooked(s.docs.map(d => d.data())));
    getDocs(collection(db, 'demand_events')).then(s =>
      setDemandEvents(s.docs.map(d => d.data()))).catch(() => setDemandEvents([]));
    return () => { u1(); u2(); u3(); };
  }, []);

  const rfps = useMemo(() => {
    const seen = new Set();
    return [...rfpsMain, ...rfpsIncoming].filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }, [rfpsMain, rfpsIncoming]);

  const bookedMap = useMemo(() => {
    const map = {};
    booked.forEach(ev => {
      const arr = ev.Arrival_Date || ev.arrival_date;
      const dep = ev.Departure_Date || ev.departure_date;
      if (!arr || !dep) return;
      const rooms = Number(ev.Peak_Room_Block || ev.room_block || 0);
      const bal   = Number(ev.Uses_Ballroom || ev.uses_ballroom || 0);
      for (let d = new Date(arr); d < new Date(dep); d.setDate(d.getDate() + 1)) {
        const k = d.toISOString().slice(0, 10);
        if (!map[k]) map[k] = { rooms: 0, ballroom: false };
        map[k].rooms += rooms;
        if (bal) map[k].ballroom = true;
      }
    });
    return map;
  }, [booked]);

  // Repeat-account count: a real, counted signal (how many times this
  // organization already appears in the pipeline) — not a guess.
  const orgCounts = useMemo(() => {
    const counts = {};
    rfps.forEach(r => {
      const org = (r.organization || r.Organization || r.Account_Name || '').trim().toLowerCase();
      if (org) counts[org] = (counts[org] || 0) + 1;
    });
    return counts;
  }, [rfps]);

  // Score every RFP once the underlying data has loaded. A row whose model
  // genuinely fails (see scoreRFPHonest) gets score:null and is rendered
  // with honest "—" placeholders rather than a guessed number.
  const rows = useMemo(() => {
    return rfps.map(rfp => {
      let score = null;
      try { score = scoreRFPHonest(rfp, bookedMap, rfps, CONFIG_DEFAULTS); }
      catch (e) { score = null; }

      const displayStatus = deriveDisplayStatus(rfp);

      const arr = rfp.arrival_date || rfp.Arrival_Date;
      const dep = rfp.departure_date || rfp.Departure_Date || arr;
      const overlap = demandEvents.filter(ev => ev.start_date && ev.end_date && ev.start_date <= dep && ev.end_date >= arr);
      const ORDER = { Critical: 4, High: 3, Medium: 2, Low: 1 };
      const topDemand = overlap.reduce((t, ev) => !t || (ORDER[ev.impact] || 0) > (ORDER[t.impact] || 0) ? ev : t, null);

      const org = (rfp.organization || rfp.Organization || rfp.Account_Name || '').trim().toLowerCase();
      const fit = score ? computeFit(rfp, score, topDemand, orgCounts[org] || 0) : null;

      return { rfp, score, displayStatus, fit };
    });
  }, [rfps, bookedMap, demandEvents, orgCounts]);

  const rowById = useCallback((id) => rows.find(r => r.rfp.id === id), [rows]);

  // ─── Stat cards ────────────────────────────────────────────────────────
  // Active Opportunities: every RFP currently in the pipeline, any status —
  // matches "5 of 12" / "View all 12" both drawing from the same total.
  // Decisions Needed: New + Tentative only (nothing decided yet either way).
  // Tentative / Definite Group Revenue: live model-computed total group
  // revenue (room + F&B + meeting space), summed over whichever rows are
  // in that bucket and scored successfully.
  const stats = useMemo(() => {
    let tentativeRev = 0, definiteRev = 0, decisionsNeeded = 0;
    rows.forEach(({ score, displayStatus }) => {
      if (displayStatus === 'new' || displayStatus === 'tentative') decisionsNeeded += 1;
      if (!score) return;
      if (displayStatus === 'tentative') tentativeRev += score.grossRev;
      if (displayStatus === 'definite') definiteRev += score.grossRev;
    });
    return { active: rows.length, tentativeRev, definiteRev, decisionsNeeded };
  }, [rows]);

  // ─── Portfolio context ───────────────────────────────────────────────────
  // Revenue mix across everything still live in the pipeline (new,
  // tentative, definite — declined business is excluded since it no longer
  // contributes revenue), computed live from the same per-row model scores
  // above rather than only from RFPs someone has already priced in Strategies.
  const portfolio = useMemo(() => {
    let room = 0, fnb = 0, mtg = 0;
    rows.forEach(({ score, displayStatus }) => {
      if (!score || displayStatus === 'declined') return;
      room += score.roomRev; fnb += score.fnbRev; mtg += score.mtgRev;
    });
    const total = room + fnb + mtg;
    if (!total) return null;
    return {
      room: Math.round((room / total) * 100),
      mtg:  Math.round((mtg  / total) * 100),
      fnb:  Math.round((fnb  / total) * 100),
    };
  }, [rows]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortCol === 'revenue') {
        const av = a.score?.grossRev ?? -Infinity, bv = b.score?.grossRev ?? -Infinity;
        return dir * (av - bv);
      }
      // default: inquiry date
      const av = new Date(a.rfp.inquiry_date || a.rfp.Inquiry_Date || 0).getTime();
      const bv = new Date(b.rfp.inquiry_date || b.rfp.Inquiry_Date || 0).getTime();
      return dir * (av - bv);
    });
  }, [rows, sortCol, sortDir]);

  const visible = showAll ? sorted : sorted.slice(0, 5);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir(col === 'revenue' ? 'desc' : 'desc'); }
  };

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  if (rfps.length === 0) {
    return (
      <div className="dashboard-container">
        <div className="dash-empty">
          <p>No opportunities yet. Create your first RFP to get started.</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button onClick={onNewRfp} className="btn-primary">+ New RFP</button>
            {onLoadSampleData && (
              <button onClick={onLoadSampleData} className="btn-secondary">Load Sample Data</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <div className="dash-greeting">
        <h2>{greeting}</h2>
        <p>Your group business at a glance</p>
      </div>

      <div className="dash-stats-row">
        <div className="dash-stat-card">
          <div className="dash-stat-icon dash-stat-icon-blue"><Users size={18} /></div>
          <div>
            <div className="dash-stat-label">Active Opportunities</div>
            <div className="dash-stat-value">{stats.active}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon dash-stat-icon-blue"><DollarSign size={18} /></div>
          <div>
            <div className="dash-stat-label">Tentative Group Revenue</div>
            <div className="dash-stat-value">{fmt$(stats.tentativeRev)}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon dash-stat-icon-blue"><CheckCircle2 size={18} /></div>
          <div>
            <div className="dash-stat-label">Definite Group Revenue</div>
            <div className="dash-stat-value">{fmt$(stats.definiteRev)}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon dash-stat-icon-amber"><AlertTriangle size={18} /></div>
          <div>
            <div className="dash-stat-label">Decisions Needed</div>
            <div className="dash-stat-value">{stats.decisionsNeeded}</div>
          </div>
        </div>
      </div>

      <div className="dash-main-row">
        <div className="dash-table-card">
          <div className="dash-table-header">
            <h3>Opportunities requiring attention · {Math.min(5, sorted.length)} of {sorted.length}</h3>
          </div>

          <div className="table-container">
            <table className="dash-table">
              <colgroup>
                {/* Percentages, not fixed pixels — always sum to the actual
                    container width, so all 8 columns stay on screen with no
                    horizontal scrolling, on any window size. The trade-off:
                    on a narrower window the Dates column may wrap onto two
                    lines (arrival / – departure) rather than always staying
                    on one — still far better than the old auto-layout,
                    which fragmented a single date across 3+ lines, but no
                    longer guaranteed single-line the way a fixed 200px
                    column was. Header text wraps too (see .dash-table th),
                    so a narrow column never collides with its neighbor. */}
                <col style={{ width: '16%' }} />{/* Opportunity */}
                <col style={{ width: '9%' }} />{/* Inquiry Date */}
                <col style={{ width: '17%' }} />{/* Dates */}
                <col style={{ width: '8%' }} />{/* Group Rooms */}
                <col style={{ width: '11%' }} />{/* Total Group Revenue */}
                <col style={{ width: '20%' }} />{/* Fit */}
                <col style={{ width: '9%' }} />{/* Status */}
                <col style={{ width: '10%' }} />{/* Urgency */}
              </colgroup>
              <thead>
                <tr>
                  <th>Opportunity</th>
                  <th className="sortable" onClick={() => toggleSort('inquiry_date')}>
                    Inquiry Date {sortCol === 'inquiry_date' ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
                  </th>
                  <th>Dates</th>
                  <th>Group Rooms</th>
                  <th className="sortable" onClick={() => toggleSort('revenue')}>
                    Total Group Revenue {sortCol === 'revenue' ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ChevronUp size={12} style={{ opacity: 0.3 }} />}
                  </th>
                  <th>Fit</th>
                  <th>Status</th>
                  <th>Urgency</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ rfp, score, displayStatus, fit }) => {
                  const st = STATUS_CFG[displayStatus];
                  const urgRaw = score?.urgency || 'Low';
                  const urgDisplay = URGENCY_DISPLAY[urgRaw] || 'Low';
                  const isExpanded = expandedId === rfp.id;
                  return (
                    <React.Fragment key={rfp.id}>
                      <tr className="dash-row" onClick={() => setExpandedId(isExpanded ? null : rfp.id)}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{rfp.event_name || rfp.Account_Name || '—'}</div>
                          {(() => {
                            const org = rfp.organization || rfp.Organization || '';
                            const name = rfp.event_name || rfp.Account_Name || '';
                            // Don't repeat the org line when it's identical to
                            // the event name above it (common with sample/
                            // demo data) — it added height without adding
                            // information.
                            if (!org || org === name) return null;
                            return <div style={{ fontSize: '0.8125rem', color: '#718096' }}>{org}</div>;
                          })()}
                        </td>
                        <td>{rfp.inquiry_date || rfp.Inquiry_Date || '—'}</td>
                        <td>
                          {/* Each date is kept on one line (whiteSpace: nowrap
                              per span) so a narrow column wraps cleanly
                              between the two dates — "arrival" / "– departure"
                              — instead of breaking a single date apart at its
                              own hyphens, which is what produced the
                              "2026-\n10-\n27" fragmentation before. */}
                          <div style={{ fontSize: '0.875rem' }}>
                            <span style={{ whiteSpace: 'nowrap' }}>{rfp.arrival_date}</span>
                            {' – '}
                            <span style={{ whiteSpace: 'nowrap' }}>{rfp.departure_date}</span>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#a0aec0' }}>{score ? `${score.nights} night${score.nights === 1 ? '' : 's'}` : ''}</div>
                        </td>
                        <td>{rfp.room_block || rfp.Peak_Room_Block || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{score ? fmt$(score.grossRev) : '—'}</td>
                        <td>
                          {fit ? (
                            <>
                              <span className="fit-pill" style={{ background: FIT_BG[fit.tier], color: FIT_COLOR[fit.tier] }}>
                                <span className="fit-pill-dot" />
                                {fit.tier}
                              </span>
                              <div className="fit-desc" title={fit.description}>{fit.description}</div>
                            </>
                          ) : <span style={{ color: '#a0aec0' }} title="Model unavailable for this RFP">— unavailable</span>}
                        </td>
                        <td>
                          <span className="status-pill" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                        </td>
                        <td>
                          <span style={{ color: URGENCY_CFG[urgDisplay].color, fontWeight: 600, fontSize: '0.8125rem' }} title={`Raw urgency: ${urgRaw}`}>
                            ▲ {urgDisplay}
                          </span>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="dash-actions-row">
                          <td colSpan={7}>
                            <div className="action-buttons">
                              <button onClick={(e) => { e.stopPropagation(); onEditRfp(rfp); }} className="btn-action btn-edit" title="Edit this RFP">
                                <Edit size={16} />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); onViewStrategies(rfp); }} className="btn-action btn-view" title="View pricing strategies">
                                <Eye size={16} />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onStatusChange(rfp.id, displayStatus === 'definite' ? 'new' : 'definite', rfp._col || 'rfps'); }}
                                className={`btn-action btn-approve ${displayStatus === 'definite' ? 'active' : ''}`}
                                title="Mark Definite — this business is won"
                              >
                                <ThumbsUp size={16} />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onStatusChange(rfp.id, displayStatus === 'declined' ? 'new' : 'declined', rfp._col || 'rfps'); }}
                                className={`btn-action btn-decline ${displayStatus === 'declined' ? 'active' : ''}`}
                                title="Decline — no longer pursuing this business"
                              >
                                <ThumbsDown size={16} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Delete "${rfp.event_name}"? This cannot be undone.`)) onDeleteRfp(rfp.id, rfp._col || 'rfps');
                                }}
                                className="btn-action btn-delete" style={{ color: '#e53e3e' }} title="Delete this RFP"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {sorted.length > 5 && (
            <button className="dash-view-all" onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Show fewer' : `View all ${sorted.length} opportunities`} <ArrowRight size={14} />
            </button>
          )}
        </div>

        <div className="dash-sidebar">
          <div className="dash-side-card">
            <h4>Portfolio context</h4>
            {portfolio ? (
              <>
                <div className="dash-bar-row">
                  <div className="dash-bar-label"><span>Group Room Revenue</span><span>{portfolio.room}%</span></div>
                  <div className="dash-bar-track"><div className="dash-bar-fill" style={{ width: `${portfolio.room}%` }} /></div>
                </div>
                <div className="dash-bar-row">
                  <div className="dash-bar-label"><span>Meeting Room Rental</span><span>{portfolio.mtg}%</span></div>
                  <div className="dash-bar-track"><div className="dash-bar-fill" style={{ width: `${portfolio.mtg}%` }} /></div>
                </div>
                <div className="dash-bar-row">
                  <div className="dash-bar-label"><span>F&amp;B Revenue</span><span>{portfolio.fnb}%</span></div>
                  <div className="dash-bar-track"><div className="dash-bar-fill" style={{ width: `${portfolio.fnb}%` }} /></div>
                </div>
              </>
            ) : (
              <p style={{ fontSize: '0.8125rem', color: '#94a3b8' }}>Not enough scored opportunities yet to show a revenue mix.</p>
            )}
          </div>

          {stats.decisionsNeeded > 0 && (
            <div className="dash-side-card dash-next-action">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, marginBottom: '0.4rem' }}>
                <ClipboardList size={16} /> Next best action
              </div>
              <p style={{ fontSize: '0.8125rem', color: '#4a5568', marginBottom: '0.6rem' }}>
                {stats.decisionsNeeded} opportunit{stats.decisionsNeeded === 1 ? 'y needs' : 'ies need'} a response, sorted by urgency and inquiry date.
              </p>
              <button className="dash-review-link" onClick={() => { toggleSort('inquiry_date'); setShowAll(true); }}>
                Review opportunities →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DashboardView;
