#!/usr/bin/env node
/**
 * Builds a flight timeline from a recipe in data/:
 *
 *   node scripts/build-timeline.ts data/N722BD-2026-11-01.json
 *
 * A recipe is a TimelineSpec (src/assembleTimeline.ts) whose tracks also say
 * where their recording is (`file`, relative to this repository) and which
 * 0SFS aircraft definition draws them (`model`). Writes
 * public/replay/timelines/<id>.json, which /replay/?timeline=<id> plays, and
 * rewrites public/replay/timelines/index.json, the list /replay/ offers.
 * docs/timeline-format.md describes both files.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleTimeline, type TimelineSpec, type TrackSpec } from "../src/assembleTimeline.ts";
import { parseFlightTimeline, type TimelineModel } from "../src/timeline.ts";
import { isTimelineId, type TimelineIndexEntry } from "../src/timelineIndex.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TIMELINE_DIR = path.join(root, "public", "replay", "timelines");

export interface RecipeTrack extends TrackSpec {
  /** The recording, relative to this repository; scripts/fetch-*.ts put downloads under build/sources/. */
  file: string;
  /**
   * An 0SFS aircraft definition (aircraft.json), relative to this repository,
   * the level of detail to draw, and how that model differs from this aircraft.
   */
  model?: { definition: string; lod: string; note?: string };
}

export interface TimelineRecipe extends TimelineSpec {
  tracks: RecipeTrack[];
}

interface AircraftDefinition {
  label: string;
  modelYawRad?: number;
  modelOffset?: { x: number; y: number; z: number };
  lods: { id: string; path: string; credit?: TimelineModel["credit"] }[];
}

/** The model an aircraft definition draws at one level of detail. */
export function modelFromDefinition(definition: AircraftDefinition, lodId: string): TimelineModel {
  const lod = definition.lods.find(candidate => candidate.id === lodId);
  if (!lod) throw new Error(`${definition.label} has no "${lodId}" model; it has ${definition.lods.map(candidate => candidate.id).join(", ")}.`);
  return {
    url: lod.path,
    label: definition.label,
    ...(definition.modelYawRad !== undefined ? { yawRad: definition.modelYawRad } : {}),
    ...(definition.modelOffset ? { offset: definition.modelOffset } : {}),
    ...(lod.credit ? { credit: lod.credit } : {}),
  };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(path.resolve(root, file), "utf8"));

export function buildFromRecipe(recipe: TimelineRecipe) {
  // The recording's file is read below; what goes into the timeline is the rest of the track.
  const tracks = recipe.tracks.map(({ file, model, ...track }): TrackSpec => {
    void file;
    if (!model) return track;
    const drawn = modelFromDefinition(readJson(model.definition) as AircraftDefinition, model.lod);
    return { ...track, aircraft: { ...track.aircraft, model: model.note ? { ...drawn, note: model.note } : drawn } };
  });
  return assembleTimeline({ ...recipe, tracks }, recipe.tracks.map(track => readJson(track.file)));
}

/** JSON with objects indented and arrays of plain values kept on one line, so a sample column is one line. */
export function formatTimelineJson(value: unknown, indent = ""): string {
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item !== "object")) return JSON.stringify(value);
    const inner = indent + "  ";
    return `[\n${value.map(item => inner + formatTimelineJson(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    const inner = indent + "  ";
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${formatTimelineJson(item, inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** The list /replay/ offers when no timeline is named. */
export function writeTimelineIndex(dir = TIMELINE_DIR): void {
  const timelines = readdirSync(dir)
    .filter(name => name.endsWith(".json") && name !== "index.json")
    .sort()
    .map((name): TimelineIndexEntry => {
      const timeline = parseFlightTimeline(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      return { id: timeline.id, title: timeline.title, ...(timeline.subtitle ? { subtitle: timeline.subtitle } : {}), start: timeline.start };
    });
  writeFileSync(path.join(dir, "index.json"), formatTimelineJson({ timelines }) + "\n");
}

function main(recipePath: string | undefined): void {
  if (!recipePath) throw new Error("Usage: node scripts/build-timeline.ts data/<recipe>.json");
  const timeline = buildFromRecipe(readJson(path.resolve(recipePath)) as TimelineRecipe);
  if (!isTimelineId(timeline.id)) throw new Error(`"${timeline.id}" cannot name a file: use letters, digits, dots, dashes and underscores.`);
  mkdirSync(TIMELINE_DIR, { recursive: true });
  const out = path.join(TIMELINE_DIR, `${timeline.id}.json`);
  writeFileSync(out, formatTimelineJson(timeline) + "\n");
  writeTimelineIndex();
  const track = timeline.tracks[0]!;
  console.log(`${path.relative(root, out)}: ${timeline.tracks.length} track(s), ${track.samples.t.length} samples, ${timeline.events.length} events, ${timeline.start} + ${track.samples.t.at(-1)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]);
