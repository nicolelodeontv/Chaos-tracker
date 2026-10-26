import { useEffect, useId, useRef, useState } from 'react';
import { lastIntervalRate, windowRate, formatRate } from './repRate.js';

// Usage: <RepRatePopup clanName="Chaos" snapshots={snapshotsForThisClan} />
// `snapshots` = this clan's rows for the CURRENT season, e.g. { reputation, season, captured_at }.
// Styling inherits from the page (currentColor, background fallback); override the CSS variables if needed.
export default function RepRatePopup({ clanName, snapshots }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const rows = [
    ['Last sync', lastIntervalRate(snapshots)],
    ['Past 24 hours', windowRate(snapshots, 24)],
  ];

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        Rep/sec
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`Reputation gain rate for ${clanName}`}
          style={{
            position: 'absolute', zIndex: 20, top: '100%', right: 0, marginTop: 6, minWidth: 240, padding: 12,
            background: 'var(--rep-popup-bg, Canvas)', color: 'var(--rep-popup-fg, CanvasText)',
            border: '1px solid currentColor', borderRadius: 6, textAlign: 'left',
          }}
        >
          <strong>{clanName}</strong>
          {rows.map(([label, r]) => (
            <div key={label} style={{ marginTop: 8 }}>
              <div>{label}</div>
              {r.status === 'ok' || r.status === 'decrease' ? (
                <div>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {r.delta >= 0 ? '+' : ''}{formatRate(r.perSecond)} rep/sec
                  </span>
                  <span style={{ opacity: 0.7 }}> · {r.delta >= 0 ? '+' : ''}{formatRate(r.perHour)}/hr</span>
                  {r.status === 'decrease' && <div>Reputation dropped in this period.</div>}
                </div>
              ) : (
                <div style={{ opacity: 0.7 }}>Not enough data in this season yet.</div>
              )}
            </div>
          ))}
          <p style={{ margin: '10px 0 0', fontSize: '0.85em', opacity: 0.7 }}>
            Averages between syncs. Gains come in bursts, so the real rate is uneven.
          </p>
        </div>
      )}
    </span>
  );
}
