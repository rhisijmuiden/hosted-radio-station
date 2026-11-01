import type { ClockItem } from '../lib/api';
import type { Segment } from '../lib/clocks';

const polar = (minute: number, r: number, c = 120) => {
  const a = (minute / 60) * Math.PI * 2 - Math.PI / 2;
  return [c + r * Math.cos(a), c + r * Math.sin(a)] as const;
};

/** A ring segment (donut slice) from one minute to another. */
function slice(from: number, to: number, outer: number, inner: number) {
  const span = Math.min(59.999, Math.max(0.05, to - from));
  const [x1, y1] = polar(from, outer);
  const [x2, y2] = polar(from + span, outer);
  const [x3, y3] = polar(from + span, inner);
  const [x4, y4] = polar(from, inner);
  const big = span > 30 ? 1 : 0;
  return `M ${x1} ${y1} A ${outer} ${outer} 0 ${big} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${big} 0 ${x4} ${y4} Z`;
}

/** The hour as a donut, like the sketch: a slice per item with its name, the clock's name in the middle. */
export function ClockDonut({
  segments,
  colorOf,
  nameOf,
  title,
  subtitle,
  highlight,
  hand,
  size = 320,
}: {
  segments: Segment[];
  colorOf: (item: ClockItem) => string;
  nameOf: (item: ClockItem) => string;
  title?: string;
  subtitle?: string;
  highlight?: number | null;
  /** The minute of the hour now: a hand on the dial, and the part of the hour already played is dimmed. */
  hand?: number | null;
  size?: number;
}) {
  const small = size < 100;
  const outer = small ? 116 : 104;
  const inner = small ? 70 : 56;
  return (
    <svg viewBox="0 0 240 240" width={size} height={size} className="shrink-0" role="img" aria-label={title}>
      <circle cx="120" cy="120" r={(outer + inner) / 2} fill="none" stroke="var(--line)" strokeWidth={outer - inner} />
      {segments
        .filter((s) => s.end > s.start)
        .map((s) => (
          <path
            key={s.item.id}
            d={slice(s.start, s.end, highlight === s.index ? outer + 4 : outer, inner)}
            fill={colorOf(s.item)}
            fillOpacity={hand != null && s.end <= hand && highlight !== s.index ? 0.3 : s.item.kind === 'rotation' ? 0.85 : highlight != null && highlight !== s.index ? 0.55 : 1}
            stroke="var(--surface-raised)"
            strokeWidth={small ? 2 : 1.5}
          />
        ))}
      {!small &&
        segments
          .filter((s) => s.end - s.start >= 4)
          .map((s) => {
            const [x, y] = polar((s.start + s.end) / 2, (outer + inner) / 2);
            const name = nameOf(s.item);
            return (
              <text key={`l-${s.item.id}`} x={x} y={y + 3} textAnchor="middle" fontSize="9" fontWeight="700" fill="#14213D">
                {name.length > 10 ? `${name.slice(0, 9)}…` : name}
              </text>
            );
          })}
      {!small &&
        [0, 15, 30, 45].map((m) => {
          const [x, y] = polar(m, 114);
          return (
            <text key={m} x={x} y={y + 3} textAnchor="middle" fontSize="7" fill="var(--ink-muted)">
              :{String(m).padStart(2, '0')}
            </text>
          );
        })}
      {!small && (
        <>
          <circle cx="120" cy="120" r={inner - 2} fill="var(--nacht)" />
          <text x="120" y="118" textAnchor="middle" className="display" fontSize="12" fill="#fff">
            {title && title.length > 11 ? `${title.slice(0, 10)}…` : title}
          </text>
          <text x="120" y="133" textAnchor="middle" fontSize="7.5" fill="#A3AEC4">
            {subtitle && subtitle.length > 18 ? `${subtitle.slice(0, 17)}…` : subtitle}
          </text>
        </>
      )}
      {hand != null && !small && (
        <g>
          <line x1={polar(hand, inner - 4)[0]} y1={polar(hand, inner - 4)[1]} x2={polar(hand, outer + 8)[0]} y2={polar(hand, outer + 8)[1]} stroke="var(--koraal)" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={polar(hand, outer + 8)[0]} cy={polar(hand, outer + 8)[1]} r="3.5" fill="var(--koraal)" />
        </g>
      )}
    </svg>
  );
}
