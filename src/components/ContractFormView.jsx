import React, { useState } from 'react';
import './RFPForm.css';
import ContractTermsSection, { deriveContractTerms } from './ContractTermsSection';

// Stage 2 of the flow:  RFP (planner's request)  ->  status 'definite'  ->  Contract (sales terms).
// One contract per RFP, stored in a new `contracts` collection keyed by rfp_id.
// The RFP form stays as it is; the contract form pre-fills from the RFP and adds the terms
// from the 10/7 document (GTD/NGTD, guarantee, cutoff, F&B minimum, rental discount, concessions).
// Later, the PMS fills in actual pickup against the same contract (see `actuals` below).

const F = ({ label, children, hint }) => (
  <div className="form-group"><label>{label}</label>{children}{hint && <div className="field-hint">{hint}</div>}</div>
);
const Section = ({ title, note, children }) => (
  <div className="form-section"><div className="section-title">{title}</div>{note && <div className="section-note">{note}</div>}{children}</div>
);

const nightsBetween = (a, b) => {
  const n = Math.ceil((new Date(b) - new Date(a)) / 864e5);
  return n > 0 ? n : 0;
};

const ContractFormView = ({ rfp, contract, onSave, onBack }) => {
  const nights = nightsBetween(rfp.arrival_date, rfp.departure_date);
  const [d, setD] = useState({
    // Pre-filled from the RFP; sales can overwrite
    room_block: rfp.room_block,
    has_fnb_requirements: !!rfp.has_fnb_requirements,
    group_rate: rfp.selected_adr ?? '',
    contracted_room_nights: '',
    contract_type: '', guarantee_pct: '', cutoff_days: '',
    full_meeting_rental: rfp.Total_Room_Rental ?? '',
    fnb_minimum: '', rental_discount_pct: '',
    concessions: [],
    ...(contract || {}),
  });
  const ch = (e) => {
    const { name, value, type, checked } = e.target;
    setD(p => ({ ...p, [name]: type === 'checkbox' ? checked : value }));
  };
  const rc = (m) => `form-row ${m}`;

  const submit = (e) => {
    e.preventDefault();
    if (!d.contract_type) { alert('Choose GTD or NGTD'); return; }
    onSave({
      ...(contract || {}),
      rfp_id: rfp.id,
      event_name: rfp.event_name,
      signed_date: d.signed_date || new Date().toISOString().split('T')[0],
      ...deriveContractTerms(d, nights),
      // Filled later from the PMS (blank at signing):
      //   actual_pickup_nights, actual_room_nights_consumed, recognized_room_nights
      //   = GTD ? max(actual, guaranteed_room_nights) : actual
    }, !!contract);
  };

  return (
    <div className="rfp-form-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>{contract ? 'Edit contract' : 'New contract'}</h2>
        <button type="button" onClick={onBack} style={{ padding: '0.35rem 0.75rem', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#6b7280', fontSize: '0.8rem' }}>← Back</button>
      </div>

      <form className="rfp-form" onSubmit={submit}>
        <Section title="From the RFP" note="Read-only. Change these on the RFP, not here.">
          <div className={rc('cols-4')}>
            <F label="Event"><div className="calculated-field" style={{ padding: '0.75rem 1rem', borderRadius: '0.5rem' }}>{rfp.event_name}</div></F>
            <F label="Dates"><div className="calculated-field" style={{ padding: '0.75rem 1rem', borderRadius: '0.5rem' }}>{rfp.arrival_date} → {rfp.departure_date}</div></F>
            <F label="Room block"><div className="calculated-field" style={{ padding: '0.75rem 1rem', borderRadius: '0.5rem' }}>{rfp.room_block} × {nights} nights</div></F>
            <F label="F&B required"><div className="calculated-field" style={{ padding: '0.75rem 1rem', borderRadius: '0.5rem' }}>{rfp.has_fnb_requirements ? 'Yes' : 'No'}</div></F>
          </div>
        </Section>

        <ContractTermsSection d={d} ch={ch} nights={nights} F={F} Section={Section} rc={rc} />

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onBack}>Cancel</button>
          <button type="submit" className="btn-primary">{contract ? 'Save contract' : 'Save contract'}</button>
        </div>
      </form>
    </div>
  );
};

export default ContractFormView;
