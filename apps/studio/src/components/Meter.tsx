import clsx from 'clsx';
import { useCallback, useEffect, useRef } from 'react';
import { useMeters } from '../lib/engine';
import type { Meters } from '../lib/native';
import { toDb } from '../lib/format';

const FLOOR = -60;
/** dBFS → 0..1 on the meter scale. */
const scale = (v: number) => Math.min(1, Math.max(0, (toDb(v) - FLOOR) / -FLOOR));
const TICKS = [-48, -36, -24, -18, -12, -6, -3, 0];

type Source = 'input' | 'output';

/** Stereo peak meter with falling bars and a peak hold, fed straight from the audio engine. */
export function StereoMeter({ source, label, vertical, className }: { source: Source; label?: string; vertical?: boolean; className?: string }) {
  const bars = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const peaks = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const target = useRef([0, 0]);
  const shown = useRef([0, 0]);
  const hold = useRef([{ v: 0, at: 0 }, { v: 0, at: 0 }]);
  useMeters(
    useCallback(
      (m: Meters) => {
        target.current = [Math.max(target.current[0]!, scale(m[source][0])), Math.max(target.current[1]!, scale(m[source][1]))];
      },
      [source],
    ),
  );
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      for (let i = 0; i < 2; i++) {
        const t = target.current[i]!;
        // Instant rise, about 20 dB per second fall.
        shown.current[i] = t > shown.current[i]! ? t : Math.max(t, shown.current[i]! - dt * 0.33);
        const h = hold.current[i]!;
        if (shown.current[i]! >= h.v || now - h.at > 1500) hold.current[i] = { v: shown.current[i]!, at: now };
        const bar = bars[i]!.current;
        const peak = peaks[i]!.current;
        if (bar) bar.style.clipPath = vertical ? `inset(${100 - shown.current[i]! * 100}% 0 0 0)` : `inset(0 ${100 - shown.current[i]! * 100}% 0 0)`;
        if (peak) {
          if (vertical) peak.style.bottom = `${hold.current[i]!.v * 100}%`;
          else peak.style.left = `calc(${hold.current[i]!.v * 100}% - 2px)`;
          peak.style.opacity = hold.current[i]!.v > 0.02 ? '1' : '0';
          peak.style.background = hold.current[i]!.v > 0.95 ? 'var(--status-offline)' : 'var(--ink)';
        }
      }
      target.current = [0, 0];
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertical]);

  if (vertical) {
    return (
      <div className={clsx('flex h-full flex-col items-center gap-1.5', className)}>
        <div className="relative flex min-h-0 flex-1 gap-1">
          {[0, 1].map((i) => (
            <div key={i} className="relative h-full w-3 overflow-hidden rounded-sm bg-meter">
              <div ref={bars[i]} className="meter-fill-v absolute inset-0" style={{ clipPath: 'inset(100% 0 0 0)' }} />
              <div ref={peaks[i]} className="absolute right-0 left-0 h-0.5 opacity-0" />
            </div>
          ))}
        </div>
        {label && <div className="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">{label}</div>}
      </div>
    );
  }
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {label && <div className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{label}</div>}
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-3 text-[10px] font-bold text-muted">{i ? 'R' : 'L'}</span>
          <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-meter">
            <div ref={bars[i]} className="meter-fill absolute inset-0" style={{ clipPath: 'inset(0 100% 0 0)' }} />
            <div ref={peaks[i]} className="absolute top-0 bottom-0 w-0.5 opacity-0" />
          </div>
        </div>
      ))}
      <div className="relative ml-5 h-3 text-[9px] text-muted">
        {TICKS.map((d) => (
          <span key={d} className="absolute -translate-x-1/2 tabular" style={{ left: `${((d - FLOOR) / -FLOOR) * 100}%` }}>
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}
