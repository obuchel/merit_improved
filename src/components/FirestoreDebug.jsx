// TEMPORARY DEBUG COMPONENT
// 1. Import and render this anywhere in your app (e.g. replace CalendarView temporarily)
// 2. It shows every doc in both rfps + incoming_rfps
// 3. Use the "Migrate to rfps & delete original" button on any incoming_rfps doc
// 4. Remove this component when done

import React, { useEffect, useState } from 'react';
import { db } from '../firebase';
import { collection, getDocs, addDoc, deleteDoc, doc, updateDoc, serverTimestamp } from 'firebase/firestore';

export default function FirestoreDebug() {
  const [rfpsDocs, setRfpsDocs] = useState([]);
  const [incomingDocs, setIncomingDocs] = useState([]);
  const [log, setLog] = useState([]);

  const addLog = (msg) => setLog(l => [msg, ...l]);

  const load = async () => {
    const r = await getDocs(collection(db, 'rfps'));
    const i = await getDocs(collection(db, 'incoming_rfps'));
    setRfpsDocs(r.docs.map(d => ({ id: d.id, ...d.data() })));
    setIncomingDocs(i.docs.map(d => ({ id: d.id, ...d.data() })));
    addLog(`Loaded: ${r.size} rfps, ${i.size} incoming_rfps`);
  };

  useEffect(() => { load(); }, []);

  const sanitize = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || typeof v === 'function') continue;
      if (v && typeof v.toDate === 'function') { out[k] = v.toDate().toISOString().slice(0,10); continue; }
      if (v instanceof Date) { out[k] = v.toISOString().slice(0,10); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) continue;
      out[k] = v;
    }
    return out;
  };

  const migrate = async (rfp) => {
    const { id, _col, ...data } = rfp;
    const cleanData = sanitize(data);
    try {
      const ref = await addDoc(collection(db, 'rfps'), {
        ...cleanData,
        incoming_rfp_id: id,
        updated_at: serverTimestamp(),
        created_at: serverTimestamp(),
      });
      addLog(`✓ Added to rfps: ${ref.id}`);
      await deleteDoc(doc(db, 'incoming_rfps', id));
      addLog(`✓ Deleted from incoming_rfps: ${id}`);
      await load();
    } catch(e) {
      addLog(`✗ Error: ${e.message}`);
    }
  };

  const updateField = async (col, id, field, value) => {
    try {
      await updateDoc(doc(db, col, id), { [field]: value, updated_at: serverTimestamp() });
      addLog(`✓ Updated ${col}/${id} ${field}=${value}`);
      await load();
    } catch(e) {
      addLog(`✗ ${e.message}`);
    }
  };

  const row = (rfp, col) => (
    <tr key={rfp.id} style={{ borderBottom: '1px solid #e2e8f0', fontSize: '0.8rem' }}>
      <td style={{ padding: '0.5rem', fontWeight: 600, maxWidth: 180 }}>
        {rfp.event_name || rfp.Account_Name || rfp.account_name || '—'}
        <div style={{ fontSize: '0.65rem', color: '#999' }}>{rfp.id.slice(0,12)}…</div>
      </td>
      <td style={{ padding: '0.5rem' }}>{rfp.arrival_date || rfp.Arrival_Date || '—'}</td>
      <td style={{ padding: '0.5rem' }}>{rfp.departure_date || rfp.Departure_Date || '—'}</td>
      <td style={{ padding: '0.5rem' }}>{rfp.inquiry_date || rfp.Inquiry_Date || '—'}</td>
      <td style={{ padding: '0.5rem' }}>{rfp.status || rfp.Status || '—'}</td>
      <td style={{ padding: '0.5rem' }}>
        {col === 'incoming_rfps' && (
          <button onClick={() => migrate(rfp)}
            style={{ padding: '0.25rem 0.5rem', background: '#5b5fc7', color: '#fff',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.7rem', marginBottom: 4, display: 'block' }}>
            → Migrate to rfps
          </button>
        )}
        <button onClick={() => {
          const val = prompt(`New arrival_date for "${rfp.event_name || rfp.Account_Name}"`, rfp.arrival_date || rfp.Arrival_Date || '');
          if (val) updateField(col, rfp.id, 'arrival_date', val);
        }} style={{ padding: '0.25rem 0.5rem', background: '#fff', border: '1px solid #e2e8f0',
          borderRadius: 4, cursor: 'pointer', fontSize: '0.7rem', display: 'block', marginBottom: 4 }}>
          Edit arrival
        </button>
        <button onClick={() => {
          if (window.confirm(`Delete "${rfp.event_name || rfp.Account_Name}" from ${col}?`))
            deleteDoc(doc(db, col, rfp.id)).then(() => { addLog(`Deleted ${col}/${rfp.id}`); load(); });
        }} style={{ padding: '0.25rem 0.5rem', background: '#fff', border: '1px solid #fca5a5',
          borderRadius: 4, cursor: 'pointer', fontSize: '0.7rem', color: '#dc2626', display: 'block' }}>
          Delete
        </button>
      </td>
    </tr>
  );

  const tbl = (docs, col, color) => (
    <div style={{ marginBottom: '2rem' }}>
      <h3 style={{ color, marginBottom: '0.5rem' }}>{col} ({docs.length} docs)</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.1)' }}>
          <thead>
            <tr style={{ background: color, color: '#fff', fontSize: '0.75rem' }}>
              {['Name / ID','Arrival','Departure','Inquiry','Status','Actions'].map(h =>
                <th key={h} style={{ padding: '0.5rem', textAlign: 'left' }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>{docs.map(d => row(d, col))}</tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <h2 style={{ margin: 0 }}>🔧 Firestore Debug</h2>
        <button onClick={load} style={{ padding: '0.4rem 0.9rem', background: '#5b5fc7', color: '#fff',
          border: 'none', borderRadius: 6, cursor: 'pointer' }}>↺ Refresh</button>
      </div>

      {tbl(rfpsDocs, 'rfps', '#2d3748')}
      {tbl(incomingDocs, 'incoming_rfps', '#c05621')}

      <div style={{ marginTop: '1rem' }}>
        <h4>Log</h4>
        <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', background: '#1a202c', color: '#68d391',
          padding: '1rem', borderRadius: 8, maxHeight: 200, overflowY: 'auto' }}>
          {log.length === 0 ? 'No actions yet' : log.map((l,i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}
