import type { OverviewMapOverlay, OverviewMapOverlayFrame } from "foss-earth/shell";
import { sampleIndexAt, type TimelineTrack } from "./timeline.ts";
import type { TrackPose } from "./trackPose.ts";

/** The colours the 3D trail uses: what was flown, and what is still to come. */
const FLOWN = "#ff6b40";
const AHEAD = "rgba(226, 232, 240, 0.75)";
const CASING = "rgba(15, 23, 42, 0.85)";

/** Reports closer than this to the last dot drawn, in CSS pixels, get none, so a dense track stays a line. */
const DOT_SPACING_PX = 4;

function strokePath(frame: OverviewMapOverlayFrame, lat: readonly (number | null)[], lon: readonly (number | null)[], from: number, to: number, end: { latDeg: number; lonDeg: number } | null, colour: string, width: number): void {
  const { context } = frame;
  context.beginPath();
  let drawing = false;
  const point = (latDeg: number | null | undefined, lonDeg: number | null | undefined) => {
    if (latDeg === null || latDeg === undefined || lonDeg === null || lonDeg === undefined) { drawing = false; return; }
    const at = frame.project(latDeg, lonDeg);
    if (!at) { drawing = false; return; }
    if (drawing) context.lineTo(at.x, at.y);
    else context.moveTo(at.x, at.y);
    drawing = true;
  };
  for (let i = from; i <= to; i++) point(lat[i], lon[i]);
  if (end) point(end.latDeg, end.lonDeg);
  context.lineJoin = "round";
  context.lineCap = "round";
  context.lineWidth = width + 2;
  context.strokeStyle = CASING;
  context.stroke();
  context.lineWidth = width;
  context.strokeStyle = colour;
  context.stroke();
}

/** A dot at each report from sample `from` to `to`, leaving out extrapolated samples. */
function fillReports(frame: OverviewMapOverlayFrame, track: TimelineTrack, from: number, to: number, colour: string, radius: number): void {
  const { context } = frame;
  const { latDeg: lat, lonDeg: lon, extrapolated } = track.samples;
  context.beginPath();
  let last: { x: number; y: number } | null = null;
  for (let i = from; i <= to; i++) {
    const latDeg = lat?.[i], lonDeg = lon?.[i];
    if (latDeg === null || latDeg === undefined || lonDeg === null || lonDeg === undefined || extrapolated?.[i] === 1) continue;
    const at = frame.project(latDeg, lonDeg);
    if (!at || (last && Math.hypot(at.x - last.x, at.y - last.y) < DOT_SPACING_PX)) continue;
    context.moveTo(at.x + radius, at.y);
    context.arc(at.x, at.y, radius, 0, 2 * Math.PI);
    last = at;
  }
  context.lineWidth = 2;
  context.strokeStyle = CASING;
  context.stroke();
  context.fillStyle = colour;
  context.fill();
}

/** What the map shows: the followed track, the replay's time, and the pose there. */
export interface ReplayMapState {
  track: TimelineTrack;
  t: number;
  pose: TrackPose | null;
}

/**
 * The track on the overview map: the whole path faint, and the part flown by
 * the replay's time bright, with a dot at each report where they are far
 * enough apart to tell. The map draws the aircraft's marker from its view.
 */
export function createReplayMapOverlay(read: () => ReplayMapState | null): OverviewMapOverlay {
  return {
    revision() {
      const state = read();
      if (!state) return "";
      const { track, pose } = state;
      return `${track.id}:${pose ? `${pose.latDeg.toFixed(5)},${pose.lonDeg.toFixed(5)}` : ""}`;
    },
    paint(frame) {
      const state = read();
      if (!state) return;
      const { track, t, pose } = state;
      const lat = track.samples.latDeg!;
      const lon = track.samples.lonDeg!;
      const index = sampleIndexAt(track.samples.t, t);
      frame.context.save();
      strokePath(frame, lat, lon, Math.max(0, index), track.samples.t.length - 1, null, AHEAD, 1.5);
      if (index >= 0) strokePath(frame, lat, lon, 0, index, pose, FLOWN, 2.5);
      fillReports(frame, track, index + 1, track.samples.t.length - 1, AHEAD, 1.5);
      fillReports(frame, track, 0, index, FLOWN, 2);
      frame.context.restore();
    },
  };
}
