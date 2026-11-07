# Flight replay

The `/replay/` page plays back a flight from a timeline file, on any device, with no simulation running. The aircraft flies over FOSS Earth's globe, drawn with its 3D model. Beside it are a map, an altitude chart, the readings at each moment, the moments that matter, the radio, and the sources the timeline was made from.

The fly app serves the page and runs this package's tests. From the `fly` directory, `npm run dev` serves it at <https://localhost:7470/replay/>, and `npm test` includes the tests.

## Using the page

- `/replay/?timeline=<id>` opens a published timeline at its highlight. `&t=` opens it at a time, in seconds after its start, and `&rate=` sets the speed. The address follows the replay while it is paused, so it always links to what is on screen.
- Space plays and pauses. The arrow keys step 5 s, or 30 s with Shift. A click or drag on the chart goes to that time.
- Drag in the 3D view to look around the aircraft. Scroll or pinch to move closer.
- Along the bottom of the 3D view is /fly/'s toolbar: play and pause, the frame rate, the renderer, where the aircraft is, the input method, World detail, the download speed, and the basemap with its credit. Its buttons open the Renderer, Map, Controls and Basemap tabs, where the basemap, elevation, detail and renderer are chosen. The fly app lends the toolbar (`fly/src/replay/replayHost.ts`), so the two pages share one.
- The Radio tab plays the air traffic control recording, where the timeline has one, in time with the replay, and lists what was said. It can move the recording by tenths of a second, and can open a sound file from your own device, such as a LiveATC archive.
- The Sources tab opens a timeline or a readsb trace from your own device. The file is read in the browser, never uploaded.

The aircraft's pitch and bank come from the timeline when it has them. ADS-B does not carry them, so for a recorded flight they are estimated from the path, and the page says so.

## Timelines

A timeline is one JSON file: the tracks of one or more aircraft, sampled over time, with the moments, sources, licence and caveats that go with them. [The timeline format](docs/timeline-format.md) describes it, and explains how to add an incident or a new kind of recording.

Published timelines are in `public/replay/timelines/` and listed in its `index.json`. Each is built from a recipe in `data/` and a recording that is downloaded, not committed:

```sh
cd ~/gh/0sfs/replay
npm run fetch:adsblol -- 2026-11-01 a9ab17
npm run build:timeline -- data/N722BD-2026-11-01.json
```

## Flights

- [N722BD, 1 November 2026](docs/flights/N722BD-2026-11-01.md): a Learjet 60 that crashed in Palm Beach County, Florida. What the ADS-B data shows, and what it cannot.

## Licences

- The code is under [AGPL-3.0-only](LICENSE).
- Each timeline states its own licence. N722BD's is the Open Database License 1.0, because it is derived from adsb.lol's ODbL data.
- 3D models keep their own licences, and the Sources tab credits each one. The Learjet 60 is OUTPISTON's model under CC BY-NC-SA 4.0, from the `Learjet-60` package beside this one.

## Community

- [Code of conduct](https://github.com/0SFS/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/0SFS/.github/blob/main/CONTRIBUTING.md)
- [License](LICENSE)
- [Security](https://github.com/0SFS/.github/blob/main/SECURITY.md)
