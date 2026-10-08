import React from 'react';
import InfoTip from './InfoTip';

// ─── DISPLACEMENT BY NIGHT + KEY FACTORS ────────────────────────────────────
// One bar per stay night, drawn to the hotel's room count: other groups already
// booked, transient demand that still fits, this group's block, and the
// over-capacity part (the transient rooms this block displaces). Numbers are the
// expected values from computeDisplacement() (p10/p50/p90 weighted), not a single forecast.
const DISP_COLORS = { committed: '#d9d5c7', transient: '#8aa4bd', block: '#2d5a85', over: '#b5541f' };
const fmtNight = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function DisplacementByNight({ disp, block, totalRooms }) {
  const nights = disp?.perNight || [];
  if (!nights.length) return null;
  return (
    <div className="disp-card" style={{ background: '#fff', border: '1px solid #e7e4da', borderRadius: 16, padding: '1.25rem 1.5rem', marginTop: '1rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.0625rem', marginBottom: '0.9rem' }}>Displacement by night<InfoTip title="How displacement is calculated">Each bar is one night, drawn to the hotel's 220 rooms: other groups already booked, transient demand that still fits, this group's block, and the orange over-capacity part. Per night, displaced rooms = the smaller of the block, the transient demand, and (block + demand − rooms left after other groups), averaged over low, median and high demand (0.3 / 0.4 / 0.3). Cost = displaced rooms × that night's transient rate. Demand comes from the transient forecast built from 2023–25 history.</InfoTip></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '1.25rem 1.5rem' }}>
        {nights.map(n => {
          const committed = Math.min(totalRooms, n.committed || 0);
          const displaced = n.displacedRooms || 0;
          const demand = n.transientDemand || 0;
          const fitted = Math.max(0, demand - displaced);
          const used = committed + fitted + block + displaced;
          const scale = Math.max(totalRooms, used);
          const w = (v) => (v / scale * 100) + '%';
          return (
            <div key={n.date}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{fmtNight(n.date)}</div>
              <div style={{ position: 'relative', display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', background: '#efece3' }}>
                {committed > 0 && <div style={{ width: w(committed), background: DISP_COLORS.committed }} />}
                <div style={{ width: w(fitted), background: DISP_COLORS.transient }} />
                <div style={{ width: w(block), background: DISP_COLORS.block }} />
                {displaced > 0 && <div style={{ width: w(displaced), background: DISP_COLORS.over }} />}
                <div title={`${totalRooms} rooms`} style={{ position: 'absolute', left: w(totalRooms), top: 0, bottom: 0, width: 0, borderLeft: scale > totalRooms ? '2px solid #1c2024' : 'none' }} />
              </div>
              <div style={{ fontSize: '0.8125rem', color: '#44505c', marginTop: 6, lineHeight: 1.35 }}>
                {committed > 0 ? `Other groups ${Math.round(committed)} + ` : ''}Transient {Math.round(demand)} + block {block}
                {displaced > 0.05
                  ? <> vs {totalRooms} rooms → ≈{Math.round(displaced * 10) / 10} displaced · ${Math.round(n.cost).toLocaleString()}</>
                  : <> fits → 0 displaced</>}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem', fontSize: '0.8125rem', color: '#5b636b', marginTop: '1rem' }}>
        {[['committed', 'Other groups booked'], ['transient', 'Transient demand'], ['block', "This group's block"], ['over', 'Over capacity = displaced']].map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, borderRadius: 3, background: DISP_COLORS[k], display: 'inline-block' }} />{l}</span>
        ))}
      </div>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 8 }}>
        {disp.isModeled ? 'Transient demand: modeled from 2023–25 history (a forecast, not a booking).' : 'Transient demand: estimated.'} Displaced rooms are expected values across low, median and high demand.
      </div>
    </div>
  );
}

export function KeyFactors({ ps, disp, contract, topDemand }) {
  const nights = disp?.perNight || [];
  const bad = nights.filter(n => (n.displacedRooms || 0) > 0.05);
  const ok = nights.filter(n => !((n.displacedRooms || 0) > 0.05));
  const val = Number(ps.expectedProfit) || 0;
  const bullets = [];
  if (bad.length) {
    bullets.push(<>Displaces about {Math.round(disp.displacedRoomNights * 10) / 10} transient room-night{disp.displacedRoomNights === 1 ? '' : 's'} (≈ ${disp.total.toLocaleString()}) on {bad.map(n => fmtNight(n.date)).join(', ')}{ok.length ? `; ${ok.map(n => fmtNight(n.date)).join(', ')} ${ok.length === 1 ? 'has' : 'have'} room` : ''}.</>);
  } else {
    bullets.push(<>No transient displacement expected on any night — the hotel has room for this group.</>);
  }
  bullets.push(<>Rooms value ({val < 0 ? '−' : ''}${Math.abs(val).toLocaleString()}) = room revenue ${Math.round(ps.roomRevenue).toLocaleString()} − displaced transient ${Math.round(ps.dispCost || 0).toLocaleString()} − cost of occupied rooms ${Math.round(ps.roomCost || 0).toLocaleString()}{contract?.concession_total ? ` − concessions $${Math.round(contract.concession_total).toLocaleString()}` : ''}. Cost per occupied room is a $50 placeholder.</>);
  bullets.push(<>Win probability {ps.conversionProb}% is the same at every price: the training data shows no link between the room rate and winning.</>);
  bullets.push(contract?.guaranteed_room_nights
    ? <>Contract guarantees {contract.guaranteed_room_nights} room-nights, so revenue is not lower than that even if pickup falls short.</>
    : <>No contract yet: revenue uses the model's expected pickup ({ps.pickupRate}%), with no guarantee floor.</>);
  if (topDemand) bullets.push(<>{topDemand.impact} demand period detected ({topDemand.name}).</>);
  return (
    <div style={{ background: '#fff', border: '1px solid #e7e4da', borderRadius: 16, padding: '1.25rem 1.5rem', marginTop: '1rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.0625rem', marginBottom: '0.5rem' }}>Key factors<InfoTip title="Where these lines come from">Each line is computed from the same numbers shown on this screen: displacement from the nightly bars, rooms value from the revenue tiles, win probability from the conversion model, and the guarantee line from the contract if one exists. Nothing here is typed in by hand.</InfoTip></div>
      <ul style={{ margin: 0, paddingLeft: '1.2rem', lineHeight: 1.55 }}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
    </div>
  );
}


