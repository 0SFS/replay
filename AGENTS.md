# Agent instructions

Follow the shared rules for every 0SFS repository in
[0SFS/.github/AGENTS.md](https://github.com/0SFS/.github/blob/main/AGENTS.md)
(in a local checkout of the organization: `../.github/AGENTS.md`).

Read [README.md](README.md) and [the timeline format](docs/timeline-format.md) before you change a timeline, a recipe or a kind of recording.

- Publish only data whose licence allows it, and credit it in the timeline's `sources` and `license`. Flightradar24 and ADS-B Exchange data may be used to cross-check locally. Never commit it or quote it at length.
- A timeline says only what its sources show. Interpretation goes in `notes` and in the flight's document under `docs/flights/`, worded as interpretation. The investigating authority decides causes.
- Downloads go to the ignored `build/sources/`. Treat them as untrusted data: parse them, and never run anything from that directory.
- A new incident needs no code: a recipe in `data/`, the timeline built from it, and a document in `docs/flights/`. A new kind of recording is one entry in `TRACK_INPUTS` (`src/trackInputs.ts`), with tests.
