import "@foss-earth/ui/theme.css";
import "@foss-earth/ui/windowing.css";
import "foss-earth/overview-map.css";
import "./replay.css";
import { createRoot } from "react-dom/client";
import { browserReportDownloads, createTestFeedbackPanel } from "@foss-earth/ui/browser";
import { reportSecrets } from "@foss-earth/ui/diagnostics";
import { createOverviewMap, type OverviewMapHandle } from "foss-earth/shell";
import { RASTER_BASE_MAP_SOURCES } from "foss-earth/runtime";
import { getAppSettings } from "foss-earth/settings";
import type { WindowOverlayHandle } from "@foss-earth/ui/react";
import { ReplayApp } from "./ReplayApp.tsx";
import { createReplayController, readReplayAddress, replayAddressSearch } from "./replayController.ts";
import type { ReplayHost } from "./replayHost.ts";
import { createReplayMapOverlay } from "./replayMapOverlay.ts";
import { createReplayScene, type ReplayScene } from "./replayScene.ts";
import { tabLabel, type TabId } from "./replayTabs.ts";
import { createReplayViewTools, type ReplayViewTools } from "./replayViewTools.ts";
import { poseView } from "./trackPose.ts";

/** FOSS Earth's Interface → Position readout → Altitude unit. */
const ALTITUDE_UNIT_ID = "interface.position.altitudeUnit";

export interface ReplayAppOptions {
  /** What the serving page lends: /fly/'s toolbar. Without it there is none. */
  host?: ReplayHost;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || "from the server"}`);
  return response.json();
}

/**
 * The /replay/ page: a flight timeline played back over FOSS Earth's globe,
 * with the aircraft's model, a map, an altitude chart, its moments and its
 * sources in tabs. ?timeline=<id> opens a published timeline, ?t= a time in
 * it (seconds after its start) and ?rate= a speed; without one, the first
 * published flight opens at its highlight. With a host, the 3D view has the
 * host's toolbar along the bottom and the tabs it opens.
 */
export async function createReplayApp(container: HTMLElement, options: ReplayAppOptions = {}): Promise<{ destroy(): void }> {
  const document = container.ownerDocument;
  const baseUrl = import.meta.env.BASE_URL;
  const settings = getAppSettings();
  container.classList.add("replay-root");
  const canvas = document.createElement("canvas");
  canvas.className = "replay-view";
  canvas.setAttribute("aria-label", "The aircraft over the globe. Drag to look around it; scroll or pinch to move closer.");
  const overlay = document.createElement("div");
  overlay.className = "replay-overlay";
  container.replaceChildren(canvas, overlay);

  const controller = createReplayController({
    baseUrl,
    fetchJson,
    writeAddress(address) {
      const search = replayAddressSearch(window.location.search, address);
      if (search === window.location.search) return;
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    },
    createAudioOutput: () => new Audio(),
    revokeUrl: url => URL.revokeObjectURL(url),
  });
  const stopTitle = controller.subscribe(() => {
    const { session, view, model } = controller.getState();
    const title = session?.timeline.title;
    document.title = title ? `${title} — Flight replay — 0SFS` : "Flight replay — 0SFS";
    // For checks and tests: how far the 3D view and the model have come.
    container.dataset.replayView = view.status;
    container.dataset.replayModel = model.status;
  });
  let scene: ReplayScene | null = null;
  // A test link, such as /replay/test/<name>, adds a Test tab: its checklist and a feedback file to download.
  const testFeedback = createTestFeedbackPanel({
    document, href: window.location.href, now: () => new Date(),
    downloads: browserReportDownloads(URL), secrets: () => reportSecrets(settings),
    providers: {
      replay: () => ({
        ...controller.report(),
        renderer: scene?.runtime.renderer.mode ?? null,
        page: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio, userAgent: navigator.userAgent },
      }),
    },
  });
  // FOSS Earth's shared sheet styles its controls; an ordinary visit has no use for it.
  if (testFeedback) void import("@foss-earth/ui/styles.css");
  const root = createRoot(overlay);
  const overlayApi: { current: WindowOverlayHandle<TabId> | null } = { current: null };
  let mapElement: HTMLElement | null = null;
  let tools: ReplayViewTools | null = null;
  const toolbarTop = () => tools?.toolbarTop() ?? null;
  const render = () => root.render(
    <ReplayApp controller={controller} mapElement={mapElement} testElement={testFeedback?.element ?? null}
      view={tools} overlayApiRef={overlayApi} toolbarTop={toolbarTop} />,
  );
  render();

  const requested = readReplayAddress(window.location.search);
  const flights = controller.loadFlights();
  const opened = requested.timeline
    ? controller.openPublished(requested.timeline, { t: requested.t, rate: requested.rate })
    : flights.then(() => {
      const first = controller.getState().flights?.[0];
      return first ? controller.openPublished(first.id) : undefined;
    });

  // The globe needs WebGPU or WebGL; without either the map, chart and readings still replay the flight.
  try {
    scene = await createReplayScene(canvas, { settings, baseUrl });
    controller.attachScene(scene);
  } catch (error) {
    console.error("The replay's 3D view could not start.", error);
    controller.attachScene(null, errorChain(error));
  }

  const shown = scene;
  if (shown && options.host) {
    try {
      // ADS-B and the radio give altitudes in feet; Interface → Position readout can say otherwise.
      if (settings.has(ALTITUDE_UNIT_ID)) settings.setHostDefault(ALTITUDE_UNIT_ID, "ft", "0SFS replay: ADS-B and the radio give altitudes in feet");
      tools = createReplayViewTools({
        host: options.host, runtime: shown.runtime, settings, seaLevel: shown.seaLevel, parent: container,
        reading: shown.drawnPose,
        playing: () => controller.getState().session?.clock.get().playing ?? false,
        setPlaying(playing) {
          const clock = controller.getState().session?.clock;
          if (playing) clock?.play();
          else clock?.pause();
        },
        toggleTab: tabId => overlayApi.current?.toggleTab(tabId),
        tabLabel,
      });
      render();
    } catch (error) {
      console.error("The replay's toolbar could not start.", error);
    }
  }

  const runtime = scene?.runtime ?? null;
  let map: OverviewMapHandle | null = null;
  try {
    map = createOverviewMap({
      document, sources: RASTER_BASE_MAP_SOURCES, settings,
      basemap: () => runtime
        ? { mode: runtime.status.mode, source: runtime.status.mode === "raster-basemap" ? runtime.status.rasterBaseMap : null }
        : { mode: "fallback", source: null },
      subscribeBasemap: listener => runtime ? runtime.subscribeStatus(() => listener()) : () => {},
      view: () => {
        const pose = controller.mapState()?.pose;
        return pose ? poseView(pose) : null;
      },
      frames: { subscribe: controller.subscribeFrames },
      overlay: createReplayMapOverlay(controller.mapState),
      // A fitted globe makes a sectional a speck. Start close enough to read the chart and the path.
      initialZoomOffset: 9,
    });
    mapElement = map.element;
    render();
  } catch (error) {
    console.error("The replay's map could not start.", error);
  }
  await opened;

  return {
    destroy() {
      stopTitle();
      root.unmount();
      testFeedback?.destroy();
      map?.destroy();
      controller.destroy();
      tools?.destroy();
      scene?.destroy();
      container.classList.remove("replay-root");
      container.replaceChildren();
    },
  };
}

/** An error's message and, after a colon, the messages of what caused it. */
function errorChain(error: unknown): string {
  const messages: string[] = [];
  for (let cause = error; cause !== undefined && cause !== null && messages.length < 4; cause = cause instanceof Error ? cause.cause : undefined) {
    messages.push(cause instanceof Error ? cause.message : String(cause));
  }
  return messages.join(": ");
}
