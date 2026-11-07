import { TimelineError } from "./timeline.ts";

/** A published timeline as the list of flights names it. */
export interface TimelineIndexEntry {
  id: string;
  title: string;
  subtitle?: string;
  /** ISO 8601 instant the timeline starts. */
  start: string;
}

/** Ids that are safe as one path segment: letters, digits, dots, dashes and underscores. */
const TIMELINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isTimelineId(id: string): boolean {
  return TIMELINE_ID.test(id);
}

/** Where a published timeline is, under the site's base. */
export function timelineUrl(base: string, id: string): string {
  if (!isTimelineId(id)) throw new TimelineError(`"${id}" is not a timeline id.`);
  return `${base}replay/timelines/${id}.json`;
}

export function timelineIndexUrl(base: string): string {
  return `${base}replay/timelines/index.json`;
}

/** Reads public/replay/timelines/index.json; entries that are not timelines are left out. */
export function parseTimelineIndex(value: unknown): TimelineIndexEntry[] {
  const list = typeof value === "object" && value !== null ? (value as { timelines?: unknown }).timelines : undefined;
  if (!Array.isArray(list)) throw new TimelineError("The list of flights must have a timelines array.");
  return list.flatMap((entry: unknown): TimelineIndexEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, title, subtitle, start } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !isTimelineId(id) || typeof title !== "string" || typeof start !== "string") return [];
    return [{ id, title, start, ...(typeof subtitle === "string" ? { subtitle } : {}) }];
  });
}
