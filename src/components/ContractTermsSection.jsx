import React from 'react';

// Body of the CONTRACT form (draft). Used by ContractFormView.jsx, not the RFP form.
// Source of every field: MERIT Input Data, Hotel Sources & Simulation
// Assumptions (10/7/26). Field names are proposals — confirm with Kim.
//
// Props: d (form state), ch (the form's change handler), nights, F, Section, rc
// (the helper components already defined in RFPFormView.jsx).
//
// Fields written to the RFP record:
//   contract_type            'GTD' | 'NGTD' | ''
//   contracted_room_nights   number  (default room_block x nights, editable)
//   group_rate               number  ($/night)
//   guarantee_pct            number  (GTD only, 70-80 typical)
//   guaranteed_room_nights   derived = contracted_room_nights x guarantee_pct
//   cutoff_days              number  (days before arrival the block is released)
//   fnb_minimum              number  (F&B only)
//   full_meeting_rental      number  (list price of meeting space)
//   rental_discount_pct      number  (0-100; 100 = waived)
//   rental_charged           derived = full_meeting_rental x (1 - discount)
//   concessions              [{ type, qty, unit_value }]
//   concession_total         derived = sum(qty x unit_value)

export const CONCESSION_TYPES = [
  { id: 'comp_room',     label: 'Complimentary room night', unit: 'group_rate' },
  { id: 'suite_upgrade', label: 'Suite upgrade',            unit: 'suite_diff', def: 325 },
  { id: 'comp_suite',    label: 'Complimentary suite night', unit: 'fixed', def: 500 },
  { id: 'reception',     label: 'Welcome reception',        unit: 'fixed', def: 1200 },
  { id: 'fnb_credit',    label: 'F&B credit',               unit: 'fixed', def: 1000 },
  { id: 'other',         label: 'Other',                    unit: 'fixed', def: 0 },
];

const money = (n) => '$' + Math.round(n || 0).toLocaleString();
const num = (v) => parseFloat(v) || 0;

export const deriveContractTerms = (d, nights) => {
  const contracted = num(d.contracted_room_nights) || num(d.room_block) * (nights || 0);
  const gtd = d.contract_type === 'GTD';
  const guaranteed = gtd ? Math.round(contracted * num(d.guarantee_pct) / 100) : 0;
  const rentalCharged = num(d.full_meeting_rental) * (1 - num(d.rental_discount_pct) / 100);
  const concessions = (d.concessions || []).map(c => ({ ...c, qty: num(c.qty), unit_value: num(c.unit_value) }));
  const concessionTotal = concessions.reduce((s, c) => s + c.qty * c.unit_value, 0);
  return {
    contract_type: d.contract_type || '',
    contracted_room_nights: contracted,
    group_rate: num(d.group_rate),
    guarantee_pct: gtd ? num(d.guarantee_pct) : 0,
    guaranteed_room_nights: guaranteed,
    cutoff_days: d.cutoff_days === '' || d.cutoff_days == null ? null : parseInt(d.cutoff_days),
    fnb_minimum: d.has_fnb_requirements ? num(d.fnb_minimum) : 0,
    full_meeting_rental: num(d.full_meeting_rental),
    rental_discount_pct: d.has_fnb_requirements ? num(d.rental_discount_pct) : 0,
    rental_charged: d.has_fnb_requirements ? rentalCharged : num(d.full_meeting_rental),
    concessions,
    concession_total: concessionTotal,
  };
};

const ContractTermsSection = ({ d, ch, nights, F, Section, rc }) => {
  const t = deriveContractTerms(d, nights);
  const gtd = d.contract_type === 'GTD';
  const setConcessions = (next) => ch({ target: { name: 'concessions', value: next } });
  const list = d.concessions || [];

  const addConcession = () => setConcessions([...list, { type: 'comp_room', qty: 1, unit_value: num(d.group_rate) }]);
  const updConcession = (i, patch) => setConcessions(list.map((c, j) => j === i ? { ...c, ...patch } : c));
  const changeType = (i, id) => {
    const def = CONCESSION_TYPES.find(x => x.id === id);
    const unit = def.unit === 'group_rate' ? num(d.group_rate) : (def.def ?? 0);
    updConcession(i, { type: id, unit_value: unit });
  };
  const delConcession = (i) => setConcessions(list.filter((_, j) => j !== i));

  const calc = { padding: '0.75rem 1rem', borderRadius: '0.5rem', fontWeight: 600 };

  return (
    <Section title="Contract terms (sales)"
      note="Filled in by the sales team from the proposal or signed contract — not by the planner. Contracted room nights are not the same as room nights the hotel will actually earn.">

      <div className={rc('cols-2')}>
        <F label="Contract Type" hint="GTD = guaranteed block with attrition protection. NGTD = no protection.">
          <select name="contract_type" value={d.contract_type || ''} onChange={ch}>
            <option value="">Not decided</option>
            <option value="GTD">Guaranteed (GTD)</option>
            <option value="NGTD">Non-guaranteed (NGTD)</option>
          </select>
        </F>
        <F label="Group Rate ($/night)">
          <input type="number" name="group_rate" value={d.group_rate ?? ''} onChange={ch} min="0" placeholder="e.g., 175" />
        </F>
        <F label="Contracted Room Nights" hint={d.room_block && nights ? `Default: ${d.room_block} rooms × ${nights} nights` : 'Room block × nights'}>
          <input type="number" name="contracted_room_nights" value={d.contracted_room_nights ?? ''} onChange={ch} min="0"
                 placeholder={d.room_block && nights ? String(d.room_block * nights) : ''} />
        </F>
        <F label="Cutoff / Release (days before arrival)">
          <input type="number" name="cutoff_days" value={d.cutoff_days ?? ''} onChange={ch} min="0" placeholder="e.g., 30" />
        </F>
        {gtd && (
          <>
            <F label="Guarantee / Attrition (%)" hint="Share of the block the group must pay for. Typically 70–80%, set per contract.">
              <input type="number" name="guarantee_pct" value={d.guarantee_pct ?? ''} onChange={ch} min="0" max="100" placeholder="e.g., 74" />
            </F>
            <F label="Guaranteed Room Nights (floor)">
              <div className="calculated-field" style={calc}>{t.guaranteed_room_nights.toLocaleString()} nights · {money(t.guaranteed_room_nights * t.group_rate)}</div>
            </F>
          </>
        )}
      </div>
      {d.contract_type === 'NGTD' && (
        <div className="field-hint" style={{ marginBottom: '0.5rem' }}>
          No contractual floor. MERIT values only the rooms that are expected to be picked up.
        </div>
      )}

      {/* F&B minimum and meeting-room rental */}
      <div className="section-title" style={{ fontSize: '0.85rem', marginTop: '0.75rem' }}>Meeting-room rental &amp; F&amp;B minimum</div>
      {!d.has_fnb_requirements && (
        <div className="field-hint">No F&amp;B on this RFP, so the full meeting-room rental applies. Tick "F&amp;B Required" above to enter a minimum.</div>
      )}
      <div className={rc('cols-2')}>
        <F label="Full Meeting-Room Rental ($)" hint="List price for the space, before any discount.">
          <input type="number" name="full_meeting_rental" value={d.full_meeting_rental ?? ''} onChange={ch} min="0" placeholder="e.g., 10000" />
        </F>
        {d.has_fnb_requirements && (
          <>
            <F label="Required F&B Minimum ($)" hint="Spend the hotel requires in exchange for the rental discount.">
              <input type="number" name="fnb_minimum" value={d.fnb_minimum ?? ''} onChange={ch} min="0" placeholder="e.g., 35000" />
            </F>
            <F label="Rental Discount (%)" hint="100 = rental waived.">
              <input type="number" name="rental_discount_pct" value={d.rental_discount_pct ?? ''} onChange={ch} min="0" max="100" placeholder="e.g., 50" />
            </F>
          </>
        )}
        <F label="Meeting-Room Rental Charged">
          <div className="calculated-field" style={calc}>{money(t.rental_charged)}</div>
        </F>
      </div>

      {/* Direct concessions */}
      <div className="section-title" style={{ fontSize: '0.85rem', marginTop: '0.75rem' }}>Direct concessions</div>
      <div className="field-hint" style={{ marginBottom: '0.4rem' }}>
        Only items given to this group at a dollar value. The meeting-room discount above already counts, so don't enter it again. Commission is not included.
      </div>
      {list.map((c, i) => (
        <div key={i} className={rc('cols-4')} style={{ alignItems: 'end' }}>
          <F label={i === 0 ? 'Type' : ''}>
            <select value={c.type} onChange={e => changeType(i, e.target.value)}>
              {CONCESSION_TYPES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </F>
          <F label={i === 0 ? 'Quantity' : ''}>
            <input type="number" min="0" value={c.qty} onChange={e => updConcession(i, { qty: e.target.value })} />
          </F>
          <F label={i === 0 ? 'Value each ($)' : ''}>
            <input type="number" min="0" value={c.unit_value} onChange={e => updConcession(i, { unit_value: e.target.value })} />
          </F>
          <F label={i === 0 ? 'Subtotal' : ''}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div className="calculated-field" style={{ ...calc, flex: 1 }}>{money(num(c.qty) * num(c.unit_value))}</div>
              <button type="button" onClick={() => delConcession(i)} aria-label="Remove concession"
                style={{ border: '1px solid #e2e8f0', background: '#fff', borderRadius: 6, padding: '0.4rem 0.6rem', cursor: 'pointer', color: '#6b7280' }}>✕</button>
            </div>
          </F>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.4rem' }}>
        <button type="button" onClick={addConcession}
          style={{ border: '1px dashed #cbd5e0', background: '#fff', borderRadius: 6, padding: '0.4rem 0.8rem', cursor: 'pointer', color: '#4a5568', fontSize: '0.85rem' }}>
          + Add concession
        </button>
        <div style={{ fontWeight: 700 }}>Total concessions: {money(t.concession_total)}</div>
      </div>
    </Section>
  );
};

export default ContractTermsSection;
