import React, { useState, useEffect } from 'react';
import { Plus, FileText, LogOut, TrendingUp } from 'lucide-react';
import { db } from './firebase';
import { collection, addDoc, updateDoc, setDoc, deleteDoc, doc, onSnapshot, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { seedBookedEvents } from './seedBookedEvents';
import RFPFormView      from './components/RFPFormView';
import StrategiesView   from './components/StrategiesView';
import LoginView        from './components/LoginView';
import RankingView      from './components/RankingView';
import CalendarView     from './components/CalendarView';
import TrendsView      from './components/TrendsView';
import FloorPlanView   from './components/FloorPlanView';
import './App.css';


class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: '2rem', fontFamily: 'monospace', color: '#991b1b' }}>
        <h2>Something went wrong</h2>
        <pre style={{ background: '#fff5f5', padding: '1rem', borderRadius: '8px', overflow: 'auto', fontSize: '0.75rem' }}>
          {this.state.error?.message}
          {'\n'}
          {this.state.error?.stack}
        </pre>
        <button onClick={() => this.setState({ error: null })} style={{ marginTop: '1rem', padding: '0.5rem 1rem', background: '#5b5fc7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
          Try again
        </button>
      </div>
    );
    return this.props.children;
  }
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => sessionStorage.getItem('rfp_auth') === 'true'
  );
  const [currentView, setCurrentView] = useState('ranking');
  const [rfpList, setRfpList]         = useState([]);
  const [selectedRfp, setSelectedRfp] = useState(null);
  const [calendarGate, setCalendarGate] = useState(null);
  const [savedToast, setSavedToast] = useState(false);
  const [seeded, setSeeded] = useState(() => localStorage.getItem('merit_seeded') === 'true');

  useEffect(() => {
    if (!isAuthenticated) return;
    // Listen to BOTH collections — incoming_rfps holds seeded/imported RFPs,
    // rfps holds user-created ones. Merge and deduplicate (rfps wins on id clash).
    let mainDocs = [];
    let incomingDocs = [];
    const merge = () => {
      const seen = new Set();
      const merged = [...mainDocs, ...incomingDocs].filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      setRfpList(merged.sort((a, b) => (b.created_at?.toMillis?.() ?? 0) - (a.created_at?.toMillis?.() ?? 0)));
    };
    const u1 = onSnapshot(collection(db, 'rfps'), snap => {
      mainDocs = snap.docs.map(d => ({ id: d.id, _col: 'rfps', ...d.data() }));
      merge();
    });
    const u2 = onSnapshot(collection(db, 'incoming_rfps'), snap => {
      incomingDocs = snap.docs.map(d => ({ id: d.id, _col: 'incoming_rfps', ...d.data() }));
      merge();
    });
    return () => { u1(); u2(); };
  }, [isAuthenticated]);

  // Normalize RFP fields — handles both incoming_rfps (PascalCase, Timestamps) and rfps (camelCase, strings)
  const normalizeRfp = (rfp) => {
    const toDateStr = (v) => {
      if (!v) return '';
      if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0,10);
      if (v instanceof Date) return v.toISOString().slice(0,10);
      return String(v).slice(0,10);
    };
    return {
      ...rfp,
      event_name:           rfp.event_name || rfp.Account_Name || rfp.account_name || '',
      organization:         rfp.organization || rfp.Account_Name || '',
      event_type:           rfp.event_type || rfp.Event_Type || 'Corporate',
      market_segment:       rfp.market_segment || rfp.Market_Segment || '',
      arrival_date:         toDateStr(rfp.arrival_date || rfp.Arrival_Date),
      departure_date:       toDateStr(rfp.departure_date || rfp.Departure_Date),
      attendees:            rfp.attendees || rfp.Attendees || '',
      room_block:           rfp.room_block || rfp.Peak_Room_Block || '',
      forecasted_occupancy: rfp.forecasted_occupancy || rfp.Forecasted_Occupancy || 0.72,
      inquiry_date:         toDateStr(rfp.inquiry_date || rfp.Inquiry_Date) || '',
      contact_name:         rfp.contact_name || rfp.Contact_Name || '',
      contact_email:        rfp.contact_email || rfp.Contact_Email || '',
      contact_phone:        rfp.contact_phone || rfp.Contact_Phone || '',
      client_priority:      rfp.client_priority || rfp.Client_Priority || 'Medium',
      has_meeting_space:    !!(rfp.has_meeting_space || rfp.Has_Meeting_Space || rfp.uses_ballroom || rfp.Uses_Ballroom || rfp.uses_boardroom || rfp.Uses_Boardroom),
      uses_ballroom:        !!(rfp.uses_ballroom || rfp.Uses_Ballroom),
      uses_boardroom:       !!(rfp.uses_boardroom || rfp.Uses_Boardroom),
      num_meeting_rooms:    Number(rfp.num_meeting_rooms || rfp.Num_Meeting_Rooms || 1),
      special_requirements: rfp.special_requirements || rfp.Special_Requirements || '',
      status:               rfp.status || rfp.Status || 'pending',
    };
  };

  const handleLogin  = () => {
    setIsAuthenticated(true);
    // Auto-seed calendar data only if booked_events is empty
    if (!localStorage.getItem('merit_seeded')) {
      setTimeout(async () => {
        try {
          const { getDocs, collection } = await import('firebase/firestore');
          const snap = await getDocs(collection(db, 'booked_events'));
          if (snap.empty) {
            const n = await seedBookedEvents(db);
            console.log(`[seed] ${n} events added`);
          }
          localStorage.setItem('merit_seeded', 'true');
          setSeeded(true);
        } catch(e) { console.warn('Seed check failed:', e); }
      }, 1000);
    }
  };
  const handleLogout = () => {
    sessionStorage.removeItem('rfp_auth');
    setIsAuthenticated(false);
    setCurrentView('ranking');
    setSelectedRfp(null);
    setRfpList([]);
  };

  if (!isAuthenticated) return <LoginView onLogin={handleLogin} />;


  const handleNewRfp       = () => { setSelectedRfp(null); setCurrentView('new-rfp'); };
  const handleEditRfp      = (rfp) => { setSelectedRfp(normalizeRfp(rfp)); setCurrentView('edit-rfp'); };
  const handleViewStrategies = (rfp) => { setSelectedRfp(normalizeRfp(rfp)); setCurrentView('strategies'); };

  const handleSaveRfp = async (rfpData, isEdit = false) => {
    try {
      let savedRfp;
      if (isEdit && selectedRfp?.id) {
        // Strip internal React/app-only fields before writing to Firestore
        const { _col: _colFromData, ...firestoreData } = rfpData;
        // Sanitize: strip non-serializable values (Timestamps, undefined, functions)
        // that would cause Firestore writes to fail.
        const sanitize = (obj) => {
          const out = {};
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined || typeof v === 'function') continue;
            // Convert Firestore Timestamps to ISO date strings
            if (v && typeof v.toDate === 'function') { out[k] = v.toDate().toISOString().slice(0,10); continue; }
            // Convert Date objects
            if (v instanceof Date) { out[k] = v.toISOString().slice(0,10); continue; }
            // Keep plain objects (but not class instances other than above)
            if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) continue;
            out[k] = v;
          }
          return out;
        };
        const cleanData = sanitize(firestoreData);

        // Write back to whichever collection this doc came from.
        // Use setDoc+merge so it works even if the doc is missing.
        const srcCol = selectedRfp._col || _colFromData || 'incoming_rfps';
        await setDoc(doc(db, srcCol, selectedRfp.id), {
          ...cleanData, updated_at: serverTimestamp()
        }, { merge: true });
        savedRfp = { ...selectedRfp, ...cleanData, _col: srcCol };

        setSelectedRfp(savedRfp);
        setSavedToast(true);
        setTimeout(() => {
          setSavedToast(false);
          setSelectedRfp(null);
          setCurrentView('ranking');
        }, 1500);
        return;
      } else {
        const docRef = await addDoc(collection(db, 'rfps'), {
          ...rfpData, status: 'pending',
          created_at: serverTimestamp(), updated_at: serverTimestamp()
        });
        savedRfp = { id: docRef.id, ...rfpData };
        setSelectedRfp(savedRfp);
      }
      // Calendar gate: check occupancy on arrival date before showing strategies
      try {
        const TOTAL_ROOMS = 220;
        const arr = rfpData.arrival_date;
        const dep = rfpData.departure_date;
        const bookedSnap = await getDocs(collection(db, 'booked_events'));
        const booked = bookedSnap.docs.map(d => d.data());
        let maxRooms = 0;
        booked.forEach(ev => {
          const a = ev.Arrival_Date || ev.arrival_date;
          const d = ev.Departure_Date || ev.departure_date;
          if (a && d && a <= dep && d >= arr) {
            maxRooms += Number(ev.Peak_Room_Block || ev.room_block || 0);
          }
        });
        const occPct = Math.round((maxRooms / TOTAL_ROOMS) * 100);
        setCalendarGate({ rfp: savedRfp, occPct, maxRooms, totalRooms: TOTAL_ROOMS });
      } catch {
        // If calendar check fails, proceed directly
        setCurrentView('strategies');
      }
    } catch (e) {
      console.error('Error saving RFP:', e);
      alert('Failed to save RFP.\n\nError: ' + (e?.message || String(e)));
    }
  };

  const handleStatusChange = async (rfpId, newStatus, collectionName = 'rfps') => {
    try {
      await updateDoc(doc(db, collectionName, rfpId), {
        status: newStatus, Status: newStatus, updated_at: serverTimestamp()
      });
    } catch (e) {
      console.error('Error updating status:', e);
    }
  };

  const handleDeleteRfp = async (rfpId, collectionName = 'rfps') => {
    try {
      await deleteDoc(doc(db, collectionName, rfpId));
      if (selectedRfp?.id === rfpId) {
        setSelectedRfp(null);
        setCurrentView('ranking');
      }
    } catch (e) {
      console.error('Error deleting RFP:', e);
      alert('Failed to delete RFP. Please try again.');
    }
  };

  const handleSeedCalendar = async () => {
    if (seeded) return;
    try {
      const n = await seedBookedEvents(db);
      alert(`✅ Seeded ${n} booked events. The calendar will update now.`);
      localStorage.setItem('merit_seeded', 'true');
      setSeeded(true);
    } catch(e) {
      console.error('Seed failed:', e);
      alert('Seed failed: ' + e.message);
    }
  };

  const loadSampleData = async () => {
    const sampleRfps = [
      {
        event_name: 'Tech Summit 2026', event_type: 'Corporate',
        organization: 'TechCorp Inc', market_segment: 'Technology',
        arrival_date: '2026-03-15', departure_date: '2026-03-18',
        attendees: 250, room_block: 120, client_priority: 'High',
        contact_name: 'Sarah Johnson', contact_email: 'sarah.j@techcorp.com',
        contact_phone: '+1-555-0123', special_requirements: 'AV, internet',
        forecasted_occupancy: 0.75, inquiry_date: '2026-02-01'
      },
      {
        event_name: 'Medical Conference', event_type: 'Association',
        organization: 'Medical Professionals Assoc', market_segment: 'Healthcare',
        arrival_date: '2026-04-20', departure_date: '2026-04-23',
        attendees: 180, room_block: 90, client_priority: 'Medium',
        contact_name: 'Dr. Michael Chen', contact_email: 'mchen@medassoc.org',
        contact_phone: '+1-555-0456', special_requirements: 'Breakout rooms',
        forecasted_occupancy: 0.65, inquiry_date: '2026-03-10'
      }
    ];
    try {
      for (const rfp of sampleRfps) {
        await addDoc(collection(db, 'rfps'), {
          ...rfp, status: 'pending',
          created_at: serverTimestamp(), updated_at: serverTimestamp()
        });
      }
    } catch (e) { console.error(e); }
  };

  const NAV_ITEMS = [
    { id: 'ranking',   label: 'Dashboard', icon: TrendingUp },
    { id: 'trends',    label: 'Trends' },
    { id: 'calendar',  label: 'Calendar' },
    { id: 'floorplan', label: 'Floor Plan' },
  ];

  return (
    <ErrorBoundary>
    <div className="app">
      <header className="header">
        <div className="header-left">
          <FileText size={32} color="#5b5fc7" />
          <div>
            <h1>MERIT</h1>
            <p className="subtitle">The MERIT Hotel &amp; Conference Center</p>
          </div>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={currentView === item.id ? 'active' : ''}
              onClick={() => { setSelectedRfp(null); setCurrentView(item.id); }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
            >
              {item.icon && <item.icon size={14} />}
              {item.label}

            </button>
          ))}
        </nav>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn-primary" onClick={handleNewRfp}>
            <Plus size={20} /> New RFP
          </button>

          <button
            onClick={handleLogout}
            title="Sign out"
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.5rem 0.9rem', background: 'transparent',
              border: '1px solid rgba(0,0,0,0.15)', borderRadius: '8px',
              cursor: 'pointer', color: '#718096', fontSize: '0.875rem',
              fontWeight: 500, transition: 'all 0.15s'
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#fff0f0'; e.currentTarget.style.color = '#e53e3e'; e.currentTarget.style.borderColor = '#e53e3e'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#718096'; e.currentTarget.style.borderColor = 'rgba(0,0,0,0.15)'; }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </header>

      <main className="main-content">
        {currentView === 'ranking' && (
          <RankingView
            onViewStrategies={handleViewStrategies}
            onEditRfp={handleEditRfp}
            onDeleteRfp={handleDeleteRfp}
            onNewRfp={handleNewRfp}
            onStatusChange={handleStatusChange}
          />
        )}

        {currentView === 'trends' && <TrendsView />}

        {currentView === 'calendar' && (
          <CalendarView onViewStrategies={handleViewStrategies} />
        )}

        {currentView === 'floorplan' && <FloorPlanView />}

        {currentView === 'new-rfp' && (
          <RFPFormView
            rfp={null}
            onSave={handleSaveRfp}
            onBack={() => { setSelectedRfp(null); setCurrentView('ranking'); }}
            isEdit={false}
          />
        )}

        {currentView === 'edit-rfp' && selectedRfp && (
          <div style={{ display: 'flex', gap: '0', alignItems: 'flex-start', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>
            {/* Left: RFP Form — fixed width, independently scrollable */}
            <div style={{ flex: '0 0 500px', height: '100%', overflowY: 'auto', borderRight: '1px solid #e2e8f0', padding: '1.5rem 1.5rem 4rem' }}>
              <RFPFormView
                rfp={selectedRfp}
                onSave={handleSaveRfp}
                onBack={() => { setSelectedRfp(null); setCurrentView('ranking'); }}
                isEdit={true}
                compact={true}
              />
            </div>
            {/* Right: Strategies — fills remaining space, independently scrollable */}
            <div style={{ flex: 1, height: '100%', overflowY: 'auto', padding: '1.5rem 1.5rem 4rem' }}>
              <StrategiesView
                rfp={selectedRfp}
                onBack={() => { setSelectedRfp(null); setCurrentView('ranking'); }}
                onEdit={handleEditRfp}
                onRfpChange={setSelectedRfp}
                inEditMode={true}
              />
            </div>
          </div>
        )}

        {currentView === 'strategies' && selectedRfp && (
          <StrategiesView
            rfp={selectedRfp}
            onBack={() => setCurrentView('edit-rfp')}
            onEdit={handleEditRfp}
            onRfpChange={setSelectedRfp}
          />
        )}
      </main>

      {/* ── Saved Toast ── */}
      {savedToast && (
        <div style={{ position: 'fixed', bottom: '2rem', left: '50%', transform: 'translateX(-50%)',
          background: '#166534', color: '#fff', padding: '0.75rem 1.5rem', borderRadius: '8px',
          fontSize: '0.875rem', fontWeight: 500, zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          ✓ Changes saved — returning to Dashboard…
        </div>
      )}

      {/* ── Calendar Gate Modal ── */}
      {calendarGate && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            background: '#fff', borderRadius: '1rem', padding: '2rem', maxWidth: 420, width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)'
          }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.2rem', fontWeight: 700 }}>
              📅 Calendar Check
            </h3>
            <p style={{ color: '#4a5568', margin: '0 0 1rem', fontSize: '0.9rem' }}>
              Before generating strategies for <strong>{calendarGate.rfp.event_name}</strong>,
              here's the occupancy picture for those dates:
            </p>
            <div style={{
              background: calendarGate.occPct >= 85 ? '#fff5f5' : calendarGate.occPct >= 60 ? '#fffbeb' : '#f0fff4',
              border: `1px solid ${calendarGate.occPct >= 85 ? '#fc8181' : calendarGate.occPct >= 60 ? '#f6ad55' : '#68d391'}`,
              borderRadius: '0.5rem', padding: '1rem', marginBottom: '1.25rem'
            }}>
              <div style={{ fontSize: '2rem', fontWeight: 800, color: calendarGate.occPct >= 85 ? '#e53e3e' : calendarGate.occPct >= 60 ? '#c05621' : '#276749' }}>
                {calendarGate.occPct}% committed
              </div>
              <div style={{ fontSize: '0.8rem', color: '#718096', marginTop: '0.25rem' }}>
                {calendarGate.maxRooms} of {calendarGate.totalRooms} rooms already booked on arrival date
              </div>
              <div style={{ fontSize: '0.85rem', marginTop: '0.5rem', fontWeight: 500,
                color: calendarGate.occPct >= 85 ? '#e53e3e' : calendarGate.occPct >= 60 ? '#c05621' : '#276749' }}>
                {calendarGate.occPct >= 85
                  ? '⚠ High compression — displacement cost will be significant. Consider a premium rate.'
                  : calendarGate.occPct >= 60
                  ? 'Moderate demand — good candidate for group business at standard rates.'
                  : '✓ Low occupancy — strong incentive to fill with group business.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => { setCalendarGate(null); setCurrentView('calendar'); }}
                style={{ flex: 1, padding: '0.75rem', border: '1px solid #e2e8f0', borderRadius: '0.5rem',
                  background: '#fff', cursor: 'pointer', fontWeight: 500, color: '#4a5568' }}
              >
                View Calendar
              </button>
              <button
                onClick={() => { setCalendarGate(null); setCurrentView('strategies'); }}
                style={{ flex: 1, padding: '0.75rem', border: 'none', borderRadius: '0.5rem',
                  background: '#5b5fc7', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
              >
                Continue to Strategies →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}

export default App;
