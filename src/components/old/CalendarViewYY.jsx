import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import DemandEventModal from './DemandEventModal';
import { collection, onSnapshot } from 'firebase/firestore';
import {
  ChevronLeft, ChevronRight, Calendar, Users, Building2,
  Clock, CheckCircle2, AlertTriangle, Eye, Zap, Info,
  TrendingUp, X
} from 'lucide-react';
import './CalendarView.css';

// ── Constants ──────────────────────────────────────────────────────────────
const TOTAL_ROOMS = 220;
const DEMAND_COLORS = { Low: '#3b82f6', Medium: '#f59e0b', High: '#f97316', Critical: '#ef4444' };
const MEETING_ROOMS = [
  { id: 'ballroom',        label: 'Ballroom',        short: 'Ball',  capacity: 400 },
  { id: 'boardroom',       label: 'Boardroom',        short: 'Board', capacity: 20  },
  { id: 'executive_suite', label: 'Executive Suite',  short: 'Exec',  capacity: 12  },
  { id: 'salon',           label: 'Salon',            short: 'Salon', capacity: 60  },
];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const EVENT_COLORS = {
  booked:  { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af', dot: '#3b82f6' },
  pending: { bg: '#fef3c7', border: '#f59e0b', text: '#92400e', dot: '#f59e0b' },
  reviewing:{ bg: '#ede9fe', border: '#7c3aed', text: '#4c1d95', dot: '#7c3aed' },
  approved: { bg: '#d1fae5', border: '#10b981', text: '#065f46', dot: '#10b981' },
  declined: { bg: '#fee2e2', border: '#ef4444', text: '#991b1b', dot: '#ef4444' },
};

const OCC_GRADIENT = (pct) => {
  if (pct >= 0.90) return '#fee2e2'; // red – near full
  if (pct >= 0.75) return '#fef3c7'; // amber
  if (pct >= 0.50) return '#dbeafe'; // blue – healthy
  if (pct >= 0.25) return '#f0fdf4'; // green – light
  return '#ffffff';
};

const fmt$ = v => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'K' : Math.round(v));

// ── Helpers ────────────────────────────────────────────────────────────────
function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfWeek(year, month) {
  return new Date(year, month, 1).getDay();
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function dateRange(arrStr, depStr) {
  const dates = [];
  const arr = new Date(arrStr + 'T00:00:00');
  const dep = new Date(depStr + 'T00:00:00');
  for (let d = new Date(arr); d < dep; d.setDate(d.getDate() + 1)) {
    dates.push(isoDate(new Date(d)));
  }
  return dates;
}

// ── Event pill component ───────────────────────────────────────────────────
function EventPill({ ev, onClick }) {
  const status = ev._source === 'booked' ? 'booked'
    : (ev.Status || ev.status || 'pending').toLowerCase();
  const cfg = EVENT_COLORS[status] || EVENT_COLORS.pending;
  const name = ev.Account_Name || ev.account_name || ev.organization || '—';
  const rooms = ev.Peak_Room_Block || ev.room_block || 0;

  return (
    <div
      className={`event-pill ${ev._continues ? 'continues' : ''} ${ev._startsHere ? 'starts' : ''}`}
      style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.text }}
      onClick={e => { e.stopPropagation(); onClick(ev); }}
      title={`${name} · ${rooms} rooms`}
    >
      <span className="pill-dot" style={{ background: cfg.dot }} />
      <span className="pill-name">{name}</span>
      {ev._startsHere && rooms > 0 && (
        <span className="pill-rooms">{rooms}r</span>
      )}
    </div>
  );
}

// ── Day Cell ───────────────────────────────────────────────────────────────
function DayCell({ day, year, month, dayData, onDayClick, onEventClick, isToday, isSelected }) {
  if (!day) return <div className="day-cell empty" />;

  const {
    events = [], bookedRooms = 0, pendingRooms = 0, totalRooms = 0,
    ballroomBooked = false, ballroomPending = false,
    boardroomBooked = false, boardroomPending = false,
    execSuiteBooked = false, execSuitePending = false,
    salonBooked = false, salonPending = false,
    mtgRoomsBooked = 0, mtgRoomsPending = 0,
  } = dayData;
  const occPct  = totalRooms / TOTAL_ROOMS;
  const occBg   = OCC_GRADIENT(occPct);
  const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const totalMtg = mtgRoomsBooked + mtgRoomsPending;
  const demEvts = dayData.demandEvents || [];
  const topDemand = demEvts.reduce((top, ev) => {
    const order = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    return !top || (order[ev.impact] || 0) > (order[top.impact] || 0) ? ev : top;
  }, null);
  const hasMtgConflict = (ballroomBooked && ballroomPending) || (boardroomBooked && boardroomPending);

  const visibleEvents = events.slice(0, 2);
  const overflow = events.length - visibleEvents.length;

  return (
    <div
      className={`day-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${occPct > 0.85 ? 'high-occ' : ''}`}
      style={{ background: occPct > 0 ? occBg : undefined }}
      onClick={() => onDayClick(dateStr, dayData)}
    >
      <div className="day-header">
        <span className={`day-num ${isToday ? 'today-num' : ''}`}>{day}</span>
        {totalRooms > 0 && (
          <span className="occ-badge" title={`${totalRooms}/${TOTAL_ROOMS} rooms committed`}>
            {Math.round(occPct * 100)}%
          </span>
        )}
      </div>

      {totalRooms > 0 && (
        <div className="occ-bar-row">
          <div className="occ-bar-track">
            <div className="occ-bar-fill booked-fill"
              style={{ width: `${Math.min(100, bookedRooms/TOTAL_ROOMS*100)}%` }} />
            <div className="occ-bar-fill pending-fill"
              style={{ width: `${Math.min(100, pendingRooms/TOTAL_ROOMS*100)}%`, marginLeft: `${Math.min(100,bookedRooms/TOTAL_ROOMS*100)}%` }} />
          </div>
        </div>
      )}

      {/* Meeting room indicators */}
      {totalMtg > 0 && (
        <div className="mtg-indicators" style={{ display: 'flex', gap: '0.2rem', flexWrap: 'wrap', margin: '0.15rem 0' }}>
          {[
            { booked: ballroomBooked,  pending: ballroomPending,  label: 'Ball',  full: 'Ballroom' },
            { booked: boardroomBooked, pending: boardroomPending, label: 'Board', full: 'Boardroom' },
            { booked: execSuiteBooked, pending: execSuitePending, label: 'Exec',  full: 'Executive Suite' },
            { booked: salonBooked,     pending: salonPending,     label: 'Salon', full: 'Salon' },
          ].filter(r => r.booked || r.pending).map(r => {
            const conflict = r.booked && r.pending;
            return (
              <span key={r.label} className="mtg-chip"
                style={{ fontSize: '0.55rem', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600,
                  background: r.booked ? '#dbeafe' : '#fef3c7',
                  color: r.booked ? '#1e40af' : '#92400e',
                  border: `1px solid ${conflict ? '#ef4444' : 'transparent'}` }}
                title={`${r.full}: ${r.booked ? 'booked' : ''}${conflict ? ' + ' : ''}${r.pending ? 'pending' : ''}`}>
                {conflict ? '⚠ ' : ''}{r.label}
              </span>
            );
          })}
          {totalMtg > 0 && !(ballroomBooked || ballroomPending || boardroomBooked || boardroomPending) && (
            <span className="mtg-chip"
              style={{ fontSize: '0.55rem', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600,
                background: mtgRoomsBooked > 0 ? '#dbeafe' : '#fef3c7',
                color: mtgRoomsBooked > 0 ? '#1e40af' : '#92400e' }}
              title={`${totalMtg} meeting room(s) committed`}>
              {totalMtg} Mtg Rm{totalMtg > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      {topDemand && (
        <div style={{ fontSize: '0.55rem', padding: '0.1rem 0.3rem', borderRadius: '3px', fontWeight: 700,
          background: DEMAND_COLORS[topDemand.impact] + '20',
          color: DEMAND_COLORS[topDemand.impact],
          border: `1px solid ${DEMAND_COLORS[topDemand.impact]}55`,
          marginBottom: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={`${topDemand.impact} demand: ${topDemand.name}`}>
          ⚡ {topDemand.name}
        </div>
      )}
      <div className="event-pills">
        {visibleEvents.map((ev, i) => (
          <EventPill key={ev.id + '-' + i} ev={ev} onClick={onEventClick} />
        ))}
        {overflow > 0 && (
          <div className="overflow-tag">+{overflow} more</div>
        )}
      </div>
    </div>
  );
}

// ── Detail Panel ───────────────────────────────────────────────────────────
function DetailPanel({ date, dayData, onClose, onViewStrategies }) {
  if (!date || !dayData) return null;
  const { events = [], bookedRooms = 0, pendingRooms = 0 } = dayData;
  const fmtDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  return (
    <div className="detail-panel-overlay" onClick={onClose}>
      <div className="detail-panel-card" onClick={e => e.stopPropagation()}>
        <div className="dp-header">
          <div>
            <h3 className="dp-date">{fmtDate}</h3>
            <p className="dp-sub">
              {bookedRooms} booked · {pendingRooms} pending · {TOTAL_ROOMS - bookedRooms - pendingRooms} available
            </p>
          </div>
          <button className="dp-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="dp-occ-bar">
          <div className="dp-occ-fill booked" style={{ width: `${bookedRooms/TOTAL_ROOMS*100}%` }} />
          <div className="dp-occ-fill pending" style={{ width: `${pendingRooms/TOTAL_ROOMS*100}%` }} />
        </div>
        <div className="dp-occ-labels">
          <span className="dp-occ-label booked">■ Booked: {bookedRooms} rms</span>
          <span className="dp-occ-label pending">■ Pending: {pendingRooms} rms</span>
          <span className="dp-occ-label avail">□ Available: {TOTAL_ROOMS-bookedRooms-pendingRooms} rms</span>
        </div>

        {/* Demand events */}
      {(dayData?.demandEvents?.length > 0) && (
        <div style={{ margin: '0.75rem 0', padding: '0.6rem 0.75rem', background: '#fff8f0', borderRadius: '0.5rem', fontSize: '0.8125rem', border: '1px solid #fed7aa' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.4rem', color: '#9a3412' }}>⚡ External Demand Events</div>
          {dayData.demandEvents.map(ev => (
            <div key={ev.id} style={{ marginBottom: '0.5rem', paddingBottom: '0.5rem', borderBottom: '1px solid #fed7aa' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                <span style={{ fontWeight: 700, color: DEMAND_COLORS[ev.impact] || '#f97316' }}>{ev.name}</span>
                <span style={{ fontSize: '0.7rem', padding: '0.05rem 0.4rem', borderRadius: '3px', fontWeight: 600,
                  background: (DEMAND_COLORS[ev.impact] || '#f97316') + '20', color: DEMAND_COLORS[ev.impact] || '#f97316' }}>
                  {ev.impact}
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{ev.type} · {ev.attendance_size} · {ev.start_date} – {ev.end_date}</div>
              {ev.notes && <div style={{ fontSize: '0.72rem', color: '#92400e', marginTop: '0.2rem', fontStyle: 'italic' }}>{ev.notes}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Meeting space summary */}
        {(dayData.ballroomBooked || dayData.ballroomPending || dayData.boardroomBooked || dayData.boardroomPending || dayData.mtgRoomsBooked > 0 || dayData.mtgRoomsPending > 0) && (
          <div style={{ margin: '0.75rem 0', padding: '0.6rem 0.75rem', background: '#f8fafc', borderRadius: '0.5rem', fontSize: '0.8125rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.4rem', color: '#4a5568' }}>Meeting Spaces</div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {[
                { booked: dayData.ballroomBooked,  pending: dayData.ballroomPending,  label: 'Ballroom' },
                { booked: dayData.boardroomBooked, pending: dayData.boardroomPending, label: 'Boardroom' },
                { booked: dayData.execSuiteBooked, pending: dayData.execSuitePending, label: 'Executive Suite' },
                { booked: dayData.salonBooked,     pending: dayData.salonPending,     label: 'Salon' },
              ].filter(r => r.booked || r.pending).map(r => (
                <span key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span style={{ fontWeight: 500 }}>{r.label}:</span>
                  {r.booked && <span style={{ color: '#1e40af', background: '#dbeafe', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.75rem' }}>Booked</span>}
                  {r.pending && <span style={{ color: '#92400e', background: '#fef3c7', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.75rem' }}>Pending</span>}
                  {r.booked && r.pending && <span style={{ color: '#e53e3e', fontWeight: 700 }}>⚠ Conflict</span>}
                </span>
              ))}
              {(dayData.mtgRoomsBooked > 0 || dayData.mtgRoomsPending > 0) && !(dayData.ballroomBooked || dayData.ballroomPending || dayData.boardroomBooked || dayData.boardroomPending) && (
                <div>
                  <span style={{ fontWeight: 500 }}>Meeting Rooms:</span>{' '}
                  {Array.from({ length: dayData.mtgRoomsBooked }).map((_, i) => (
                    <span key={`b${i}`} style={{ color: '#1e40af', background: '#dbeafe', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.75rem', marginRight: '0.25rem' }}>
                      Room {i + 1} — Booked
                    </span>
                  ))}
                  {Array.from({ length: dayData.mtgRoomsPending }).map((_, i) => (
                    <span key={`p${i}`} style={{ color: '#92400e', background: '#fef3c7', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.75rem', marginRight: '0.25rem' }}>
                      Room {dayData.mtgRoomsBooked + i + 1} — Pending
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="dp-events">
          {events.length === 0 && (
            <p className="dp-empty">No events on this date.</p>
          )}
          {events.map((ev, i) => {
            const status = ev._source === 'booked' ? 'booked'
              : (ev.Status || ev.status || 'pending').toLowerCase();
            const cfg = EVENT_COLORS[status] || EVENT_COLORS.pending;
            const name  = ev.Account_Name || ev.account_name || ev.organization || '—';
            const type  = ev.Event_Type  || ev.event_type || '';
            const rooms = ev.Peak_Room_Block || ev.room_block || 0;
            const arr   = ev.Arrival_Date || ev.arrival_date || '';
            const dep   = ev.Departure_Date || ev.departure_date || '';
            const fnb   = ev.Proposed_FnB_Revenue || ev.proposed_fnb_revenue || 0;
            const mtg   = ev.Proposed_Meeting_Revenue || ev.proposed_meeting_revenue || 0;
            const total = ev.Proposed_Total_Revenue || ev.proposed_total_revenue || 0;
            return (
              <div key={i} className="dp-event-card" style={{ borderLeft: `4px solid ${cfg.border}` }}>
                <div className="dp-event-top">
                  <div>
                    <div className="dp-event-name">{name}</div>
                    <div className="dp-event-meta">{type} · {rooms} rooms · {arr.slice(0,10)} → {dep.slice(0,10)}</div>
                    {(() => {
                      const rd = ev.room_days || {};
                      const dateStr = ev._dateStr; // set below
                      const slots = rd[dateStr] || {};
                      const ROOMS_CFG = [
                        { id: 'ballroom', label: 'Ballroom', legacy: ev.uses_ballroom || ev.Uses_Ballroom },
                        { id: 'boardroom', label: 'Boardroom', legacy: ev.uses_boardroom || ev.Uses_Boardroom },
                        { id: 'executive_suite', label: 'Exec Suite', legacy: ev.uses_executive_suite },
                        { id: 'salon', label: 'Salon', legacy: ev.uses_salon },
                      ];
                      const activeRooms = ROOMS_CFG.filter(r =>
                        slots[r.id+'_active'] || slots[r.id] || r.legacy
                      );
                      if (activeRooms.length === 0 && !ev.has_meeting_space && !ev.Has_Meeting_Space) return null;
                      return (
                        <div style={{ fontSize: '0.72rem', color: '#718096', marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          🏛
                          {activeRooms.map(r => {
                            const roomData = slots[r.id] || {};
                            const timeLabel = roomData.start && roomData.end
                              ? ` ${roomData.start}–${roomData.end}`
                              : roomData.start ? ` from ${roomData.start}`
                              : '';
                            return (
                              <span key={r.id} style={{ background: '#dbeafe', color: '#1e40af', padding: '0 0.4rem', borderRadius: '3px' }}>
                                {r.label}{timeLabel}
                              </span>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                  <span className="dp-status-badge" style={{ background: cfg.bg, color: cfg.text, border: `1px solid ${cfg.border}` }}>
                    {status}
                  </span>
                </div>
                {(fnb > 0 || mtg > 0 || total > 0) && (
                  <div className="dp-event-rev">
                    {total > 0 && <span>Total: <strong>{fmt$(total)}</strong></span>}
                    {fnb > 0  && <span>F&amp;B: {fmt$(fnb)}</span>}
                    {mtg > 0  && <span>Mtg: {fmt$(mtg)}</span>}
                  </div>
                )}
                {ev._source === 'incoming' && (
                  <button
                    className="dp-strategy-btn"
                    onClick={() => { onViewStrategies(ev); onClose(); }}
                  >
                    <Zap size={12} /> View Strategy
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Legend ─────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div className="cal-legend">
      {Object.entries(EVENT_COLORS).filter(([k]) => k !== 'reviewing').map(([key, cfg]) => (
        <div key={key} className="legend-item">
          <span className="legend-dot" style={{ background: cfg.dot }} />
          <span className="legend-label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
        </div>
      ))}
      <div className="legend-sep" />
      <div className="legend-item">
        <div className="legend-occ-swatch" style={{ background: '#fee2e2' }} />
        <span className="legend-label">≥90% occ.</span>
      </div>
      <div className="legend-item">
        <div className="legend-occ-swatch" style={{ background: '#fef3c7' }} />
        <span className="legend-label">≥75%</span>
      </div>
      <div className="legend-item">
        <div className="legend-occ-swatch" style={{ background: '#dbeafe' }} />
        <span className="legend-label">≥50%</span>
      </div>
      <div className="legend-sep" />
      <div className="legend-item">
        <span style={{ fontSize: '0.65rem', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600, background: '#dbeafe', color: '#1e40af' }}>Ball</span>
        <span className="legend-label">Ballroom booked</span>
      </div>
      <div className="legend-item">
        <span style={{ fontSize: '0.65rem', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600, background: '#fef3c7', color: '#92400e' }}>Ball</span>
        <span className="legend-label">Ballroom pending</span>
      </div>
      <div className="legend-item">
        <span style={{ fontSize: '0.65rem', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600, background: '#fee2e2', color: '#e53e3e', border: '1px solid #ef4444' }}>⚠ Ball</span>
        <span className="legend-label">Conflict</span>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function CalendarView({ onViewStrategies }) {
  const today = new Date();
  const [year,  setYear]  = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const [booked,   setBooked]   = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [selected, setSelected] = useState(null);   // { date, dayData }
  const [hoveredEvent, setHoveredEvent] = useState(null);
  const [showFilter, setShowFilter] = useState('all'); // all | booked | pending

  const [rfpsMain, setRfpsMain] = useState([]);
  const [demandEvents, setDemandEvents] = useState([]);
  const [showAddDemand, setShowAddDemand] = useState(false);
  const [addDemandDate, setAddDemandDate] = useState(null);

  // Firestore listeners — booked_events + incoming_rfps + rfps
  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'booked_events'), snap =>
      setBooked(snap.docs.map(d => ({ id: d.id, _source: 'booked', ...d.data() }))));
    const u2 = onSnapshot(collection(db, 'incoming_rfps'), snap =>
      setIncoming(snap.docs.map(d => ({ id: d.id, _source: 'incoming', ...d.data() }))));
    const u3 = onSnapshot(collection(db, 'rfps'), snap =>
      setRfpsMain(snap.docs.map(d => ({ id: d.id, _source: 'rfp', ...d.data() }))));
    const u4 = onSnapshot(collection(db, 'demand_events'), snap =>
      setDemandEvents(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  // Merge incoming_rfps + rfps, deduplicate by id
  const allPending = useMemo(() => {
    const seen = new Set();
    return [...rfpsMain, ...incoming].filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      const st = (r.status || r.Status || '').toLowerCase();
      if (['declined', 'lost', 'rejected'].includes(st)) return false;
      return true;
    });
  }, [rfpsMain, incoming]);

  // Build per-day map for the displayed month + 1 month buffer each side
  const dayMap = useMemo(() => {
    const map = {};

    const addEvent = (ev, source) => {
      const arr = ev.Arrival_Date || ev.arrival_date;
      const dep = ev.Departure_Date || ev.departure_date;
      if (!arr || !dep) return;
      const isBooked  = source === 'booked';
      const status    = (ev.Status || ev.status || 'pending').toLowerCase();
      const rooms     = Number(ev.Peak_Room_Block || ev.room_block || 0);
      const dates     = dateRange(arr, dep);

      // Meeting space fields — support both legacy checkboxes and new per-day room_days
      const roomDays = ev.room_days || {};

      dates.forEach((dateStr, i) => {
        // Per-day room assignments (new format)
        const dayRooms = roomDays[dateStr] || {};
        // Legacy fallback
        const hasBallroom  = dayRooms.ballroom_active !== undefined ? dayRooms.ballroom_active : !!(ev.Uses_Ballroom || ev.uses_ballroom);
        const hasBoardroom = dayRooms.boardroom_active !== undefined ? dayRooms.boardroom_active : !!(ev.Uses_Boardroom || ev.uses_boardroom);
        const hasExecSuite = dayRooms.executive_suite_active !== undefined ? dayRooms.executive_suite_active : !!(ev.uses_executive_suite || ev.Uses_Executive_Suite);
        const hasSalon     = dayRooms.salon_active !== undefined ? dayRooms.salon_active : !!(ev.uses_salon || ev.Uses_Salon);
        const numMtgRooms  = [hasBallroom, hasBoardroom, hasExecSuite, hasSalon].filter(Boolean).length ||
          Number(ev.num_meeting_rooms || ev.Num_Meeting_Rooms || (ev.Has_Meeting_Space || ev.has_meeting_space ? 1 : 0));

        if (!map[dateStr]) map[dateStr] = {
          events: [], bookedRooms: 0, pendingRooms: 0, totalRooms: 0,
          ballroomBooked: false, ballroomPending: false,
          boardroomBooked: false, boardroomPending: false,
          execSuiteBooked: false, execSuitePending: false,
          salonBooked: false, salonPending: false,
          mtgRoomsBooked: 0, mtgRoomsPending: 0,
        };
        const entry = {
          ...ev,
          _source: source,
          _startsHere: i === 0,
          _continues: i > 0,
          _endsHere: i === dates.length - 1,
        };
        map[dateStr].events.push(entry);
        if (isBooked) {
          map[dateStr].bookedRooms += rooms;
          if (hasBallroom)  map[dateStr].ballroomBooked   = true;
          if (hasBoardroom) map[dateStr].boardroomBooked  = true;
          if (hasExecSuite) map[dateStr].execSuiteBooked  = true;
          if (hasSalon)     map[dateStr].salonBooked       = true;
          map[dateStr].mtgRoomsBooked += numMtgRooms;
        } else {
          map[dateStr].pendingRooms += rooms;
          if (hasBallroom)  map[dateStr].ballroomPending   = true;
          if (hasBoardroom) map[dateStr].boardroomPending  = true;
          if (hasExecSuite) map[dateStr].execSuitePending  = true;
          if (hasSalon)     map[dateStr].salonPending       = true;
          map[dateStr].mtgRoomsPending += numMtgRooms;
        }
        map[dateStr].totalRooms = map[dateStr].bookedRooms + map[dateStr].pendingRooms;
      });
    };

    const filtered_booked   = showFilter === 'pending' ? [] : booked;
    const filtered_incoming = showFilter === 'booked'  ? [] : allPending;

    filtered_booked.forEach(ev  => addEvent(ev, 'booked'));
    filtered_incoming.forEach(ev => addEvent(ev, 'incoming'));

    // Add demand events to map
    demandEvents.forEach(ev => {
      const start = ev.start_date;
      const end   = ev.end_date;
      if (!start || !end) return;
      const dates = [];
      for (let dt = new Date(start + 'T12:00:00'); dt.toISOString().slice(0,10) <= end; dt.setDate(dt.getDate() + 1)) {
        dates.push(dt.toISOString().slice(0,10));
      }
      dates.forEach(dateStr => {
        if (!map[dateStr]) map[dateStr] = { events: [], bookedRooms: 0, pendingRooms: 0, totalRooms: 0,
          ballroomBooked: false, ballroomPending: false, boardroomBooked: false, boardroomPending: false,
          execSuiteBooked: false, execSuitePending: false, salonBooked: false, salonPending: false,
          mtgRoomsBooked: 0, mtgRoomsPending: 0 };
        if (!map[dateStr].demandEvents) map[dateStr].demandEvents = [];
        map[dateStr].demandEvents.push(ev);
      });
    });

    return map;
  }, [booked, allPending, showFilter, demandEvents]);

  // Month navigation
  const prevMonth = () => { if (month === 0) { setMonth(11); setYear(y => y-1); } else setMonth(m => m-1); };
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear(y => y+1); } else setMonth(m => m+1); };
  const goToday   = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); };

  // Calendar grid
  const daysInMonth  = getDaysInMonth(year, month);
  const firstDayOfWk = getFirstDayOfWeek(year, month);
  const cells = [];
  for (let i = 0; i < firstDayOfWk; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const todayStr = isoDate(today);

  // Month summary stats
  const monthStats = useMemo(() => {
    let bookedEvs = 0, pendingEvs = 0, totalBookedRms = 0, totalPendingRms = 0;
    const seen = new Set();
    for (let d = 1; d <= getDaysInMonth(year, month); d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dd = dayMap[dateStr];
      if (!dd) continue;
      dd.events.forEach(ev => {
        if (ev._startsHere && !seen.has(ev.id)) {
          seen.add(ev.id);
          if (ev._source === 'booked') bookedEvs++;
          else pendingEvs++;
        }
        if (ev._source === 'booked') totalBookedRms += (ev.Peak_Room_Block || ev.room_block || 0) / dd.events.filter(e=>e._source==='booked').length;
        else totalPendingRms += (ev.Peak_Room_Block || ev.room_block || 0) / dd.events.filter(e=>e._source!=='booked').length;
      });
    }
    const avgOcc = Object.entries(dayMap)
      .filter(([k]) => k.startsWith(`${year}-${String(month+1).padStart(2,'0')}`))
      .map(([,v]) => v.totalRooms / TOTAL_ROOMS);
    const avg = avgOcc.length ? avgOcc.reduce((s,v)=>s+v,0)/avgOcc.length : 0;
    return { bookedEvs, pendingEvs, avgOcc: avg };
  }, [dayMap, year, month]);

  return (
    <div className="calendar-view">

      {/* ── Toolbar ── */}
      <div className="cal-toolbar">
        <div className="cal-toolbar-left">
          <h2 className="cal-title">
            <Calendar size={20} className="cal-title-icon" />
            MERIT Hotel Calendar
          </h2>
          <div className="cal-month-nav">
            <button className="nav-btn" onClick={prevMonth}><ChevronLeft size={18} /></button>
            <span className="cal-month-label">{MONTHS[month]} {year}</span>
            <button className="nav-btn" onClick={nextMonth}><ChevronRight size={18} /></button>
            <button className="today-btn" onClick={goToday}>Today</button>
          </div>
        </div>
        <div className="cal-toolbar-right">
          <button
            onClick={() => setShowAddDemand(true)}
            style={{ padding: '0.4rem 0.85rem', background: '#fff8f0', border: '1px solid #fed7aa',
              borderRadius: '6px', color: '#9a3412', fontWeight: 600, cursor: 'pointer',
              fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              marginRight: '0.75rem', whiteSpace: 'nowrap' }}>
            ⚡ Add Demand Event
          </button>
          {/* Filter toggle */}
          <div className="view-toggle">
            {['all','booked','pending'].map(f => (
              <button
                key={f}
                className={`toggle-btn ${showFilter === f ? 'active' : ''}`}
                onClick={() => setShowFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'booked' ? '● Booked' : '◑ Pending'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Calendar check banner ── */}
      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '0.5rem',
        padding: '0.6rem 1rem', margin: '0 0 0.75rem 0',
        display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.8125rem', color: '#1e40af'
      }}>
        <Info size={14} style={{ flexShrink: 0 }} />
        <span>Check occupancy and conflicts here before generating a pricing strategy. Open dates with &lt;50% occupancy are strong candidates for group business.</span>
      </div>

      {/* ── Month summary strip ── */}
      <div className="cal-stats-strip">
        <div className="cal-stat">
          <CheckCircle2 size={15} className="stat-icon booked-icon" />
          <span className="cal-stat-val">{monthStats.bookedEvs}</span>
          <span className="cal-stat-label">booked events</span>
        </div>
        <div className="cal-stat-sep" />
        <div className="cal-stat">
          <Clock size={15} className="stat-icon pending-icon" />
          <span className="cal-stat-val">{monthStats.pendingEvs}</span>
          <span className="cal-stat-label">pending RFPs</span>
        </div>
        <div className="cal-stat-sep" />
        <div className="cal-stat">
          <TrendingUp size={15} className="stat-icon occ-icon" />
          <span className="cal-stat-val">{Math.round(monthStats.avgOcc * 100)}%</span>
          <span className="cal-stat-label">avg committed occ.</span>
        </div>
        <div className="cal-stat-sep" />
        <div className="cal-stat">
          <Building2 size={15} className="stat-icon rooms-icon" />
          <span className="cal-stat-val">{TOTAL_ROOMS}</span>
          <span className="cal-stat-label">total rooms</span>
        </div>
      </div>

      {/* ── Grid ── */}
      <div className="cal-grid-wrap">
        {/* Day headers */}
        <div className="cal-day-headers">
          {DAYS.map(d => <div key={d} className="day-header-cell">{d}</div>)}
        </div>

        {/* Day cells */}
        <div className="cal-grid">
          {cells.map((day, i) => {
            const dateStr = day
              ? `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
              : null;
            const dd = dateStr ? (dayMap[dateStr] || {}) : {};
            return (
              <DayCell
                key={i}
                day={day}
                year={year}
                month={month}
                dayData={dd}
                isToday={dateStr === todayStr}
                isSelected={selected?.date === dateStr}
                onDayClick={(date, data) => setSelected({ date, dayData: data })}
                onEventClick={ev => setSelected({ date: dateStr, dayData: dd })}
              />
            );
          })}
        </div>
      </div>

      {/* ── Legend ── */}
      <Legend />

      {/* ── Detail panel (modal) ── */}
      {selected && (
        <DetailPanel
          date={selected.date}
          dayData={selected.dayData}
          onClose={() => setSelected(null)}
          onViewStrategies={onViewStrategies}
        />
      )}

      {showAddDemand && (
        <DemandEventModal
          defaultDate={null}
          onClose={() => setShowAddDemand(false)}
          onSaved={() => setShowAddDemand(false)}
        />
      )}
    </div>
  );
}
