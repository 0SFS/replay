import type { FlightTimeline, TimelineChannel } from "./timeline.ts";

export interface TimelineClockFormat {
  /** "12:48:15 EST": local time where the flight was, with its zone. */
  local(t: number): string;
  /** "17:48:15 UTC". */
  utc(t: number): string;
  /** "12:48:15": local time without a zone, for axes. */
  short(t: number): string;
  /** "Sun, Nov 1, 2026": the local date of `t`. */
  date(t: number): string;
}

/** Times on a timeline as clock readings, in the flight's zone or UTC when it names none. */
export function timelineClockFormat(timeline: Pick<FlightTimeline, "start" | "timeZone">): TimelineClockFormat {
  const timeZone = timeline.timeZone ?? "UTC";
  const clock = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" } as const;
  const local = new Intl.DateTimeFormat("en-US", { ...clock, timeZone, timeZoneName: "short" });
  const utc = new Intl.DateTimeFormat("en-US", { ...clock, timeZone: "UTC" });
  const short = new Intl.DateTimeFormat("en-US", { ...clock, timeZone });
  const date = new Intl.DateTimeFormat("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone });
  const startMs = Date.parse(timeline.start);
  const at = (t: number) => new Date(startMs + t * 1000);
  return {
    local: t => local.format(at(t)),
    utc: t => `${utc.format(at(t))} UTC`,
    short: t => short.format(at(t)),
    date: t => date.format(at(t)),
  };
}

const DECIMALS: Record<string, number> = { "deg/s": 1, count: 0, ft: 0, "ft/min": 0, kt: 0 };

/** A channel's value as a reading, with its unit: "35,450 ft", "51°", "on". */
export function formatChannelValue(id: string, channel: TimelineChannel, value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (channel.unit === "bool") return value ? "on" : "off";
  if (channel.unit === "deg") {
    // Positions need about a metre; angles of the aircraft a tenth of a degree.
    const digits = id === "latDeg" || id === "lonDeg" ? 5 : 1;
    return `${value.toFixed(digits)}°`;
  }
  const digits = DECIMALS[channel.unit] ?? 2;
  const number = value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return channel.unit === "count" || channel.unit === "" ? number : `${number} ${channel.unit}`;
}
