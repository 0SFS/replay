import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { sampleIndexAt, sampleTrack, type TimelineEvent, type TimelineTrack } from "./timeline.ts";

export interface ProfileSeries {
  /** A channel of the track, in feet. */
  id: string;
  label: string;
  /** Picks the series colour in replay.css: slot 1 or 2 of the categorical palette. */
  slot: 1 | 2;
}

export interface ProfileChartProps {
  track: TimelineTrack;
  series: readonly ProfileSeries[];
  /** The span drawn, in timeline seconds. */
  span: { start: number; end: number };
  t: number;
  events: readonly TimelineEvent[];
  highlight?: { start: number; end: number };
  formatTime(t: number): string;
  onSeek(t: number): void;
}

const HEIGHT = 150;
const MARGIN = { top: 8, right: 10, bottom: 22, left: 48 };
/** A gap longer than this between samples breaks the line instead of bridging it. */
const MAX_BRIDGE_S = 90;

function niceStep(range: number): number {
  const rough = range / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 2.5, 5, 10].map(f => f * power).find(step => step >= rough) ?? power * 10;
}

const feet = (value: number) => `${Math.round(value).toLocaleString("en-US")} ft`;

/**
 * Altitude against time, one axis in feet, with the replay's time as a
 * cursor. Pointing reads every series at that time; pressing or dragging seeks.
 */
export function ProfileChart({ track, series, span, t, events, highlight, formatTime, onSeek }: ProfileChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(360);
  const [hoverT, setHoverT] = useState<number | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(200, host.clientWidth)));
    observer.observe(host);
    setWidth(Math.max(200, host.clientWidth));
    return () => observer.disconnect();
  }, []);

  const times = track.samples.t;
  const first = Math.max(0, sampleIndexAt(times, span.start));
  const last = Math.max(first, Math.min(times.length - 1, sampleIndexAt(times, span.end) + 1));
  let max = 0;
  for (const { id } of series) {
    const column = track.samples[id];
    for (let i = first; i <= last; i++) if (column?.[i] != null) max = Math.max(max, column[i]!);
  }
  const step = niceStep(Math.max(max, 1000));
  const top = Math.ceil(max / step) * step || step;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (time: number) => MARGIN.left + (time - span.start) / (span.end - span.start || 1) * plotWidth;
  const y = (feetValue: number) => MARGIN.top + (1 - feetValue / top) * plotHeight;
  const timeAt = (clientX: number, element: Element) => {
    const bounds = element.getBoundingClientRect();
    const fraction = (clientX - bounds.left - MARGIN.left * bounds.width / width) / (plotWidth * bounds.width / width);
    return span.start + Math.min(1, Math.max(0, fraction)) * (span.end - span.start);
  };

  const paths = series.map(({ id }) => {
    const column = track.samples[id];
    if (!column) return "";
    let d = "";
    let previousT: number | null = null;
    for (let i = first; i <= last; i++) {
      const value = column[i];
      if (value === null || value === undefined) { previousT = null; continue; }
      const command = previousT === null || times[i]! - previousT > MAX_BRIDGE_S ? "M" : "L";
      d += `${command}${x(times[i]!).toFixed(1)},${y(value).toFixed(1)}`;
      previousT = times[i]!;
    }
    return d;
  });

  const readT = hoverT ?? t;
  const reading = sampleTrack(track, readT);
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const seekFrom = (event: ReactPointerEvent<SVGSVGElement>) => onSeek(timeAt(event.clientX, event.currentTarget));

  return <div className="replay-profile" ref={hostRef}>
    <div className="replay-profile__legend" aria-live="off">
      <span className="replay-profile__time">{formatTime(readT)}</span>
      {series.map(({ id, label, slot }) => {
        const value = reading?.values[id];
        return <span key={id} className="replay-profile__key">
          <svg width="14" height="4" aria-hidden="true"><line x1="1" y1="2" x2="13" y2="2" className={`replay-series-${slot}`} /></svg>
          <strong>{value === null || value === undefined ? "—" : feet(value)}</strong>
          <span>{label}</span>
        </span>;
      })}
    </div>
    <svg className="replay-profile__plot" width={width} height={HEIGHT} role="img"
      aria-label={`Altitude from ${formatTime(span.start)} to ${formatTime(span.end)}, up to ${feet(max)}. Press or drag to move the replay.`}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); seekFrom(event); }}
      onPointerMove={event => {
        setHoverT(timeAt(event.clientX, event.currentTarget));
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFrom(event);
      }}
      onPointerLeave={() => setHoverT(null)}>
      {highlight && highlight.end > span.start && highlight.start < span.end ? <rect className="replay-profile__highlight"
        x={x(Math.max(span.start, highlight.start))} y={MARGIN.top}
        width={Math.max(0, x(Math.min(span.end, highlight.end)) - x(Math.max(span.start, highlight.start)))} height={plotHeight} /> : null}
      {ticks.map(value => <g key={value}>
        <line className="replay-profile__grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(value)} y2={y(value)} />
        <text className="replay-profile__axis" x={MARGIN.left - 6} y={y(value)} dy="0.32em" textAnchor="end">{value >= 1000 ? `${value / 1000}k` : value}</text>
      </g>)}
      <text className="replay-profile__axis" x={MARGIN.left} y={HEIGHT - 6}>{formatTime(span.start)}</text>
      <text className="replay-profile__axis" x={width - MARGIN.right} y={HEIGHT - 6} textAnchor="end">{formatTime(span.end)}</text>
      {events.filter(event => event.t >= span.start && event.t <= span.end).map(event => <line key={`${event.t}-${event.title}`}
        className="replay-profile__event" x1={x(event.t)} x2={x(event.t)} y1={MARGIN.top + plotHeight} y2={MARGIN.top + plotHeight - 6}>
        <title>{`${formatTime(event.t)} ${event.title}`}</title>
      </line>)}
      {series.map(({ id, slot }, index) => <path key={id} d={paths[index]} className={`replay-profile__line replay-series-${slot}`} />)}
      {hoverT !== null ? <line className="replay-profile__hover" x1={x(hoverT)} x2={x(hoverT)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} /> : null}
      {t >= span.start && t <= span.end ? <line className="replay-profile__cursor" x1={x(t)} x2={x(t)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} /> : null}
    </svg>
  </div>;
}
