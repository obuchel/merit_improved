import React, { useState, useEffect } from 'react';
import './RFPForm.css';


const MEETING_ROOMS = [
  { id: 'ballroom',        label: 'Ballroom',        capacity: 400, note: 'Large general sessions, receptions, banquets' },
  { id: 'boardroom',       label: 'Boardroom',        capacity: 20,  note: 'Executive meetings, small groups' },
  { id: 'executive_suite', label: 'Executive Suite',  capacity: 12,  note: 'VIP meetings, private dining' },
  { id: 'salon',           label: 'Salon',            capacity: 60,  note: 'Breakout sessions, workshops' },
];
const inp = { width: '100%', padding: '0.45rem 0.6rem', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '0.875rem', boxSizing: 'border-box', background: '#fff' };
const sel = { ...inp, cursor: 'pointer' };
const chk = { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem', cursor: 'pointer', padding: '0.2rem 0' };
const sec = { marginBottom: '1rem', padding: '0.875rem', background: '#f9fafb', borderRadius: '8px', border: '1px solid #f0f0f0' };
const g2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' };
const g3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.6rem' };

const F = ({ label, children, full }) => (
  <div style={full ? { gridColumn: '1 / -1' } : undefined}>
    <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>{label}</label>
    {children}
  </div>
);

const SecTitle = ({ children }) => (
  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#5b5fc7', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.65rem', paddingBottom: '0.35rem', borderBottom: '2px solid #e8e8ff' }}>
    {children}
  </div>
);

const RFPFormView = ({ rfp, onSave, onBack, isEdit = false }) => {
  const [d, setD] = useState({
    event_name: '', event_type: 'Corporate', event_format: 'In-person',
    event_configuration: 'Full Package', organization: '', market_segment: '',
    lead_source: 'Direct Inquiry', arrival_date: '', departure_date: '',
    attendees: '', meeting_attendees: '', room_block: '', client_priority: 'Medium',
    inquiry_date: new Date().toISOString().split('T')[0],
    forecasted_occupancy: 0.75, contact_name: '', contact_email: '',
    contact_phone: '', special_requirements: '', budget_provided: false,
    budget_amount: '', destinations_considered: 2,
    has_meeting_space: true, has_fnb_requirements: true,
    num_meeting_rooms: 1, num_sessions: 2, total_meeting_hours: 8,
    uses_ballroom: false, uses_boardroom: true, max_av_level: 2,
    has_premium_av: false, num_fnb_types: 3, has_dinner: false,
    has_reception: false, has_evening_session: false, full_day_pct: 50,
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
      destinations_considered: parseInt(d.destinations_considered),
      num_sessions:         parseInt(d.num_sessions),
      total_meeting_hours:  parseInt(d.total_meeting_hours),
      max_av_level:         parseInt(d.max_av_level),
      num_fnb_types:        parseInt(d.num_fnb_types),
      full_day_pct:         parseInt(d.full_day_pct),
      num_room_types:       parseInt(d.num_room_types),
      pct_standard_rooms:   parseInt(d.pct_standard_rooms),
      pct_premium_rooms:    parseInt(d.pct_premium_rooms),
      rate_spread:          parseInt(d.rate_spread),
      budget_amount:        d.budget_provided ? parseFloat(d.budget_amount) || 0 : 0,
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
    <div style={{ fontSize: '0.875rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1a202c', margin: 0 }}>{isEdit ? 'Edit RFP' : 'New RFP'}</h2>
        <button type="button" onClick={onBack} style={{ padding: '0.35rem 0.75rem', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#fff', cursor: 'pointer', color: '#6b7280', fontSize: '0.8rem' }}>← Back</button>
      </div>

      <form onSubmit={handleSubmit}>

        {/* Event */}
        <div style={sec}>
          <SecTitle>Event</SecTitle>
          <div style={{ ...g2, marginBottom: '0.6rem' }}>
            <F label="Event Name *" full>
              <input style={inp} type="text" name="event_name" value={d.event_name} onChange={ch} required placeholder="e.g., Annual Tech Conference" />
            </F>
          </div>
          <div style={{ ...g3, marginBottom: '0.6rem' }}>
            <F label="Type"><select style={sel} name="event_type" value={d.event_type} onChange={ch}>{['Corporate','Association','Wedding/Social','SMERF','Tour/Travel'].map(s=><option key={s}>{s}</option>)}</select></F>
            <F label="Format"><select style={sel} name="event_format" value={d.event_format} onChange={ch}>{['In-person','Virtual','Hybrid'].map(s=><option key={s}>{s}</option>)}</select></F>
            <F label="Priority"><select style={sel} name="client_priority" value={d.client_priority} onChange={ch}>{['Low','Medium','High'].map(s=><option key={s}>{s}</option>)}</select></F>
          </div>
          <div style={g2}>
            <F label="Organization"><input style={inp} type="text" name="organization" value={d.organization} onChange={ch} placeholder="e.g., TechCorp Inc" /></F>
            <F label="Market Segment">
              <select style={sel} name="market_segment" value={d.market_segment} onChange={ch}>
                <option value="">Select...</option>
                {['Technology','Healthcare','Finance','Legal','Education','Non-Profit','Government','Real Estate','Professional Services','Trade/Manufacturing','SMERF','Social','Travel','Association','Other'].map(s=><option key={s}>{s}</option>)}
              </select>
            </F>
          </div>
        </div>

        {/* Dates */}
        <div style={sec}>
          <SecTitle>Dates & Rooms</SecTitle>
          <div style={{ ...g3, marginBottom: '0.6rem' }}>
            <F label="Arrival *"><input style={inp} type="date" name="arrival_date" value={d.arrival_date} onChange={ch} required /></F>
            <F label="Departure *"><input style={inp} type="date" name="departure_date" value={d.departure_date} onChange={ch} required /></F>
            <F label="Nights"><input style={{ ...inp, background: '#f3f4f6', color: '#6b7280' }} value={nights || '—'} readOnly /></F>
          </div>
          <div style={{ ...g3, marginBottom: '0.6rem' }}>
            <F label="Attendees *"><input style={inp} type="number" name="attendees" value={d.attendees} onChange={ch} required min="1" placeholder="150" /></F>
            <F label="Mtg Attendees"><input style={inp} type="number" name="meeting_attendees" value={d.meeting_attendees} onChange={ch} min="0" placeholder="120" /></F>
            <F label="Peak Rooms *"><input style={inp} type="number" name="room_block" value={d.room_block} onChange={ch} required min="1" placeholder="80" /></F>
          </div>
          <div style={g3}>
            <F label="Occ. Forecast">
              <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                <input style={{ ...inp, flex: 1 }} type="number" name="forecasted_occupancy"
                  value={Math.round(d.forecasted_occupancy * 100)}
                  onChange={e => ch({ target: { name: 'forecasted_occupancy', value: parseFloat(e.target.value) / 100 || 0 } })}
                  min="0" max="100" />
                <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>%</span>
              </div>
            </F>
            <F label="Inquiry Date"><input style={inp} type="date" name="inquiry_date" value={d.inquiry_date} onChange={ch} /></F>
            <F label="Lead Source">
              <select style={sel} name="lead_source" value={d.lead_source} onChange={ch}>
                {['Sales Call','Cvent','Third-Party Planner','Website','Direct Inquiry','Repeat Client','RFP','Referral'].map(s=><option key={s}>{s}</option>)}
              </select>
            </F>
          </div>
        </div>

        {/* Meeting */}
        <div style={sec}>
          <SecTitle>Meeting Requirements</SecTitle>
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
          <div style={{ display: 'flex', gap: '1.25rem', marginBottom: '0.65rem', flexWrap: 'wrap' }}>
            <label style={chk}><input type="checkbox" name="has_meeting_space" checked={d.has_meeting_space} onChange={ch} /> Meeting Space</label>
            <label style={chk}><input type="checkbox" name="has_fnb_requirements" checked={d.has_fnb_requirements} onChange={ch} /> F&amp;B Required</label>
            <label style={chk}><input type="checkbox" name="has_evening_session" checked={d.has_evening_session} onChange={ch} /> Evening Sessions</label>
          </div>
          {d.has_meeting_space && (
            <>

              <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '0.65rem' }}>
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
              {d.has_fnb_requirements && (
                <div style={{ ...g2, marginTop: '0.6rem' }}>
                  <F label="F&B Budget">
                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                      <select style={{ ...sel, flex: '0 0 auto', width: 'auto' }} name="fnb_budget_type" value={d.fnb_budget_type} onChange={ch}>
                        <option value="per_person">$/person</option>
                        <option value="total">$ total</option>
                      </select>
                      <input style={{ ...inp, flex: 1 }} type="number" name="fnb_budget" value={d.fnb_budget} onChange={ch} min="0" placeholder={d.fnb_budget_type === 'per_person' ? 'e.g., 85' : 'e.g., 12000'} />
                    </div>
                  </F>
                  {!!d.fnb_budget && d.fnb_budget_type === 'per_person' && !!d.attendees && (
                    <F label="Est. F&B Total">
                      <div style={{ ...inp, background: '#f3f4f6', color: '#374151', fontWeight: 600 }}>
                        ${(parseFloat(d.fnb_budget) * parseInt(d.attendees)).toLocaleString()}
                      </div>
                    </F>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Contact */}
        <div style={sec}>
          <SecTitle>Contact</SecTitle>
          <div style={{ ...g3, marginBottom: '0.6rem' }}>
            <F label="Name"><input style={inp} type="text" name="contact_name" value={d.contact_name} onChange={ch} placeholder="John Smith" /></F>
            <F label="Email"><input style={inp} type="email" name="contact_email" value={d.contact_email} onChange={ch} placeholder="john@example.com" /></F>
            <F label="Phone"><input style={inp} type="tel" name="contact_phone" value={d.contact_phone} onChange={ch} placeholder="+1-555-0123" /></F>
          </div>
          <F label="Special Requirements">
            <textarea style={{ ...inp, height: '60px', resize: 'vertical' }} name="special_requirements" value={d.special_requirements} onChange={ch} placeholder="Dietary restrictions, accessibility needs, AV requirements (handled by 3rd party)" />
          </F>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onBack} style={{ padding: '0.5rem 1rem', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#fff', cursor: 'pointer', color: '#6b7280' }}>Cancel</button>
          <button type="submit" style={{ padding: '0.5rem 1.25rem', background: '#5b5fc7', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}>
            {isEdit ? 'Save Changes' : 'Create RFP & View Strategies'}
          </button>
        </div>

      </form>
    </div>
  );
};

export default RFPFormView;
