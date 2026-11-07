# Flight timelines

A flight timeline records what one or more aircraft did over time. It is one JSON file that a page can replay on any device, without running a simulation. ADS-B recordings use the format now. The simulator's own flights can use it later, so that a replay can lay a simulated flight over a recorded one.

`src/timeline.ts` is the reference: its types, and `parseFlightTimeline`, which checks a file and says what is wrong with it.

## The file

```json
{
  "format": "0sfs-flight-timeline",
  "version": 1,
  "id": "N722BD-2026-11-01",
  "title": "Learjet 60 N722BD",
  "subtitle": "Austin, Texas, toward North Eleuthera, Bahamas, 1 November 2026. …",
  "start": "2026-11-01T15:32:00.000Z",
  "timeZone": "America/New_York",
  "highlight": { "start": 8130, "end": 8253.16 },
  "license": { "id": "ODbL-1.0", "url": "https://opendatacommons.org/licenses/odbl/1-0/", "attribution": "…" },
  "sources": [{ "id": "adsblol", "name": "adsb.lol history, …", "url": "…", "license": "ODbL-1.0", "retrieved": "2026-11-02", "note": "…" }],
  "tracks": [
    {
      "id": "N722BD",
      "label": "N722BD (ADS-B)",
      "kind": "observed",
      "aircraft": { "registration": "N722BD", "type": "LJ60", "description": "Bombardier Learjet 60", "icao24": "a9ab17" },
      "sources": ["adsblol"],
      "channels": {
        "latDeg": { "label": "Latitude", "unit": "deg" },
        "lonDeg": { "label": "Longitude", "unit": "deg", "interpolation": "angle" },
        "groundSpeedKt": { "label": "Ground speed", "unit": "kt" },
        "onGround": { "label": "On the ground", "unit": "bool", "interpolation": "step" }
      },
      "samples": {
        "t": [26.89, 31.06, 35.95],
        "latDeg": [30.184181, 30.18418, 30.184181],
        "lonDeg": [-97.661819, -97.661728, -97.661618],
        "groundSpeedKt": [3.8, 4.2, 4.2],
        "onGround": [1, 1, 1]
      }
    }
  ],
  "events": [{ "t": 8175, "kind": "observation", "title": "Highest point: 35,450 ft, then nose down", "detail": "…" }],
  "notes": ["This is what the aircraft's transponder broadcast …"]
}
```

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `"0sfs-flight-timeline"` and `1`. A change that older pages cannot read needs a new version. |
| `id` | The file's name without `.json`, and the `?timeline=` of the replay's address. It uses letters, digits, `.`, `_` and `-`, and starts with a letter or a digit. |
| `title`, `subtitle` | What the page and the Flights tab show. |
| `start` | The ISO 8601 instant of t = 0. Every other time in the file is in seconds after it. |
| `timeZone` | The IANA zone for local times, such as `America/New_York`. The replay shows local time and UTC. UTC is used when this is omitted. |
| `highlight` | The part the replay opens on, and the chart's first span. Optional. |
| `license` | The licence of the timeline as a whole. A database derived from open data usually has to keep its sources' licence. |
| `sources` | Where the data came from: name, link, licence, attribution, when it was retrieved, and a note. Tracks name the sources they use by `id`. |
| `tracks` | One or more aircraft. The replay follows and draws the first. |
| `events` | The moments worth stopping at, which the parser puts in time order. `kind` is `phase`, `observation`, `radio` or `note`. |
| `audio` | Sound that plays along with the replay, such as the air traffic control frequency. Optional; see [Sound](#sound). |
| `notes` | Caveats that a reader should see before drawing conclusions. The Sources tab shows them first. |

## Tracks

| Field | Meaning |
| --- | --- |
| `id`, `label` | The track's name in the file and on the page. |
| `kind` | `observed` for a recording, `simulated` for a flight the simulator flew. |
| `aircraft` | Optional. `registration`, `type` (ICAO designator, such as `LJ60`), `description`, `icao24` (Mode S address in hex), and the `model` to draw it with. |
| `sources` | Ids from the timeline's `sources`. |
| `channels` | What each sample column holds: `label`, `unit`, and optionally `interpolation`, `derived` (how it was computed, when no source reported it directly) and `note`. |
| `samples` | `t`, which never decreases, and one column per channel, all the same length. `null` means there was no report of that value at that time. |

Between two samples, a value is `linear` by default. An `angle` goes the shorter way round, and a `step` holds the earlier sample. Where one of the two samples has no value, the nearer sample's value, or its absence, is used, so a column with gaps does not invent values across them.

The readings show every channel of the followed track by its label and unit, and mark the derived ones. The altitude chart draws up to two channels in `ft`. These ids also mean something to the replay:

| Channel | Unit | Meaning |
| --- | --- | --- |
| `latDeg`, `lonDeg` | deg | Position. Every track has both. |
| `altGeomFt` | ft | GNSS altitude, a height above the WGS 84 ellipsoid. The aircraft is placed by it. Over raster terrain, which the globe draws at heights above sea level, the replay subtracts the EGM2008 geoid's height first; over Google 3D Tiles, which are at heights above the ellipsoid, it does not. |
| `altBaroFt` | ft | Pressure altitude, referenced to 29.92 inHg. It is used to place the aircraft when the track has no GNSS altitude. |
| `groundSpeedKt` | kt | Speed over the ground. |
| `trackDeg` | deg | Direction of travel over the ground, from true north. It is used as the heading when there is no `headingDeg`. |
| `headingDeg`, `pitchDeg`, `rollDeg` | deg | Recorded or simulated attitude. Each wins over its estimate wherever it has a value, and a track with both `pitchDeg` and `rollDeg` is shown as having a recorded attitude. |
| `turnRateDegS`, `pitchEstDeg`, `rollEstDeg` | deg/s, deg | Turn rate, flight-path angle and the bank of a coordinated turn, worked out from the path (`src/kinematics.ts`). Every track built from a recording gets them. They stand in for the attitude when drawing the aircraft. |
| `baroRateFpm`, `geomRateFpm` | ft/min | Vertical rates as reported. ADS-B cannot carry more than ±32,640 ft/min. |
| `vsFromGeomFpm` | ft/min | Vertical rate fitted to GNSS altitude, without that limit. |
| `onGround`, `spi` | bool | On the ground. IDENT (Special Position Identification). |
| `nic` | count | Navigation Integrity Category: how far the transponder vouches for its position. |
| `extrapolated` | bool | 1 where the track is continued past its last report (`src/extrapolate.ts`). Position, GNSS altitude, ground speed, track and rates there were worked out, not reported, and the other channels are null. The readings say so. |

The aircraft and its path are drawn at the placing altitude smoothed by a line fitted over ±2 s (`drawnAltitudeFt` in `src/trackPose.ts`). This takes out the 25 ft steps and repeated values that ADS-B reports altitude in. Gaps are filled along a straight line. Extrapolated samples are drawn as they are. The readings and the chart show the values in the file. A dot along the path marks each sample with a position, at its reported altitude (or the path's, where it has none), so where the line was smoothed the dots can sit off it. Extrapolated samples get no dot.

## Models

A track's `aircraft.model` says how to draw it. A recipe copies the model from an 0SFS aircraft definition (`aircraft.json`).

| Field | Meaning |
| --- | --- |
| `url` | The glTF file, relative to the site's root, such as `aircraft/learjet-60/Learjet_60_HD.glb`. The fly app links each package's `public/` into its own, so the file is served there. |
| `label` | The model's name on the page. |
| `yawRad`, `offset` | The turn that points the nose forward, and the metres from the model's origin to the point the track's position refers to, as in the aircraft definition. |
| `credit` | `artist`, `licence`, `sourceUrl` and `note`, shown wherever the model is. Required for a published timeline. |
| `note` | How the model differs from the aircraft it stands for, such as another aircraft's paint. |

A block stands in for the aircraft until its model has loaded, or when there is no model.

## Sound

Each entry in `audio` is one recording that the Radio tab plays in time with the replay (`src/radioPlayer.ts`).

| Field | Meaning |
| --- | --- |
| `id`, `label` | The recording's name in the file and on the page. |
| `kind` | `radio`. |
| `files` | The same sound in more than one format, each a `url` and a `type` with its codecs, in order of preference. A browser plays the first it can: Ogg Opus first, then MP3 for Safari. A `url` may point to another site, such as Wikimedia's, whose licence allows it. |
| `sources` | Ids from the timeline's `sources`. At least one gives the licence. |
| `t`, `duration` | Seconds after the timeline's start at which the recording's first second plays, and how long it is. |
| `alignment` | How `t` was found (`method`) and to within how many seconds (`uncertaintyS`). The Radio tab shows both. |
| `transcript` | Optional. Lines of what was said, each with `at` and `end`, in seconds into the recording, and `text`. Missing words are `[…]`. |
| `transcriptNote` | Where the transcript came from, and how far to trust it. |
| `note` | What a listener should know before playing it. |

The replay's clock leads. The sound starts, stops, seeks and changes speed with it. It is moved back when it drifts more than 0.3 s, and it is silent outside 0.25× to 2×. The listener can move it by tenths of a second, and can open a recording from their own device. A LiveATC archive's name, such as `KZMA-Sec-Nov-01-2026-1730Z.mp3`, gives its start.

A recording is usually lined up by what was said in it that the data also shows, such as a descent rate the crew reads out. Give the figures and the times in the flight's document. A recording with cuts in it would need one entry per uncut piece.

A `radio` event is a line of the transcript worth stopping at. It is at the time that line starts, `t + at`. The tests check that it is.

## Recipes

A published timeline is built from a recipe, `data/<id>.json`. A recipe is written the way a person checks one. Its times are ISO 8601 instants that can be compared with a recording by eye, and the builder turns them into seconds after `start`.

A recipe has a timeline's fields, with these differences:

- `start` is optional. Without it, t = 0 is the first track's first kept sample, rounded down to the second.
- `highlight` is `{ "start": <ISO>, "end": <ISO> }`.
- Each event has `at`, an ISO instant, instead of `t`.
- Each entry in `audio` has `at`, the ISO instant of the recording's first second, instead of `t`.
- Each track gives `format` (a kind of recording, below), `file` (the recording, relative to this repository) and `sources`, and optionally:
  - `from` and `to`, to keep only part of the recording;
  - `aircraft`, laid over what the recording says about the aircraft;
  - `model`, as `{ "definition": "../Learjet-60/aircraft.json", "lod": "hd", "note": "…" }`;
  - `extrapolate`, as `{ "groundFt": 17, "geoidFt": -91 }`, to continue the track from its last report to the ground. The last report's ground speed, turn rate and vertical rate are held. `groundFt` is the ground's height above sea level, and `geoidFt` is the height of sea level (the EGM2008 geoid) above the WGS 84 ellipsoid there. Say in the timeline's notes and the flight's document where both came from, and add an event where the track reaches the ground.

`npm run build:timeline -- data/<id>.json` writes `public/replay/timelines/<id>.json` and rewrites `index.json` from every timeline there. It keeps each sample column on one line, so a change to the data shows as a small diff.

## Adding an incident

1. Find a recording whose licence allows it to be published. adsb.lol's history is under the ODbL: `npm run fetch:adsblol -- <YYYY-MM-DD> <icao24>` downloads one aircraft's day into `build/sources/`, which is not committed.
2. Write `data/<id>.json`, starting from an existing recipe. Set the titles, time zone, sources, licence and highlight. Write each event from the recording itself, and check its time against the samples.
3. Run `npm run build:timeline -- data/<id>.json`.
4. Run the tests: `cd ~/gh/0sfs/fly && npm test`. For every published timeline, they check that the index lists it, that it names its sources and licence, that its events and highlight fall within its tracks, that each model is credited and its file is served, and that the file is laid out as the builder writes it.
5. Write `docs/flights/<id>.md`: what the data shows, what it cannot show, the sources compared, and the open questions.
6. Open `https://localhost:7470/replay/?timeline=<id>` from `npm run dev` in `fly`.

## Adding a kind of recording

Each kind of recording is one entry in `TRACK_INPUTS` (`src/trackInputs.ts`):

```ts
interface TrackInput {
  format: string;                  // what a recipe's track names in `format`
  label: string;                   // what the page calls it
  accepts(data: unknown): boolean; // whether a parsed file is one
  toTrack(data: unknown, options: TrackInputOptions): { track: TimelineTrack; startEpochS: number };
}
```

`toTrack` gets the track's `id`, `label` and `sources`, and optionally `fromEpochS`, `toEpochS` and `startEpochS` (the timeline's t = 0, in seconds since 1970). It returns the track, with times in seconds after `startEpochS`, or after its own first sample when no start is given. `src/readsbTrace.ts` is the example: it reads the traces of adsb.lol, ADS-B Exchange and other tar1090 sites.

Once the entry exists, a recipe can name it in `format`, and the Sources tab opens such files from the user's device. Put tests in `tests/`, with a small synthetic recording rather than real data.

## Simulated flights

No timeline has a `simulated` track yet. One would use the same channels as a recorded track, and add the attitude the simulator knows: `headingDeg`, `pitchDeg` and `rollDeg`. A flight the simulator flew could then be compared with the recording, for example to test an explanation of an accident against the path that was observed. The replay draws only the first track for now, so showing both would need the page to draw the others too.
