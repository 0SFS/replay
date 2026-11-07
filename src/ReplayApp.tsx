import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { AdoptedElement, WindowOverlay, type WindowOverlayHandle } from "@foss-earth/ui/react";
import { browserOverlayGeometry, browserOverlayLayout } from "@foss-earth/ui/browser";
import { ProfileChart, type ProfileSeries } from "./ProfileChart.tsx";
import { liveAtcStartMs, SOUND_RATES, soundTimeAt, timelineTimeOf, transcriptLineAt, type RadioState, type RadioTrack } from "./radioPlayer.ts";
import { REPLAY_RATES, type ReplayClockState } from "./replayClock.ts";
import type { ReplayController, ReplaySession } from "./replayController.ts";
import { formatChannelValue } from "./replayFormat.ts";
import { TABS, TEST_TAB, VIEW_TABS, type TabId } from "./replayTabs.ts";
import type { ReplayViewTools } from "./replayViewTools.ts";
import type { TimelineEvent, TimelineTrack } from "./timeline.ts";

/** Seconds an arrow key moves the replay; with Shift, the longer step. */
const SEEK_STEP_S = 5;
const SEEK_LONG_STEP_S = 30;
/** A track whose last report is further back than this says so. */
const STALE_REPORT_S = 3;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function useClock(session: ReplaySession): ReplayClockState {
  return useSyncExternalStore(session.clock.subscribe, session.clock.get);
}

function useRadio(session: ReplaySession): { radio: RadioState; sound: RadioTrack | null } {
  const radio = useSyncExternalStore(session.radio.subscribe, session.radio.getState);
  return { radio, sound: radio.tracks.find(track => track.id === radio.selected) ?? null };
}

/** The last event at or before `t`. */
function currentEvent(events: readonly TimelineEvent[], t: number): TimelineEvent | null {
  let found: TimelineEvent | null = null;
  for (const event of events) {
    if (event.t > t) break;
    found = event;
  }
  return found;
}

/** Up to two altitude channels for the chart, in the order the track lists them. */
function altitudeSeries(track: TimelineTrack): ProfileSeries[] {
  const preferred = ["altGeomFt", "altBaroFt"];
  const ids = [...preferred.filter(id => track.channels[id]), ...Object.keys(track.channels).filter(id => !preferred.includes(id) && track.channels[id]!.unit === "ft")];
  return ids.slice(0, 2).map((id, index) => ({ id, label: track.channels[id]!.label, slot: (index + 1) as 1 | 2 }));
}

function rateLabel(rate: number): string {
  return `${rate}×`;
}

/** What the 3D view's tabs show, once it has started with a toolbar. */
export type ReplayViewTabs = Pick<ReplayViewTools, "basemap" | "renderer" | "mountInputMethod">;

export interface ReplayAppProps {
  controller: ReplayController;
  /** The overview map's element, adopted by the Map tab. */
  mapElement: HTMLElement | null;
  /** A test link's checklist, adopted by a Test tab that only a test link has. */
  testElement?: HTMLElement | null;
  /** The Basemap, Renderer and Controls tabs, which only a 3D view with a toolbar has. */
  view?: ReplayViewTabs | null;
  /** Where the windows are opened and closed from outside, as the toolbar does. */
  overlayApiRef?: { current: WindowOverlayHandle<TabId> | null };
  /** The top of the toolbar along the screen's bottom, which the windows' menus end above; null without one. */
  toolbarTop?: () => number | null;
}

const NO_TOOLBAR = () => null;

export function ReplayApp({ controller, mapElement, testElement = null, view = null, overlayApiRef, toolbarTop = NO_TOOLBAR }: ReplayAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const ownOverlayApi = useRef<WindowOverlayHandle<TabId> | null>(null);
  const overlayApi = overlayApiRef ?? ownOverlayApi;
  const storage = useState(memoryStorage)[0];
  const opened = useMemo(() => testElement ? [...TABS, TEST_TAB] : TABS, [testElement]);
  const tabs = useMemo(() => view ? [...TABS, ...VIEW_TABS, ...(testElement ? [TEST_TAB] : [])] : opened, [opened, view, testElement]);
  const geometry = useMemo(() => browserOverlayGeometry(window, toolbarTop), [toolbarTop]);

  // The page's tabs in one window, the replay's own selected, or a test link's
  // checklist. The 3D view's wait for the toolbar or +.
  useLayoutEffect(() => {
    const overlay = overlayApi.current;
    if (!overlay) return;
    for (const tab of opened) overlay.openTabInSlot(tab.id, "primary");
    overlay.openOrSelectTab(testElement ? "test" : "replay");
  }, [overlayApi, opened, testElement]);

  const session = state.session;
  useEffect(() => {
    if (!session) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, button, a, [contenteditable='true']")) return;
      const { t } = session.clock.get();
      const step = event.shiftKey ? SEEK_LONG_STEP_S : SEEK_STEP_S;
      if (event.key === " ") session.clock.toggle();
      else if (event.key === "ArrowLeft") session.clock.seek(t - step);
      else if (event.key === "ArrowRight") session.clock.seek(t + step);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  const renderTab = (tabId: TabId) => {
    if (tabId === "test") return testElement ? <AdoptedElement element={testElement} className="replay-tab" /> : null;
    // FOSS Earth's panels fill an element tab, as the Map tab's sheet does.
    if (tabId === "basemap") return view ? <AdoptedElement element={view.basemap} className="foss-earth-element-tab" /> : null;
    if (tabId === "renderer") return view ? <AdoptedElement element={view.renderer} className="foss-earth-element-tab" /> : null;
    if (tabId === "controls") return view ? <ControlsTab mountInputMethod={view.mountInputMethod} /> : null;
    if (tabId === "flights") return <FlightsTab controller={controller} />;
    if (!session) {
      return <div className="replay-tab">
        <Status controller={controller} />
        {state.loading ? null : <p className="replay-muted">Choose a flight in the Flights tab, or open a file in Sources.</p>}
        {tabId === "sources" ? <OpenFile controller={controller} /> : null}
      </div>;
    }
    if (tabId === "replay") return <ReplayTab controller={controller} session={session} />;
    // FOSS Earth's map sheet fills an element tab: the class is its, not this page's.
    if (tabId === "map") return mapElement ? <AdoptedElement element={mapElement} className="foss-earth-element-tab" /> : <p className="replay-tab replay-muted">The map is starting.</p>;
    if (tabId === "moments") return <MomentsTab session={session} />;
    if (tabId === "radio") return <RadioTab session={session} />;
    return <SourcesTab controller={controller} session={session} />;
  };

  return <WindowOverlay<TabId>
    tabDefinitions={tabs}
    renderTabContent={renderTab}
    context={{ active: false, ready: true, baseOnlyTabs: new Set(), contextOnlyTabs: new Set(), entryTabId: "replay" }}
    restorableTabs={new Set(tabs.map(tab => tab.id))}
    storage={storage}
    geometry={geometry}
    logSize={{ getWidth: () => null, subscribe: () => () => {} }}
    layoutPort={browserOverlayLayout(document.documentElement)}
    overlayApiRef={overlayApi}
  />;
}

/** How the mouse, trackpad or touch move the camera: the toolbar's input method, as /fly/'s Controls tab has it. */
function ControlsTab({ mountInputMethod }: { mountInputMethod: ReplayViewTabs["mountInputMethod"] }) {
  const ref = useRef<HTMLDivElement>(null);
  // Its radios fire change only once they are in the document.
  useEffect(() => ref.current ? mountInputMethod(ref.current) : undefined, [mountInputMethod]);
  return <div className="replay-tab">
    <section>
      <h2>Input method</h2>
      <div ref={ref} />
    </section>
  </div>;
}

/** What is loading, what failed, and how the 3D view and model are. */
function Status({ controller }: { controller: ReplayController }) {
  const { loading, error, view, model, session } = useSyncExternalStore(controller.subscribe, controller.getState);
  const modelLabel = session?.track.aircraft?.model?.label ?? "aircraft";
  return <>
    {loading ? <p className="replay-status" role="status">Loading {loading}…</p> : null}
    {error ? <p className="replay-status replay-status--error" role="alert">{error}</p> : null}
    {view.status === "error" ? <p className="replay-status replay-status--warning" role="status">The 3D view could not start ({view.message}). The map, the chart and the readings still work.</p> : null}
    {model.status === "loading" ? <p className="replay-status" role="status">Loading the {modelLabel} model…</p> : null}
    {model.status === "error" ? <p className="replay-status replay-status--warning" role="status">The {modelLabel} model could not load ({model.message}); a block stands in for it.</p> : null}
  </>;
}

function ReplayTab({ controller, session }: { controller: ReplayController; session: ReplaySession }) {
  const { t, playing, rate } = useClock(session);
  const { timeline, track, span, clock, format } = session;
  const highlight = timeline.highlight;
  const [whole, setWhole] = useState(!highlight);
  const pose = session.poseAt(t);
  const event = currentEvent(timeline.events, t);
  const series = altitudeSeries(track);
  const sampleIndex = pose?.sample.index ?? -1;
  const reportT = sampleIndex >= 0 ? track.samples.t[sampleIndex]! : null;
  const sinceReport = reportT === null ? null : t - reportT;
  const chartSpan = whole || !highlight ? span : highlight;

  return <div className="replay-tab replay-tab--replay">
    <header className="replay-heading">
      <h1>{timeline.title}</h1>
      {timeline.subtitle ? <p>{timeline.subtitle}</p> : null}
    </header>
    <Status controller={controller} />
    <div className="replay-transport">
      <button type="button" className="replay-play" onClick={() => clock.toggle()} aria-label={playing ? "Pause" : "Play"}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M4 2.5v11l9-5.5z" />}
        </svg>
      </button>
      <label className="replay-rate">
        <span className="replay-visually-hidden">Speed</span>
        <select value={rate} onChange={(change: ChangeEvent<HTMLSelectElement>) => clock.setRate(Number(change.target.value))}>
          {REPLAY_RATES.map(option => <option key={option} value={option}>{rateLabel(option)}</option>)}
        </select>
      </label>
      <div className="replay-time">
        <strong>{format.local(t)}</strong>
        <span>{format.utc(t)}</span>
      </div>
    </div>
    <input className="replay-scrubber" type="range" min={span.start} max={span.end} step={0.1} value={t}
      aria-label="Time in the flight" aria-valuetext={format.local(t)}
      onChange={change => clock.seek(Number(change.target.value))} />
    <p className="replay-moment" aria-live="polite">
      {event ? <><span className="replay-muted">{format.short(event.t)}</span> {event.title}</> : <span className="replay-muted">Before the first moment</span>}
    </p>
    <SaidNow session={session} t={t} />
    <ProfileChart track={track} series={series} span={chartSpan} t={t} events={timeline.events}
      highlight={whole ? highlight : undefined} formatTime={format.short} onSeek={clock.seek} />
    {highlight ? <div className="replay-segmented" role="group" aria-label="Chart span">
      <button type="button" aria-pressed={!whole} onClick={() => setWhole(false)}>{format.short(highlight.start)}–{format.short(highlight.end)}</button>
      <button type="button" aria-pressed={whole} onClick={() => setWhole(true)}>Whole flight</button>
    </div> : null}
    <Readings track={track} values={pose?.sample.values ?? null} sinceReport={sinceReport} attitude={pose?.attitude ?? null} />
  </div>;
}

/** Every channel of the followed track at the replay's time, with a mark on what was worked out rather than reported. */
function Readings({ track, values, sinceReport, attitude }: { track: TimelineTrack; values: Record<string, number | null> | null; sinceReport: number | null; attitude: "recorded" | "estimated" | null }) {
  return <section className="replay-readings" aria-label="Readings">
    {values?.extrapolated === 1
      ? <p className="replay-status replay-status--warning">Extrapolated: past the last report, the path is continued at that report's ground speed, turn rate and vertical rate. Nothing here was reported.</p>
      : sinceReport !== null && sinceReport > STALE_REPORT_S
        ? <p className="replay-status replay-status--warning">No report for {sinceReport.toFixed(1)} s: values between reports are interpolated.</p> : null}
    {attitude === "estimated" ? <p className="replay-muted">The model's pitch and bank are estimated from the path, not recorded.</p> : null}
    {track.aircraft?.model?.note ? <p className="replay-muted">{track.aircraft.model.note}</p> : null}
    <dl>
      {Object.entries(track.channels).map(([id, channel]) => <div key={id} title={channel.derived ?? channel.note}>
        <dt>{channel.label}{channel.derived ? <span className="replay-badge">derived</span> : null}</dt>
        <dd>{formatChannelValue(id, channel, values?.[id])}</dd>
      </div>)}
    </dl>
  </section>;
}

function MomentsTab({ session }: { session: ReplaySession }) {
  const { t } = useClock(session);
  const { timeline, clock, format } = session;
  const now = currentEvent(timeline.events, t);
  return <div className="replay-tab">
    <ol className="replay-moments">
      {timeline.events.map(event => <li key={`${event.t}-${event.title}`} aria-current={event === now ? "step" : undefined}>
        <button type="button" onClick={() => clock.seek(event.t)}>
          <span className="replay-moments__time">{format.local(event.t)}</span>
          <span className="replay-moments__title">{event.title}</span>
          {event.detail ? <span className="replay-moments__detail">{event.detail}</span> : null}
        </button>
      </li>)}
    </ol>
  </div>;
}

/** What the radio recording says at the replay's time, under the current moment, when it has a transcript. */
function SaidNow({ session, t }: { session: ReplaySession; t: number }) {
  const { sound } = useRadio(session);
  if (!sound?.transcript.length) return null;
  const at = soundTimeAt(sound, t);
  const line = transcriptLineAt(sound, at);
  return <p className="replay-said">
    <span className="replay-muted">Radio</span>{" "}
    {line ? <q>{line.text}</q> : <span className="replay-muted">{at === null ? (t < timelineTimeOf(sound, 0) ? `from ${session.format.short(timelineTimeOf(sound, 0))}` : "ended") : "—"}</span>}
  </p>;
}

const OFFSET_STEPS_S = [-1, -0.1, 0.1, 1] as const;

function radioStatusText(radio: RadioState, sound: RadioTrack, t: number, format: ReplaySession["format"]): string {
  switch (radio.status) {
    case "off": return "Sound is off.";
    case "none": return "";
    case "outside": return t < timelineTimeOf(sound, 0)
      ? `The recording starts at ${format.local(timelineTimeOf(sound, 0))}.`
      : "The recording has ended.";
    case "paused": return "It plays when the replay plays.";
    case "speed": return `Sound plays at ${SOUND_RATES.min}× to ${SOUND_RATES.max}×. At this speed the recording is silent.`;
    case "loading": return "Loading the recording…";
    case "playing": return "Playing with the replay.";
    case "blocked": return "The browser held the sound back. Press play again.";
    case "unsupported": return "This browser plays none of the recording's formats.";
    case "error": return "The recording could not be loaded. Turn the sound off and on to try again.";
  }
}

function RadioTab({ session }: { session: ReplaySession }) {
  const { t } = useClock(session);
  const { radio, sound } = useRadio(session);
  const { clock, format, timeline } = session;
  const line = sound ? transcriptLineAt(sound, soundTimeAt(sound, t)) : null;
  const sourceIds = new Set(sound?.audio?.sources ?? []);
  const sources = timeline.sources.filter(source => sourceIds.has(source.id));
  const startMs = Date.parse(timeline.start);
  return <div className="replay-tab replay-radio">
    {sound ? <section>
      <h2>{sound.label}</h2>
      <p className="replay-muted">
        From {format.local(timelineTimeOf(sound, 0))}{sound.duration !== null ? ` to ${format.local(timelineTimeOf(sound, sound.duration))}` : ""}.
        {sources.map(source => <span key={source.id}> <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a>{source.license ? `, ${source.license}` : ""}.</span>)}
      </p>
      {sound.audio?.note ? <p className="replay-muted">{sound.audio.note}</p> : null}
      <div className="replay-segmented" role="group" aria-label="Sound">
        <button type="button" aria-pressed={radio.enabled} onClick={() => session.radio.setEnabled(true)}>Sound on</button>
        <button type="button" aria-pressed={!radio.enabled} onClick={() => session.radio.setEnabled(false)}>Off</button>
      </div>
      <p className="replay-status" role="status">{radioStatusText(radio, sound, t, format)}</p>
      {sound.audio ? <p className="replay-muted">{sound.audio.alignment.method} Within about ±{sound.audio.alignment.uncertaintyS} s.</p> : <label className="replay-radio__start">
        <span>Starts at (UTC)</span>
        <input type="datetime-local" step="1" value={new Date(startMs + sound.t * 1000).toISOString().slice(0, 19)}
          onChange={change => {
            const ms = Date.parse(`${change.target.value}Z`);
            if (Number.isFinite(ms)) session.radio.setStart(sound.id, (ms - startMs) / 1000);
          }} />
      </label>}
      <div className="replay-radio__offset">
        <span>Move it <span className="replay-muted">{sound.offsetS >= 0 ? "+" : "−"}{Math.abs(sound.offsetS).toFixed(1)} s</span></span>
        <div className="replay-segmented" role="group" aria-label="Move the recording against the replay">
          {OFFSET_STEPS_S.map(step => <button key={step} type="button" aria-label={`${step > 0 ? "Later" : "Earlier"} by ${Math.abs(step)} s`}
            onClick={() => session.radio.setOffset(sound.id, Math.round((sound.offsetS + step) * 10) / 10)}>
            {step > 0 ? "+" : "−"}{Math.abs(step)} s
          </button>)}
          <button type="button" disabled={sound.offsetS === 0} onClick={() => session.radio.setOffset(sound.id, 0)}>Reset</button>
        </div>
      </div>
    </section> : <p className="replay-muted">This timeline has no recording to play along. You can open one below.</p>}
    {radio.tracks.length > 1 ? <section>
      <h2>Recordings</h2>
      <div className="replay-segmented replay-segmented--wrap" role="group" aria-label="Recording">
        {radio.tracks.map(track => <button key={track.id} type="button" aria-pressed={track.id === radio.selected} onClick={() => session.radio.select(track.id)}>{track.label}</button>)}
      </div>
    </section> : null}
    {sound?.transcript.length ? <section>
      <h2>What was said</h2>
      {sound.audio?.transcriptNote ? <p className="replay-muted">{sound.audio.transcriptNote}</p> : null}
      <ol className="replay-moments">
        {sound.transcript.map(said => <li key={said.at} aria-current={said === line ? "step" : undefined}>
          <button type="button" onClick={() => clock.seek(timelineTimeOf(sound, said.at))}>
            <span className="replay-moments__time">{format.local(timelineTimeOf(sound, said.at))}</span>
            <span className="replay-moments__title">{said.text}</span>
          </button>
        </li>)}
      </ol>
    </section> : null}
    <section>
      <h2>Open a recording</h2>
      <p className="replay-muted">A sound file from this device, such as a LiveATC archive. A LiveATC name, such as KZMA-Sec-Nov-01-2026-1730Z.mp3, says when it starts; any other file starts where the replay is. It stays on this device.</p>
      <input type="file" accept="audio/*" onChange={change => {
        const file = change.target.files?.[0];
        change.target.value = "";
        if (!file) return;
        const heardMs = liveAtcStartMs(file.name);
        const at = heardMs === null ? clock.get().t : (heardMs - startMs) / 1000;
        session.radio.addLocal({ name: file.name, type: file.type, url: URL.createObjectURL(file) }, at);
        session.radio.setEnabled(true);
      }} />
    </section>
  </div>;
}

function FlightsTab({ controller }: { controller: ReplayController }) {
  const { flights, session } = useSyncExternalStore(controller.subscribe, controller.getState);
  if (flights === null) return <p className="replay-tab replay-muted">Loading the list of flights…</p>;
  if (flights.length === 0) return <p className="replay-tab replay-muted">No flights are published yet.</p>;
  return <div className="replay-tab">
    <ul className="replay-flights">
      {flights.map(flight => <li key={flight.id}>
        <a href={`?timeline=${encodeURIComponent(flight.id)}`} aria-current={session?.publishedId === flight.id ? "page" : undefined}
          onClick={click => {
            if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0) return;
            click.preventDefault();
            void controller.openPublished(flight.id);
          }}>
          <strong>{flight.title}</strong>
          <span>{new Date(flight.start).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}</span>
          {flight.subtitle ? <span className="replay-muted">{flight.subtitle}</span> : null}
        </a>
      </li>)}
    </ul>
  </div>;
}

function SourcesTab({ controller, session }: { controller: ReplayController; session: ReplaySession }) {
  const { timeline, format } = session;
  const models = timeline.tracks.flatMap(track => track.aircraft?.model ? [{ track, model: track.aircraft.model }] : []);
  return <div className="replay-tab replay-sources">
    <section>
      <h2>{timeline.title}</h2>
      <p className="replay-muted">{format.date(session.span.start)}{timeline.timeZone ? `, times in ${timeline.timeZone.replace(/_/g, " ")} and UTC` : ", times in UTC"}</p>
    </section>
    {timeline.notes?.length ? <section>
      <h2>Before drawing conclusions</h2>
      <ul>{timeline.notes.map(note => <li key={note}>{note}</li>)}</ul>
    </section> : null}
    <section>
      <h2>Data</h2>
      <ul>
        {timeline.sources.map(source => <li key={source.id}>
          {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : source.name}
          {source.license ? <> · {source.licenseUrl ? <a href={source.licenseUrl} target="_blank" rel="noreferrer">{source.license}</a> : source.license}</> : null}
          {source.attribution ? <div>{source.attribution}</div> : null}
          {source.retrieved ? <div className="replay-muted">Retrieved {source.retrieved}</div> : null}
          {source.note ? <div className="replay-muted">{source.note}</div> : null}
        </li>)}
      </ul>
      {timeline.license ? <p>This timeline: <a href={timeline.license.url} target="_blank" rel="noreferrer">{timeline.license.id}</a>. {timeline.license.attribution}</p> : null}
    </section>
    {models.length ? <section>
      <h2>3D model{models.length > 1 ? "s" : ""}</h2>
      <ul>
        {models.map(({ track, model }) => <li key={track.id}>
          {model.label}{model.credit ? <> by {model.credit.artist}, {model.credit.sourceUrl
            ? <a href={model.credit.sourceUrl} target="_blank" rel="noreferrer">{model.credit.licence}</a> : model.credit.licence}</> : null}
          {model.note ? <div>{model.note}</div> : null}
          {model.credit?.note ? <div className="replay-muted">{model.credit.note}</div> : null}
        </li>)}
      </ul>
      <p className="replay-muted">The model shows where the aircraft was and which way it moved. Its pitch and bank are estimated from the path unless the timeline recorded them.</p>
    </section> : null}
    <OpenFile controller={controller} />
  </div>;
}

function OpenFile({ controller }: { controller: ReplayController }) {
  return <section>
    <h2>Open a file</h2>
    <p className="replay-muted">A flight timeline, or an ADS-B trace as readsb writes it (trace_full_*.json). It stays on this device.</p>
    <input type="file" accept=".json,application/json" onChange={change => {
      const file = change.target.files?.[0];
      if (file) void controller.openFile(file);
      change.target.value = "";
    }} />
  </section>;
}
