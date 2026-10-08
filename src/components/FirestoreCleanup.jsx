// ONE-TIME CLEANUP — drop this component in temporarily
// It finds duplicate RFPs across both collections and lets you delete the stale ones

import React, { useEffect, useState } from 'react';
import { db } from '../firebase';
import { collection, getDocs, deleteDoc, doc } from 'firebase/firestore';

export default function FirestoreCleanup() {
  const [rfpsDocs, setRfpsDocs]       = useState([]);
  const [incomingDocs, setIncomingDocs] = useState([]);
  const [log, setLog] = useState([]);

  const addLog = msg => setLog(l => [msg, ...l]);

  const load = async () => {
    const r = await getDocs(collection(db, 'rfps'));
    const i = await getDocs(collection(db, 'incoming_rfps'));
    setRfpsDocs(r.docs.map(d => ({ id: d.id, _col: 'rfps', ...d.data() })));
    setIncomingDocs(i.docs.map(d => ({ id: d.id, _col: 'incoming_rfps', ...d.data() })));
    addLog(`Loaded ${r.size} rfps + ${i.size} incoming_rfps`);
  };

  useEffect(() => { load(); }, []);

  const del = async (col, id, label) => {
    if (!window.confirm(`Delete "${label}" from ${col}?`)) return;
    await deleteDoc(doc(db, col, id));
    addLog(`✓ Deleted ${col}/${id}`);
    load();
  };

  const getName = r => r.event_name || r.Account_Name || r.account_name || '—';
  const getArrival = r => r.arrival_date || (r.Arrival_Date?.toDate?.()?.toISOString?.().slice(0,10)) || r.Arrival_Date || '—';

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui', maxWidth: 900 }}>
      <div style={{ display:'flex', gap:'1rem', alignItems:'center', marginBottom:'1.5rem' }}>
        <h2 style={{ margin:0 }}>🧹 Firestore Cleanup</h2>
        <button onClick={load} style={{ padding:'0.4rem 0.9rem', background:'#5b5fc7', color:'#fff', border:'none', borderRadius:6, cursor:'pointer' }}>↺ Refresh</button>
      </div>

      {[['incoming_rfps (stale — delete these after migrating)', incomingDocs, '#c05621'],
        ['rfps (canonical)', rfpsDocs, '#2d3748']].map(([title, docs, color]) => (
        <div key={title} style={{ marginBottom:'2rem' }}>
          <h3 style={{ color, marginBottom:'0.5rem' }}>{title} — {docs.length} docs</h3>
          <table style={{ borderCollapse:'collapse', width:'100%', fontSize:'0.8rem' }}>
            <thead>
              <tr style={{ background:color, color:'#fff' }}>
                {['Name','ID','Arrival','Action'].map(h =>
                  <th key={h} style={{ padding:'0.4rem 0.6rem', textAlign:'left' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {docs.map(r => (
                <tr key={r.id} style={{ borderBottom:'1px solid #e2e8f0' }}>
                  <td style={{ padding:'0.4rem 0.6rem', fontWeight:600 }}>{getName(r)}</td>
                  <td style={{ padding:'0.4rem 0.6rem', fontFamily:'monospace', fontSize:'0.7rem', color:'#999' }}>{r.id}</td>
                  <td style={{ padding:'0.4rem 0.6rem' }}>{getArrival(r)}</td>
                  <td style={{ padding:'0.4rem 0.6rem' }}>
                    <button onClick={() => del(r._col, r.id, getName(r))}
                      style={{ padding:'0.2rem 0.5rem', background:'#fee2e2', color:'#dc2626',
                        border:'1px solid #fca5a5', borderRadius:4, cursor:'pointer', fontSize:'0.7rem' }}>
                      🗑 Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div style={{ fontFamily:'monospace', fontSize:'0.75rem', background:'#1a202c', color:'#68d391',
        padding:'1rem', borderRadius:8, maxHeight:150, overflowY:'auto' }}>
        {log.length === 0 ? 'No actions yet' : log.map((l,i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
