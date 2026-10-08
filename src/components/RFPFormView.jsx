import React, { useState, useEffect } from 'react';
import './RFPForm.css';

// Field labels below are sourced from MERIT Data & Feature Dictionary.xlsx
// ("Unified Data Dictionary" tab) — not invented. A few raw fields that
// dictionary lists ARE deliberately left out of this form:
//   - num_fnb_types, full_day_pct: dictionary Label = "Do not display" —
//     business rule / denominator not yet defined (see Notes column). Kept
//     as internal defaults only until that's resolved; do not add inputs
//     for these without checking the dictionary again.
//   - rate_spread: dictionary marks this "Engineered / model-derived" with
//     Interface Location "Advanced Analytics" — it is not planner-entered
//     intake data, so it does not belong on this form at all.

const MEETING_ROOMS = [
  { id: 'ballroom',        label: 'Ballroom',        capacity: 400, note: 'Large general sessions, receptions, banquets' },
  { id: 'boardroom',       label: 'Boardroom',        capacity: 20,  note: 'Executive meetings, small groups' },
  { id: 'executive_suite', label: 'Executive Suite',  capacity: 12,  note: 'VIP meetings, private dining' },
  { id: 'salon',           label: 'Salon',            capacity: 60,  note: 'Breakout sessions, workshops' },
];

const AV_LEVELS = [ { value: 1, label: 'Basic' }, { value: 2, label: 'Standard' }, { value: 3, label: 'Premium' } ];

const chk = { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem', cursor: 'pointer', padding: '0.2rem 0' };

const F = ({ label, children, full, hint }) => (
  <div className={full ? 'form-group full-width' : 'form-group'}>
    <label>{label}</label>
    {children}
    {hint && <div className="field-hint">{hint}</div>}
  </div>
);

const Section = ({ title, note, children }) => (
  <div className="form-section">
    <div className="section-title">{title}</div>
    {note && <div className="section-note">{note}</div>}
    {children}
  </div>
);

const RFPFormView = ({ rfp, onSave, onBack, isEdit = false, compact = false }) => {
  // App.jsx renders this form in a fixed 500px-wide side panel when editing
  // alongside Strategies (compact={true}). A 2- or 4-column grid doesn't fit
  // that width — fields were getting clipped/scrolled out of view (e.g.
  // Client Priority). In compact mode every row collapses to one column
  // instead of relying on the viewport-width media queries in RFPForm.css,
  // which never fire for a narrow panel inside a wide browser window.
  const rc = (mod) => compact ? 'form-row cols-1' : `form-row ${mod}`;
  const [d, setD] = useState({
    event_name: '', event_type: 'Corporate', event_format: 'In-person',
    event_configuration: 'Full Package', organization: '', market_segment: '',
    organization_industry: '',
    lead_source: 'Direct Inquiry', arrival_date: '', departure_date: '',
    attendees: '', meeting_attendees: '', room_block: '', client_priority: 'Medium',
    client_priority_cvent: 'Medium', destinations_considered: 2,
    decision_days_cvent: '', response_due_days: '',
    inquiry_date: new Date().toISOString().split('T')[0],
    forecasted_occupancy: 0.75, contact_name: '', contact_email: '',
    contact_phone: '', special_requirements: '', budget_provided: false,
    budget_amount: '',
    has_meeting_space: true, has_fnb_requirements: true,
    num_meeting_rooms: 1, num_sessions: 2, total_meeting_hours: 8,
    uses_ballroom: false, uses_boardroom: true, max_av_level: 2,
    has_premium_av: false, num_fnb_types: 3, has_dinner: false,
    has_reception: false, has_evening_session: false, full_day_pct: 50,
    standard_rooms_count: '', premium_rooms_count: '', suites_count: '',
    num_room_types: 3, pct_standard_rooms: 60, pct_premium_rooms: 40,
    has_suites: false, rate_spread: 50,
  });

  const [nights, setNights] = useState(0);

  useEffect(() => {
    if (rfp && isEdit) {
      setD(prev => ({
        ...prev,
        // Merge ALL fields from the stored RFP — not just the ones pre-declared in
        // the default state. This ensures fields written by other surfaces
        // (e.g. account_name, Account_Name, status) are preserved and round-trip
        // correctly through the edit form.
        ...rfp,
        // Normalise camelCase aliases so the form inputs always have a value
        event_name:       rfp.event_name       || rfp.Account_Name    || rfp.account_name    || prev.event_name,
        organization:     rfp.organization      || rfp.Organization    || prev.organization,
        event_type:       rfp.event_type        || rfp.Event_Type      || prev.event_type,
        attendees:        rfp.attendees         ?? rfp.Attendees       ?? prev.attendees,
        room_block:       rfp.room_block        ?? rfp.Peak_Room_Block ?? prev.room_block,
        arrival_date:     rfp.arrival_date      || rfp.Arrival_Date    || prev.arrival_date,
        departure_date:   rfp.departure_date    || rfp.Departure_Date  || prev.departure_date,
        inquiry_date:     rfp.inquiry_date      || rfp.Inquiry_Date    || prev.inquiry_date,
        meeting_attendees:rfp.meeting_attendees ?? rfp.Meeting_Attendees ?? prev.meeting_attendees,
        forecasted_occupancy: rfp.forecasted_occupancy ?? rfp.Forecasted_Occupancy ?? prev.forecasted_occupancy,
        // Reverse-populate raw room-type counts from stored pct/derived fields
        // when editing an older RFP that predates this breakdown being captured.
        standard_rooms_count: rfp.standard_rooms_count ?? prev.standard_rooms_count,
        premium_rooms_count:  rfp.premium_rooms_count  ?? prev.premium_rooms_count,
        suites_count:         rfp.suites_count         ?? prev.suites_count,
        room_days: rfp.room_days && typeof rfp.room_days === 'object' ? rfp.room_days : (prev.room_days || {}),
      }));
    }
  }, [rfp, isEdit]);

  useEffect(() => {
    if (d.arrival_date && d.departure_date) {
      const n = Math.ceil((new Date(d.departure_date) - new Date(d.arrival_date)) / 864e5);
      setNights(n > 0 ? n : 0);
    } else setNights(0);
  }, [d.arrival_date, d.departure_date]);

  const ch = (e) => {
    const { name, value, type, checked } = e.target;
    setD(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!d.event_name || !d.arrival_date || !d.departure_date || !d.attendees || !d.room_block) {
      alert('Please fill in all required fields'); return;
    }
    const roomDaysData = d.room_days || {};
    const activeRooms = new Set();
    Object.values(roomDaysData).forEach(day => {
      MEETING_ROOMS.forEach(r => { if (day[r.id + '_active']) activeRooms.add(r.id); });
    });

    // Room type mix: capture the raw counts upstream (per data dictionary —
    // "capture upstream; do not rely only on derived percentages") and derive
    // num_room_types / pct_standard_rooms / pct_premium_rooms / has_suites
    // from them, the same way `nights` is derived from arrival/departure.
    const stdCount = parseInt(d.standard_rooms_count) || 0;
    const premCount = parseInt(d.premium_rooms_count) || 0;
    const suiteCount = parseInt(d.suites_count) || 0;
    const roomTypeTotal = stdCount + premCount + suiteCount;
    const numRoomTypes = [stdCount, premCount, suiteCount].filter(n => n > 0).length;

    onSave({
      // Preserve ALL original fields so Firestore keeps existing data intact
      ...(isEdit && rfp ? rfp : {}),
      // Then apply all form state on top
      ...d,
      // Coerce numeric fields
      attendees:            parseInt(d.attendees),
      meeting_attendees:    parseInt(d.meeting_attendees) || 0,
      room_block:           parseInt(d.room_block),
      forecasted_occupancy: parseFloat(d.forecasted_occupancy),
      destinations_considered: parseInt(d.destinations_considered) || 0,
      decision_days_cvent:  d.decision_days_cvent === '' ? null : parseInt(d.decision_days_cvent),
      response_due_days:    d.response_due_days === '' ? null : parseInt(d.response_due_days),
      num_sessions:         parseInt(d.num_sessions),
      total_meeting_hours:  parseInt(d.total_meeting_hours),
      max_av_level:         parseInt(d.max_av_level),
      num_fnb_types:        parseInt(d.num_fnb_types),
      full_day_pct:         parseInt(d.full_day_pct),
      rate_spread:          parseInt(d.rate_spread),
      budget_amount:        d.budget_provided ? parseFloat(d.budget_amount) || 0 : 0,
      // Room type mix — raw counts plus the fields derived from them
      standard_rooms_count: stdCount,
      premium_rooms_count:  premCount,
      suites_count:         suiteCount,
      num_room_types:       roomTypeTotal > 0 ? numRoomTypes : d.num_room_types,
      pct_standard_rooms:   roomTypeTotal > 0 ? Math.round((stdCount / roomTypeTotal) * 100) : d.pct_standard_rooms,
      pct_premium_rooms:    roomTypeTotal > 0 ? Math.round((premCount / roomTypeTotal) * 100) : d.pct_premium_rooms,
      has_suites:           roomTypeTotal > 0 ? suiteCount > 0 : d.has_suites,
      // Sync both field-name conventions so dashboard always finds the value
      account_name:         d.event_name,
      Account_Name:         d.event_name,
      // Room schedule derived fields
      room_days:            roomDaysData,
      uses_ballroom:        Object.values(roomDaysData).some(day => day.ballroom_active),
      uses_boardroom:       Object.values(roomDaysData).some(day => day.boardroom_active),
      uses_executive_suite: Object.values(roomDaysData).some(day => day.executive_suite_active),
      uses_salon:           Object.values(roomDaysData).some(day => day.salon_active),
      num_meeting_rooms:    activeRooms.size || d.num_meeting_rooms || 0,
    }, isEdit);
  };

  return (
    <div className="rfp-form-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1a202c', margin: 0 }}>{isEdit ? 'Edit RFP' : 'New RFP'}</h2>
        <button type="button" onClick={onBack} style={{ padding: '0.35rem 0.75rem', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#fff', cursor: 'pointer', color: '#6b7280', fontSize: '0.8rem' }}>← Back</button>
      </div>

      <form className="rfp-form" onSubmit={handleSubmit}>

        {/* Event */}
        <Section title="Event" note="Basic details about the group business.">
          <div className={rc('cols-2')}>
            <F label="Event Name *" full>
              <input type="text" name="event_name" value={d.event_name} onChange={ch} required placeholder="e.g., Annual Tech Conference" />
            </F>
          </div>
          <div className={rc('cols-4')}>
            <F label="Event Type"><select name="event_type" value={d.event_type} onChange={ch}>{['Corporate','Association','Wedding/Social','SMERF','Tour/Travel'].map(s=><option key={s}>{s}</option>)}</select></F>
            <F label="Event Format"><select name="event_format" value={d.event_format} onChange={ch}>{['In-person','Virtual','Hybrid'].map(s=><option key={s}>{s}</option>)}</select></F>
            <F label="Meeting Setup" hint="Rooms only, meeting space only, or full package">
              <select name="event_configuration" value={d.event_configuration} onChange={ch}>{['Rooms Only','Meeting Space Only','Full Package'].map(s=><option key={s}>{s}</option>)}</select>
            </F>
            <F label="Client Priority"><select name="client_priority" value={d.client_priority} onChange={ch}>{['Low','Medium','High'].map(s=><option key={s}>{s}</option>)}</select></F>
          </div>
        </Section>

        {/* Organization & classification */}
        <Section title="Organization & classification" note="Market Segment and Account Industry are tracked separately — they answer different questions.">
          <div className={rc('cols-2')}>
            <F label="Organization" full><input type="text" name="organization" value={d.organization} onChange={ch} placeholder="e.g., TechCorp Inc" /></F>
          </div>
          <div className="split-callout">
            <div><b>Market Segment</b> is the type of hotel business this deal represents. <b>Account Industry</b> is the customer&rsquo;s own industry. Both are kept so Trends can report on either.</div>
          </div>
          <div className={rc('cols-2')}>
            <F label="Market Segment" hint="Corporate, Association, SMERF, Government, Social…">
              <select name="market_segment" value={d.market_segment} onChange={ch}>
                <option value="">Select...</option>
                {['Corporate','Association','SMERF','Government','Social','Technology','Healthcare','Finance','Legal','Education','Non-Profit','Real Estate','Professional Services','Trade/Manufacturing','Travel','Other'].map(s=><option key={s}>{s}</option>)}
              </select>
            </F>
            <F label="Account Industry" hint="Healthcare, Finance, Technology, Education…">
              <select name="organization_industry" value={d.organization_industry} onChange={ch}>
                <option value="">Select...</option>
                {['Technology','Healthcare','Finance','Legal','Education','Non-Profit','Government','Real Estate','Professional Services','Trade/Manufacturing','Other'].map(s=><option key={s}>{s}</option>)}
              </select>
            </F>
          </div>
        </Section>

        {/* Dates & rooms */}
        <Section title="Dates & rooms" note="Confirm the stay window and group block.">
          <div className={rc('cols-4')}>
            <F label="Arrival Date *"><input type="date" name="arrival_date" value={d.arrival_date} onChange={ch} required /></F>
            <F label="Departure Date *"><input type="date" name="departure_date" value={d.departure_date} onChange={ch} required /></F>
            <F label="Nights"><input className="calculated-field" value={nights || '—'} readOnly /></F>
            <F label="Group Room Block *"><input type="number" name="room_block" value={d.room_block} onChange={ch} required min="1" placeholder="80" /></F>
          </div>
          <div className={rc('cols-4')}>
            <F label="Expected Attendees *"><input type="number" name="attendees" value={d.attendees} onChange={ch} required min="1" placeholder="150" /></F>
            <F label="Meeting Attendees"><input type="number" name="meeting_attendees" value={d.meeting_attendees} onChange={ch} min="0" placeholder="120" /></F>
            <F label="Hotel Forecasted Occupancy" hint="Pulled from PMS/RMS — confirm before saving">
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input style={{ flex: 1 }} type="number" name="forecasted_occupancy"
                  value={Math.round(d.forecasted_occupancy * 100)}
                  onChange={e => ch({ target: { name: 'forecasted_occupancy', value: parseFloat(e.target.value) / 100 || 0 } })}
                  min="0" max="100" />
                <span style={{ color: '#718096', fontSize: '0.8rem' }}>%</span>
              </div>
            </F>
            <F label="Inquiry Date"><input type="date" name="inquiry_date" value={d.inquiry_date} onChange={ch} /></F>
          </div>
          <div className={rc('cols-2')}>
            <F label="Lead Source">
              <select name="lead_source" value={d.lead_source} onChange={ch}>
                {['Sales Call','Cvent','Third-Party Planner','Website','Direct Inquiry','Repeat Client','RFP','Referral'].map(s=><option key={s}>{s}</option>)}
              </select>
            </F>
          </div>
        </Section>

        {/* Cvent RFP details */}
        <Section title="Cvent RFP details" note="Comes straight from the planner's Cvent submission — kept separate from our own Client Priority above since planners rate urgency differently than we do.">
          <div className={rc('cols-4')}>
            <F label="Planner Priority"><select name="client_priority_cvent" value={d.client_priority_cvent} onChange={ch}>{['Low','Medium','High'].map(s=><option key={s}>{s}</option>)}</select></F>
            <F label="Destinations Considered"><input type="number" name="destinations_considered" value={d.destinations_considered} onChange={ch} min="0" /></F>
            <F label="Expected Decision in (Days)"><input type="number" name="decision_days_cvent" value={d.decision_days_cvent} onChange={ch} min="0" placeholder="e.g., 27" /></F>
            <F label="Proposal Due in (Days)"><input type="number" name="response_due_days" value={d.response_due_days} onChange={ch} min="0" placeholder="e.g., 5" /></F>
          </div>
        </Section>

        {/* Meeting requirements */}
        <Section title="Meeting requirements" note="What this group needs beyond guest rooms.">
          {/* Poor ratio warning */}
          {d.has_meeting_space && !!d.meeting_attendees && !!d.room_block && (() => {
            const ratio = parseInt(d.meeting_attendees) / parseInt(d.room_block);
            if (ratio > 3) return (
              <div style={{ marginBottom: '0.65rem', padding: '0.5rem 0.75rem', background: '#fff5f5',
                border: '1px solid #fca5a5', borderRadius: '6px', fontSize: '0.72rem', color: '#991b1b',
                display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                <span>⚠️</span>
                <span>
                  <strong>High attendee-to-room ratio ({ratio.toFixed(1)}:1)</strong> —
                  {parseInt(d.meeting_attendees)} meeting attendees with only {parseInt(d.room_block)} guest rooms
                  may indicate the group needs more meeting space than sleeping rooms.
                  Confirm meeting room capacity before responding.
                </span>
              </div>
            );
            if (ratio > 1.5) return (
              <div style={{ marginBottom: '0.65rem', padding: '0.5rem 0.75rem', background: '#fffbeb',
                border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '0.72rem', color: '#92400e',
                display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                <span>⚡</span>
                <span>
                  <strong>Moderate attendee-to-room ratio ({ratio.toFixed(1)}:1)</strong> —
                  verify meeting room capacity can accommodate {parseInt(d.meeting_attendees)} attendees.
                </span>
              </div>
            );
            return null;
          })()}
          <div className="checks-row">
            <label style={chk}><input type="checkbox" name="has_meeting_space" checked={d.has_meeting_space} onChange={ch} /> Meeting Space</label>
            <label style={chk}><input type="checkbox" name="has_fnb_requirements" checked={d.has_fnb_requirements} onChange={ch} /> F&amp;B Required</label>
            <label style={chk}><input type="checkbox" name="has_evening_session" checked={d.has_evening_session} onChange={ch} /> Evening Session</label>
            <label style={chk}><input type="checkbox" name="has_premium_av" checked={d.has_premium_av} onChange={ch} /> Premium AV</label>
          </div>
          {d.has_meeting_space && (
            <>
              <div className="checks-row">
                <label style={chk}><input type="checkbox" name="has_dinner" checked={d.has_dinner} onChange={ch} /> Dinner</label>
                <label style={chk}><input type="checkbox" name="has_reception" checked={d.has_reception} onChange={ch} /> Reception</label>
              </div>

              {/* Per-day room assignment grid — supports multiple time slots per room per day */}
              {!!d.arrival_date && !!d.departure_date && (() => {
                const active = new Set();
                Object.values(d.room_days || {}).forEach(day => {
                  MEETING_ROOMS.forEach(r => { if (day[r.id + '_active']) active.add(r.label); });
                });
                if (active.size > 0) return (
                  <div style={{ fontSize: '0.72rem', color: '#5b5fc7', marginBottom: '0.4rem', fontWeight: 500 }}>
                    {active.size} room{active.size > 1 ? 's' : ''} selected: {[...active].join(', ')}
                  </div>
                );
                return null;
              })()}
              {!!d.arrival_date && !!d.departure_date && (() => {
                const days = [];
                const start = new Date(d.arrival_date);
                const end   = new Date(d.departure_date);
                for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
                  days.push(dt.toISOString().slice(0, 10));
                }
                if (days.length === 0) return null;

                // Each room/day stores: { slots: [{start, end, note}], _active: bool }
                // Migrate legacy single-slot format { start, end } -> slots array on read
                const getSlots = (dayData, roomId) => {
                  const rd = dayData[roomId] || {};
                  if (Array.isArray(rd.slots)) return rd.slots;
                  if (rd.start || rd.end) return [{ start: rd.start || '8:00', end: rd.end || '17:00', note: rd.note || '' }];
                  return [];
                };

                const setSlots = (day, roomId, slots) => {
                  const dayData = (d.room_days || {})[day] || {};
                  ch({ target: { name: 'room_days', value: {
                    ...(d.room_days || {}),
                    [day]: { ...dayData, [roomId]: { slots }, [`${roomId}_active`]: slots.length > 0 }
                  }}});
                };

                const addSlot = (day, roomId) => {
                  const dayData = (d.room_days || {})[day] || {};
                  const slots = getSlots(dayData, roomId);
                  // Default next slot to start where last one ended, or 8:00
                  const lastEnd = slots.length > 0 ? slots[slots.length - 1].end : null;
                  setSlots(day, roomId, [...slots, { start: lastEnd || '8:00', end: '12:00', note: '' }]);
                };

                const removeSlot = (day, roomId, idx) => {
                  const dayData = (d.room_days || {})[day] || {};
                  const slots = getSlots(dayData, roomId).filter((_, i) => i !== idx);
                  setSlots(day, roomId, slots);
                };

                const updateSlot = (day, roomId, idx, field, value) => {
                  const dayData = (d.room_days || {})[day] || {};
                  const slots = getSlots(dayData, roomId).map((s, i) => i === idx ? { ...s, [field]: value } : s);
                  setSlots(day, roomId, slots);
                };

                const toggleRoom = (day, roomId) => {
                  const dayData = (d.room_days || {})[day] || {};
                  const isActive = !!dayData[`${roomId}_active`];
                  if (isActive) {
                    setSlots(day, roomId, []);
                  } else {
                    setSlots(day, roomId, [{ start: '8:00', end: '17:00', note: '' }]);
                  }
                };

                const slotInp = { fontSize: '0.68rem', padding: '0.12rem 0.22rem', border: '1px solid #cbd5e0', borderRadius: '3px', width: 44, background: '#fff' };
                const noteInp = { fontSize: '0.68rem', padding: '0.12rem 0.22rem', border: '1px solid #e2e8f0', borderRadius: '3px', width: 90, background: '#fff', color: '#6b7280' };

                return (
                  <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: '0.72rem', minWidth: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: '#6b7280', fontWeight: 600, borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>Day</th>
                          {MEETING_ROOMS.map(r => (
                            <th key={r.id}
                              title={`${r.label} · Capacity: ${r.capacity} · ${r.note}`}
                              style={{ textAlign: 'left', padding: '0.3rem 0.75rem', color: '#5b5fc7', fontWeight: 600, borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap', borderLeft: '1px solid #e2e8f0', cursor: 'help' }}>
                              {r.label} <span style={{ fontSize: '0.6rem', color: '#9ca3af' }}>({r.capacity})</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {days.map((day, i) => {
                          const dt = new Date(day + 'T12:00:00');
                          const dayLabel = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                          const dayData = (d.room_days || {})[day] || {};
                          return (
                            <tr key={day} style={{ background: i % 2 === 0 ? '#f9fafb' : '#fff', verticalAlign: 'top' }}>
                              <td style={{ padding: '0.5rem 0.5rem', color: '#374151', whiteSpace: 'nowrap', fontWeight: 500 }}>{dayLabel}</td>
                              {MEETING_ROOMS.map(r => {
                                const slots = getSlots(dayData, r.id);
                                const isActive = !!dayData[`${r.id}_active`];
                                return (
                                  <td key={r.id} style={{ padding: '0.3rem 0.5rem', borderLeft: '1px solid #e2e8f0', verticalAlign: 'top', minWidth: 180 }}>
                                    {/* Toggle checkbox */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: isActive ? '0.3rem' : 0 }}>
                                      <input type="checkbox" checked={isActive}
                                        onChange={() => toggleRoom(day, r.id)}
                                        style={{ width: 13, height: 13, cursor: 'pointer', accentColor: '#5b5fc7', flexShrink: 0 }}
                                      />
                                      {!isActive && <span style={{ fontSize: '0.65rem', color: '#d1d5db' }}>not booked</span>}
                                    </div>
                                    {/* Time slots */}
                                    {isActive && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                        {slots.map((slot, si) => (
                                          <div key={si} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', background: '#eef0ff', borderRadius: 4, padding: '0.15rem 0.3rem' }}>
                                            <input type="text" value={slot.start || ''} placeholder="8:00"
                                              onChange={e => updateSlot(day, r.id, si, 'start', e.target.value)}
                                              style={slotInp}
                                            />
                                            <span style={{ color: '#9ca3af', fontSize: '0.6rem' }}>–</span>
                                            <input type="text" value={slot.end || ''} placeholder="12:00"
                                              onChange={e => updateSlot(day, r.id, si, 'end', e.target.value)}
                                              style={slotInp}
                                            />
                                            <input type="text" value={slot.note || ''} placeholder="note…"
                                              onChange={e => updateSlot(day, r.id, si, 'note', e.target.value)}
                                              style={noteInp}
                                            />
                                            <button type="button" onClick={() => removeSlot(day, r.id, si)}
                                              style={{ fontSize: '0.65rem', color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0.1rem', lineHeight: 1 }}
                                              title="Remove this slot">×</button>
                                          </div>
                                        ))}
                                        {/* Add slot button */}
                                        <button type="button" onClick={() => addSlot(day, r.id)}
                                          style={{ fontSize: '0.62rem', color: '#5b5fc7', background: 'none', border: '1px dashed #c7d2fe',
                                            borderRadius: 3, cursor: 'pointer', padding: '0.1rem 0.35rem', textAlign: 'left', marginTop: '0.05rem' }}>
                                          + add slot
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div style={{ fontSize: '0.65rem', color: '#9ca3af', marginTop: '0.4rem' }}>
                      Check a room to book it · add multiple time slots for split days · add a note per slot
                    </div>
                  </div>
                );
              })()}

              <div className={rc('cols-2')} style={{ marginTop: '1rem' }}>
                <F label="Number of Sessions"><input type="number" name="num_sessions" value={d.num_sessions} onChange={ch} min="0" /></F>
                <F label="Total Meeting Hours"><input type="number" name="total_meeting_hours" value={d.total_meeting_hours} onChange={ch} min="0" /></F>
              </div>
              <div className={rc('cols-2')}>
                <F label="AV Requirement Level">
                  <select name="max_av_level" value={d.max_av_level} onChange={ch}>
                    {AV_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </F>
              </div>

              {d.has_fnb_requirements && (
                <div className={rc('cols-2')}>
                  <F label="F&B Budget">
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <select style={{ flex: '0 0 auto', width: 'auto' }} name="fnb_budget_type" value={d.fnb_budget_type} onChange={ch}>
                        <option value="per_person">$/person</option>
                        <option value="total">$ total</option>
                      </select>
                      <input style={{ flex: 1 }} type="number" name="fnb_budget" value={d.fnb_budget} onChange={ch} min="0" placeholder={d.fnb_budget_type === 'per_person' ? 'e.g., 85' : 'e.g., 12000'} />
                    </div>
                  </F>
                  {!!d.fnb_budget && d.fnb_budget_type === 'per_person' && !!d.attendees && (
                    <F label="Est. F&B Total">
                      <div className="calculated-field" style={{ padding: '0.75rem 1rem', borderRadius: '0.5rem', fontWeight: 600 }}>
                        ${(parseFloat(d.fnb_budget) * parseInt(d.attendees)).toLocaleString()}
                      </div>
                    </F>
                  )}
                </div>
              )}
            </>
          )}
        </Section>

        {/* Room type mix */}
        <Section title="Guest Rooms by Room Type" note="Raw counts from the planner's request — percentages are computed from these, not entered directly.">
          <div className={rc('cols-2')}>
            <F label="Standard Rooms"><input type="number" name="standard_rooms_count" value={d.standard_rooms_count} onChange={ch} min="0" placeholder="e.g., 270" /></F>
            <F label="Premium Rooms"><input type="number" name="premium_rooms_count" value={d.premium_rooms_count} onChange={ch} min="0" placeholder="e.g., 153" /></F>
            <F label="Suites"><input type="number" name="suites_count" value={d.suites_count} onChange={ch} min="0" placeholder="e.g., 27" /></F>
          </div>
        </Section>

        {/* Budget */}
        <Section title="Budget" note="Whatever the planner discloses at inquiry — even a rough number helps the model learn.">
          <div className={rc('cols-2')}>
            <F label="Budget Provided">
              <select name="budget_provided" value={d.budget_provided ? 'yes' : 'no'} onChange={e => ch({ target: { name: 'budget_provided', type: 'checkbox', checked: e.target.value === 'yes' } })}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </F>
            {d.budget_provided && (
              <F label="Budget Amount"><input type="number" name="budget_amount" value={d.budget_amount} onChange={ch} min="0" placeholder="e.g., 38500" /></F>
            )}
          </div>
        </Section>

        {/* Contact */}
        <Section title="Contact">
          <div className={rc('cols-2')}>
            <F label="Name"><input type="text" name="contact_name" value={d.contact_name} onChange={ch} placeholder="John Smith" /></F>
            <F label="Email"><input type="email" name="contact_email" value={d.contact_email} onChange={ch} placeholder="john@example.com" /></F>
            <F label="Phone"><input type="tel" name="contact_phone" value={d.contact_phone} onChange={ch} placeholder="+1-555-0123" /></F>
          </div>
          <F label="Special Requirements" full>
            <textarea name="special_requirements" value={d.special_requirements} onChange={ch} placeholder="Dietary restrictions, accessibility needs, AV requirements (handled by 3rd party)" />
          </F>
        </Section>

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onBack}>Cancel</button>
          <button type="submit" className="btn-primary">
            {isEdit ? 'Save Changes' : 'Create RFP & View Strategies'}
          </button>
        </div>

      </form>
    </div>
  );
};

export default RFPFormView;
