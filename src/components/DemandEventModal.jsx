import React, { useState } from 'react';
import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

const inp = { width: '100%', padding: '0.45rem 0.6rem', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '0.875rem', boxSizing: 'border-box', background: '#fff' };
const sel = { ...inp, cursor: 'pointer' };

const IMPACT_COLORS = { Low: '#3b82f6', Medium: '#f59e0b', High: '#f97316', Critical: '#ef4444' };
const IMPACT_NOTES = {
  Low:      'Some additional transient demand — minor rate opportunity',
  Medium:   'Meaningful compression — recommend +10–15% ADR premium on overlapping RFPs',
  High:     'Heavy compression — recommend Premium pricing, strict displacement policy',
  Critical: 'City fully compressed — decline low-value groups, maximize ADR',
};

export default function DemandEventModal({ onClose, onSaved, defaultDate }) {
  const [d, setD] = useState({
    name: '', type: 'Citywide', start_date: defaultDate || '', end_date: defaultDate || '',
    attendance_size: 'Medium', impact: 'Medium', notes: '',
  });
  const [saving, setSaving] = useState(false);

  const ch = e => setD(prev => ({ ...prev, [e.target.name]: e.target.value }));

  const handleSave = async () => {
    if (!d.name || !d.start_date || !d.end_date) { alert('Name and dates are required'); return; }
    setSaving(true);
    try {
      await addDoc(collection(db, 'demand_events'), { ...d, created_at: serverTimestamp() });
      onSaved();
    } catch(e) { console.error(e); alert('Failed to save'); }
    setSaving(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: '12px', padding: '1.5rem', width: 460, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Add External Demand Event</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '1.2rem', color: '#6b7280' }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div>
            <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>Event Name *</label>
            <input style={inp} name="name" value={d.name} onChange={ch} placeholder="e.g., Ohio State Football vs Michigan" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>Type</label>
              <select style={sel} name="type" value={d.type} onChange={ch}>
                {['Citywide','Sports','Festival/Concert','Corporate Campus','Conference','Other'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>Expected Attendance</label>
              <select style={sel} name="attendance_size" value={d.attendance_size} onChange={ch}>
                {['Small (<5K)','Medium (5–20K)','Large (20–50K)','Mega (50K+)'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>Start Date *</label>
              <input style={inp} type="date" name="start_date" value={d.start_date} onChange={ch} />
            </div>
            <div>
              <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>End Date *</label>
              <input style={inp} type="date" name="end_date" value={d.end_date} onChange={ch} />
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>Impact on Hotel Demand</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.4rem' }}>
              {['Low','Medium','High','Critical'].map(imp => (
                <button key={imp} type="button" onClick={() => setD(prev => ({ ...prev, impact: imp }))}
                  style={{ padding: '0.4rem 0', borderRadius: '6px', border: `2px solid ${d.impact === imp ? IMPACT_COLORS[imp] : '#e2e8f0'}`,
                    background: d.impact === imp ? IMPACT_COLORS[imp] + '18' : '#fff',
                    color: d.impact === imp ? IMPACT_COLORS[imp] : '#6b7280',
                    fontWeight: d.impact === imp ? 700 : 400, cursor: 'pointer', fontSize: '0.78rem' }}>
                  {imp}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '0.68rem', color: IMPACT_COLORS[d.impact], marginTop: '0.35rem', fontStyle: 'italic' }}>
              {IMPACT_NOTES[d.impact]}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.25rem' }}>Notes</label>
            <textarea style={{ ...inp, height: 64, resize: 'vertical' }} name="notes" value={d.notes} onChange={ch}
              placeholder="e.g., Annual transit expo at convention center, fills downtown hotels, peak transient rates +30%" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button onClick={onClose} style={{ padding: '0.5rem 1rem', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#fff', cursor: 'pointer', color: '#6b7280' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '0.5rem 1.25rem', background: '#5b5fc7', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}>
            {saving ? 'Saving…' : 'Add Event'}
          </button>
        </div>
      </div>
    </div>
  );
}
