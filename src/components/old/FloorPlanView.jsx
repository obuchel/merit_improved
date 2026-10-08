import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { Building2, ChevronLeft, ChevronRight, CheckCircle2, Clock, Layers } from 'lucide-react';

// ── Constants ────────────────────────────────────────────────────────────
// Matches TOTAL_ROOMS used elsewhere in the app (App.jsx, CalendarView.jsx, RankingView.jsx)
const TOTAL_ROOMS     = 220;
const FLOORS          = 2;
const ROOMS_PER_FLOOR = TOTAL_ROOMS / FLOORS;   // 110
const ROOMS_PER_WING  = ROOMS_PER_FLOOR / 2;    // 55
const WING_COLS       = 11;                     // 11 x 5 grid per wing

const STATUS_STYLE = {
  booked:    { bg: '#3b82f6', border: '#2563eb', text: '#fff',    label: 'Booked' },
  pending:   { bg: '#f59e0b', border: '#d97706', text: '#fff',    label: 'Pending RFP' },
  available: { bg: '#f0fdf4', border: '#86efac', text: '#166534', label: 'Available' },
};

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Handles all three shapes seen across collections in this app:
// plain 'YYYY-MM-DD' strings (rfps), Firestore Timestamps (incoming_rfps,
// possibly booked_events), and JS Date objects.
function toDateStr(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function roomsOnDate(list, dateStr) {
  let total = 0;
  list.forEach(ev => {
    const arr = toDateStr(ev.Arrival_Date || ev.arrival_date);
    const dep = toDateStr(ev.Departure_Date || ev.departure_date);
    if (!arr || !dep) return;
    if (dateStr >= arr && dateStr < dep) {
      total += Number(ev.Peak_Room_Block || ev.room_block || 0);
    }
  });
  return total;
}

export default function FloorPlanView() {
  const [booked,   setBooked]   = useState([]);
  const [rfpsMain, setRfpsMain] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selectedDate, setSelectedDate] = useState(() => isoDate(new Date()));
  const [hoveredTile, setHoveredTile] = useState(null);

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'booked_events'), snap => {
      setBooked(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    const u2 = onSnapshot(collection(db, 'rfps'), snap =>
      setRfpsMain(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const u3 = onSnapshot(collection(db, 'incoming_rfps'), snap =>
      setIncoming(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => { u1(); u2(); u3(); };
  }, []);

  // Pending pipeline = rfps + incoming_rfps, deduped, excluding dead ones
  const allPending = useMemo(() => {
    const seen = new Set();
    return [...rfpsMain, ...incoming].filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      const st = (r.status || r.Status || '').toLowerCase();
      return !['declined', 'lost', 'rejected'].includes(st);
    });
  }, [rfpsMain, incoming]);

  const bookedRooms = useMemo(
    () => Math.min(TOTAL_ROOMS, roomsOnDate(booked, selectedDate)),
    [booked, selectedDate]
  );
  const pendingRooms = useMemo(
    () => Math.min(TOTAL_ROOMS - bookedRooms, roomsOnDate(allPending, selectedDate)),
    [allPending, selectedDate, bookedRooms]
  );
  const availableRooms = TOTAL_ROOMS - bookedRooms - pendingRooms;
  const occPct = Math.round(((bookedRooms + pendingRooms) / TOTAL_ROOMS) * 100);

  // NOTE: the underlying data only tracks aggregate room counts per date —
  // there's no real per-room inventory (numbers/floors) anywhere in Firestore.
  // Tile assignment below is a deterministic, illustrative fill (booked rooms
  // fill first, then pending), not a mapping to any specific real room.
  const tiles = useMemo(() => {
    return Array.from({ length: TOTAL_ROOMS }, (_, i) => {
      let status = 'available';
      if (i < bookedRooms) status = 'booked';
      else if (i < bookedRooms + pendingRooms) status = 'pending';

      const floor       = Math.floor(i / ROOMS_PER_FLOOR) + 1;
      const idxOnFloor  = i % ROOMS_PER_FLOOR;
      const wing        = idxOnFloor < ROOMS_PER_WING ? 'A' : 'B';
      const idxInWing   = idxOnFloor % ROOMS_PER_WING;
      const roomNo      = `${floor}${String(idxInWing + 1).padStart(2, '0')}${wing}`;

      return { key: i, status, floor, wing, roomNo };
    });
  }, [bookedRooms, pendingRooms]);

  const floors = [1, 2].map(f => ({
    floor: f,
    wingA: tiles.filter(t => t.floor === f && t.wing === 'A'),
    wingB: tiles.filter(t => t.floor === f && t.wing === 'B'),
  }));

  const shiftDate = (days) => {
    const d = new Date(selectedDate + 'T00:00:00');
    d.setDate(d.getDate() + days);
    setSelectedDate(isoDate(d));
  };

  const RoomTile = ({ t }) => {
    const s = STATUS_STYLE[t.status];
    const isHovered = hoveredTile === t.key;
    return (
      <div
        onMouseEnter={() => setHoveredTile(t.key)}
        onMouseLeave={() => setHoveredTile(null)}
        title={`Room ${t.roomNo} — ${s.label}`}
        style={{
          aspectRatio: '1',
          borderRadius: 4,
          background: s.bg,
          border: `1.5px solid ${s.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.55rem', fontWeight: 700,
          color: s.text,
          cursor: 'default',
          transform: isHovered ? 'scale(1.12)' : 'scale(1)',
          boxShadow: isHovered ? '0 2px 6px rgba(0,0,0,0.25)' : 'none',
          transition: 'transform 0.1s, box-shadow 0.1s',
          position: 'relative', zIndex: isHovered ? 2 : 1,
        }}
      >
        {t.roomNo}
      </div>
    );
  };

  const WingGrid = ({ rooms }) => (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${WING_COLS}, 1fr)`, gap: 4 }}>
      {rooms.map(t => <RoomTile key={t.key} t={t} />)}
    </div>
  );

  const StatCard = ({ icon, val, label, color }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.6rem',
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
      padding: '0.75rem 1rem', flex: '1 1 140px',
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8, background: color + '18',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color,
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1a202c', lineHeight: 1.1 }}>{val}</div>
        <div style={{ fontSize: '0.7rem', color: '#718096', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      </div>
    </div>
  );

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui', maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Building2 size={20} color="#5b5fc7" />
          <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 700, color: '#1a202c' }}>Floor Plan</h2>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <button onClick={() => shiftDate(-1)} style={navBtnStyle} aria-label="Previous day">
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            style={{ padding: '0.45rem 0.6rem', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: '0.875rem' }}
          />
          <button onClick={() => shiftDate(1)} style={navBtnStyle} aria-label="Next day">
            <ChevronRight size={16} />
          </button>
          <button onClick={() => setSelectedDate(isoDate(new Date()))} style={{ ...navBtnStyle, width: 'auto', padding: '0 0.75rem', fontSize: '0.8rem' }}>
            Today
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>Loading room data…</div>
      ) : (
        <>
          {/* ── Stats strip ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <StatCard icon={<CheckCircle2 size={16} />} val={bookedRooms}    label="Booked"     color="#3b82f6" />
            <StatCard icon={<Clock size={16} />}        val={pendingRooms}   label="Pending"    color="#f59e0b" />
            <StatCard icon={<Layers size={16} />}       val={availableRooms} label="Available"  color="#10b981" />
            <StatCard icon={<Building2 size={16} />}    val={`${occPct}%`}   label="Committed"  color="#5b5fc7" />
          </div>

          {/* ── Legend ── */}
          <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center', marginBottom: '1.25rem', fontSize: '0.8rem', color: '#4a5568' }}>
            {Object.entries(STATUS_STYLE).map(([key, s]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: s.bg, border: `1.5px solid ${s.border}`, display: 'inline-block' }} />
                {s.label}
              </div>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#a0aec0', fontStyle: 'italic' }}>
              Room numbers are illustrative — the underlying data tracks room counts per date, not specific rooms
            </span>
          </div>

          {/* ── Floors ── */}
          {floors.map(({ floor, wingA, wingB }) => (
            <div key={floor} style={{
              background: '#fafafa', border: '2px solid #94a3b8', borderRadius: 4,
              padding: '1.5rem', marginBottom: '1.5rem',
              clipPath: 'polygon(0 0, calc(100% - 28px) 0, 100% 28px, 100% 100%, 0 100%)',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '1.1rem' }}>
                <span style={{ fontSize: '1rem', fontWeight: 700, color: '#1a202c', fontFamily: 'Georgia, serif' }}>
                  Floor {floor}
                </span>
                <span style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.05em' }}>
                  {floor === 1 ? 'ground level' : `level ${floor}`}
                </span>
              </div>

              {/* Wing A */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Wing A
                </span>
                <ExitTag />
              </div>
              <WingGrid rooms={wingA} />

              {/* Corridor */}
              <div style={{
                height: 24, margin: '0.6rem 0', background: 'repeating-linear-gradient(90deg, #e2e8f0 0 10px, #edf2f7 10px 20px)',
                border: '1px solid #cbd5e0', borderRadius: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.6rem', color: '#a0aec0', textTransform: 'uppercase', letterSpacing: '0.1em',
              }}>
                Corridor
              </div>

              {/* Wing B */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Wing B
                </span>
                <ExitTag />
              </div>
              <WingGrid rooms={wingB} />

              {/* Linen closet */}
              <div style={{
                marginTop: '0.6rem', width: 90, height: 30,
                background: 'repeating-linear-gradient(135deg, #e2e8f0 0 6px, #f1f5f9 6px 12px)',
                border: '1px solid #cbd5e0', borderRadius: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.6rem', color: '#718096', textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Linen
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ExitTag() {
  return (
    <span style={{
      fontSize: '0.6rem', fontWeight: 700, color: '#166534', background: '#f0fdf4',
      border: '1px solid #86efac', borderRadius: 3, padding: '0.1rem 0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      Exit
    </span>
  );
}

const navBtnStyle = {
  width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#4a5568',
};
