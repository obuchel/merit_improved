import React from 'react';
import InfoTip from './InfoTip';

// Model status: what the recommended rate is built from, and how far each part is from real hotel data.
// Labels follow the report (s.13): Observed / Estimated / Simulated / Placeholder.
const CHIP = {
  Observed:    { bg: '#e6f4ea', fg: '#1e6b34' },
  Estimated:   { bg: '#e3edf5', fg: '#245a85' },
  Simulated:   { bg: '#ece4f5', fg: '#5a3a85' },
  Placeholder: { bg: '#fbe6d8', fg: '#a34a12' },
  'None found': { bg: '#eceae3', fg: '#4b5563' },
  'Not set':   { bg: '#eceae3', fg: '#4b5563' },
};

export default function ModelStatus({ rate, contract, cpor, totalRooms }) {
  const hasRental = contract && Number(contract.full_meeting_rental) > 0;
  const hasGuar = contract && Number(contract.guaranteed_room_nights) > 0;
  const items = [
    ['Hotel capacity', 'Observed', `${totalRooms} rooms`],
    ['Transient demand', 'Estimated', 'Modeled from 2023–25 history; error about 14 rooms'],
    ['Transient ADR', 'Estimated', 'Modeled forecast, error about $7.50'],
    ['Rooms on the books', 'Estimated', 'From booked events entered in the app; check for duplicates'],
    ['Quoted rate (ADR) model', 'Simulated', 'Trained on simulated data; test R² 0.91, no price-derived inputs'],
    ['Pickup model', 'Simulated', 'Trained on simulated data; R² 0.83'],
    ['F&B model', 'Simulated', 'Trained on simulated data; predicts $ per person'],
    ['Win-probability model', 'Simulated', 'Logistic regression, AUC 0.76; trained on simulated data'],
    ['Price-response', 'None found', 'Win rate shows no relation to quoted rate, so conversion is the same at every rate'],
    ['Displacement', 'Estimated', 'Per night from the demand forecast and booked rooms'],
    ['Hotel costs', 'Placeholder', `$${cpor} per occupied room-night, set in hotelConfig.js`],
    ['Perturbation terms', 'Simulated', 'Fitted on simulated groups; none passed the held-out check'],
    ['Meeting rental', hasRental ? 'Observed' : 'Placeholder', hasRental ? 'Rental charged from the contract' : 'Estimated from the config rate until a contract is entered'],
    ['Contract guarantee', hasGuar ? 'Observed' : 'Not set', hasGuar ? `${contract.guaranteed_room_nights} room-nights guaranteed` : 'No contract yet; revenue uses expected pickup only'],
  ];
  return (
    <div style={{ background: '#fff', border: '1px solid #e7e4da', borderRadius: 16, padding: '1.25rem 1.5rem', marginTop: '1rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.0625rem', marginBottom: 4 }}>Model status
        <InfoTip title="What the labels mean">Observed: taken from the hotel or the contract. Estimated: computed by a model or forecast from hotel history. Simulated: model trained on simulated data, so it shows the pipeline works, not real accuracy. Placeholder: a test value until the hotel supplies the real figure. None found: tested, and no effect was detected.</InfoTip>
      </div>
      <div style={{ fontSize: '0.875rem', color: '#5b636b', marginBottom: 12 }}>
        What this rate is built from. Until the placeholder and simulated items are replaced with hotel data, treat {rate ? `$${Math.round(rate)}` : 'this rate'} as indicative.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '0 2rem' }}>
        {items.map(([name, status, detail]) => {
          const c = CHIP[status];
          return (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '8px 0', borderBottom: '1px solid #efece3' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{name}</div>
                <div style={{ fontSize: '0.75rem', color: '#6b7280', lineHeight: 1.35 }}>{detail}</div>
              </div>
              <span style={{ background: c.bg, color: c.fg, fontWeight: 700, fontSize: '0.78rem', padding: '3px 10px', borderRadius: 6, whiteSpace: 'nowrap' }}>{status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
