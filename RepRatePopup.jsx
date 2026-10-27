"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { formatElapsed, formatRate } from './repRate.js';

export default function RepRatePopup({ clanName, rates }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16, ready: false });
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    const closeWhenAnotherOpens = (event) => {
      if (event.detail !== panelId) setOpen(false);
    };
    window.addEventListener('rep-rate-popup-open', closeWhenAnotherOpens);
    return () => window.removeEventListener('rep-rate-popup-open', closeWhenAnotherOpens);
  }, [panelId]);

  useEffect(() => {
    if (!open) return;

    const placePanel = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) return;

      const margin = 16;
      const left = Math.max(margin, Math.min(trigger.left, window.innerWidth - panel.width - margin));
      const below = trigger.bottom + 6;
      const above = trigger.top - panel.height - 6;
      const maxTop = Math.max(margin, window.innerHeight - panel.height - margin);
      const preferredTop = below + panel.height <= window.innerHeight - margin ? below : above;
      // Clamp even when resizing leaves the trigger itself partly outside the viewport.
      const top = Math.max(margin, Math.min(preferredTop, maxTop));

      setPosition((previous) => (
        previous.ready && Math.abs(previous.left - left) < 1 && Math.abs(previous.top - top) < 1
          ? previous
          : { left, top, ready: true }
      ));
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };

    placePanel();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('scroll', placePanel, true);
    window.addEventListener('resize', placePanel);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('scroll', placePanel, true);
      window.removeEventListener('resize', placePanel);
    };
  }, [open]);

  const openPopup = () => {
    if (open) {
      setOpen(false);
      return;
    }
    window.dispatchEvent(new CustomEvent('rep-rate-popup-open', { detail: panelId }));
    setPosition({ left: 16, top: 16, ready: false });
    setOpen(true);
  };

  const rows = [
    {
      key: 'lastInterval',
      label: 'Recent interval',
      rate: rates?.lastInterval,
      empty: 'Need snapshots at least 5 minutes apart.',
    },
    {
      key: 'past24Hours',
      label: '24-hour window',
      rate: rates?.past24Hours,
      empty: 'Not enough current-season data in this window yet.',
    },
  ];

  return (
    <span ref={containerRef} className="rep-rate-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="rep-rate-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={openPopup}
      >
        Rep/sec
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="rep-rate-panel"
        role="dialog"
        aria-label={`Reputation gain rate for ${clanName}`}
        hidden={!open}
        style={{
          left: position.left,
          top: position.top,
          visibility: position.ready ? 'visible' : 'hidden',
        }}
      >
        <strong>{clanName}</strong>
        {rows.map(({ key, label, rate, empty }) => (
          <div className="rep-rate-metric" key={key}>
            <div className="rep-rate-metric-label">
              {label}
              {rate?.seconds > 0 && (
                <span className="rep-rate-span"> · {formatElapsed(rate.seconds)} actual span</span>
              )}
            </div>
            {rate?.status === 'ok' || rate?.status === 'decrease' ? (
              <>
                <div className="rep-rate-value">
                  <span>
                    {rate.delta >= 0 ? '+' : ''}{formatRate(rate.perSecond)} rep/sec
                  </span>
                  <span className="rep-rate-per-hour">
                    {' · '}{rate.delta >= 0 ? '+' : ''}{formatRate(rate.perHour)} rep/hr
                  </span>
                </div>
                {rate.status === 'decrease' && (
                  <p className="rep-rate-warning">Reputation dropped in this period.</p>
                )}
              </>
            ) : (
              <div className="rep-rate-empty">{empty}</div>
            )}
          </div>
        ))}
        <p className="rep-rate-note">
          The recent rate ignores intervals shorter than five minutes. Reputation gains arrive in bursts, so these are averages.
        </p>
      </div>
    </span>
  );
}
