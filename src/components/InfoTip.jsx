import React, { useState, useRef } from 'react';

// Small "i" badge that explains how a number was calculated. Shows on hover, keyboard focus or tap.
// The popover is positioned with fixed coordinates so card overflow never clips it.
export default function InfoTip({ title, children, width = 320 }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = r.bottom + 8 + 220 < window.innerHeight;
    setPos({ left, top: below ? r.bottom + 8 : Math.max(8, r.top - 8), above: !below });
  };
  const close = () => setPos(null);
  return (
    <span style={{ display: 'inline-block', marginLeft: 6, verticalAlign: 'middle' }}>
      <span
        ref={ref} tabIndex={0} role="button" aria-label={`How this is calculated${title ? ': ' + title : ''}`}
        onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}
        onClick={(e) => { e.stopPropagation(); pos ? close() : open(); }}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%',
          border: '1px solid #94a3b8', color: '#64748b', fontSize: 11, fontWeight: 700, fontStyle: 'italic', cursor: 'help', lineHeight: 1, userSelect: 'none', background: '#fff' }}
      >i</span>
      {pos && (
        <span role="tooltip" style={{ position: 'fixed', left: pos.left, top: pos.top, transform: pos.above ? 'translateY(-100%)' : 'none', width,
          zIndex: 5000, background: '#1c2024', color: '#f4f4f0', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5,
          fontWeight: 400, fontStyle: 'normal', textAlign: 'left', boxShadow: '0 8px 24px rgba(0,0,0,.28)', pointerEvents: 'none', whiteSpace: 'normal' }}>
          {title && <span style={{ display: 'block', fontWeight: 700, marginBottom: 4 }}>{title}</span>}
          {children}
        </span>
      )}
    </span>
  );
}
