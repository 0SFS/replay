import "@foss-earth/ui/styles.css";
import { applyRendererChoice, RASTER_BASE_MAP_SOURCES, setMapSourcePreference, setTerrainSourcePreference, TERRAIN_SOURCES, type BabylonRuntime } from "foss-earth/runtime";
import type { getAppSettings } from "foss-earth/settings";
import { clearMapCache, connectMapDetailRuntime, createMapDetailController, createMapSourcePanel, createRendererPanel, inspectMapCache, type PositionSeaLevelPort } from "foss-earth/shell";
import type { ReplayHost, ReplayToolbarReading } from "./replayHost.ts";
import type { ReplayViewTabId } from "./replayTabs.ts";

export interface ReplayViewToolsOptions {
  host: ReplayHost;
  runtime: BabylonRuntime;
  settings: ReturnType<typeof getAppSettings>;
  seaLevel: PositionSeaLevelPort;
  /** Where the toolbar goes, over the view. */
  parent: HTMLElement;
  /** Where the aircraft is drawn now, or null with no flight open. */
  reading(): ReplayToolbarReading | null;
  playing(): boolean;
  setPlaying(playing: boolean): void;
  /** Shows a tab, or hides it when it is showing: the view's own, or the page's Map. */
  toggleTab(tabId: ReplayViewTabId | "map"): void;
  /** The tabs' names, for the toolbar's titles. */
  tabLabel(tabId: ReplayViewTabId | "map"): string;
}

export interface ReplayViewTools {
  /** The Basemap and Renderer tabs' contents. */
  basemap: HTMLElement;
  renderer: HTMLElement;
  /** Draws the Input method section into the Controls tab. Returns an unmount. */
  mountInputMethod(container: HTMLElement): () => void;
  /** The toolbar's top on the screen, or null while it is not shown. */
  toolbarTop(): number | null;
  destroy(): void;
}

/**
 * The 3D view's toolbar and the tabs it opens, as /fly/ has them: play and
 * pause, the frame rate, the renderer, the position, World detail and the
 * basemap with its download speed and credit. The toolbar is the host's;
 * Basemap, World detail and Renderer are FOSS Earth's shared panels.
 */
export function createReplayViewTools(options: ReplayViewToolsOptions): ReplayViewTools {
  const { host, runtime, settings } = options;
  const document = options.parent.ownerDocument;
  // One detail controller: the toolbar's rail and the Basemap tab's Detail
  // group both show it, and it alone sets how detailed the globe is drawn.
  const mapDetail = createMapDetailController({ settings, deviceHints: host.deviceHints, googleRecommendation: "device-hints" });
  const disconnectMapDetail = connectMapDetailRuntime(mapDetail, runtime);
  const ui = host.createUiHost(settings, document);
  let detailPanels = 0;
  const basemap = createMapSourcePanel({
    document, InputElement: HTMLInputElement, ui: ui.publicUi, refresh: ui.refresh, panelStorage: ui.storage,
    cache: { inspect: () => Promise.resolve().then(inspectMapCache), clear: () => Promise.resolve().then(clearMapCache), nowMs: () => performance.now(), refreshIntervalMs: () => settings.get<number>("map.cache.inspectInterval"), rowLimit: () => settings.get<number>("map.cache.rowsShown") },
    detailPanel: { createTrack: ui.createTrack, idSuffix: () => `replay-${++detailPanels}` },
    detail: mapDetail,
    settings,
    rasterSources: RASTER_BASE_MAP_SOURCES,
    terrainSources: TERRAIN_SOURCES,
    // The globe follows map.source.*: saving a choice switches the map.
    onMapSourceChange: selected => setMapSourcePreference(selected, settings),
    onTerrainSourceChange: selected => setTerrainSourcePreference(selected, settings),
  });
  // A renderer changes only when the page starts, so a choice is saved and the
  // page reloads, at the same moment of the flight: the address keeps it.
  const renderer = createRendererPanel({
    ui: ui.renderer,
    renderer: runtime.renderer,
    onChange: force => applyRendererChoice(force, settings, window.location, window.localStorage),
    settings,
  });
  const toolbar = host.createToolbar(options.parent, {
    runtime, mapDetail, seaLevel: options.seaLevel,
    onPlayingChange: options.setPlaying,
    toggle: {
      fps: () => options.toggleTab("renderer"),
      renderer: () => options.toggleTab("renderer"),
      basemap: () => options.toggleTab("basemap"),
      position: () => options.toggleTab("map"),
      inputMethod: () => options.toggleTab("controls"),
    },
    tabNames: { fps: options.tabLabel("renderer"), position: options.tabLabel("map") },
  });

  const update = () => {
    const reading = options.reading();
    const ground = reading ? runtime.surface.sample(reading.latDeg, reading.lonDeg)?.heightMeters ?? null : null;
    toolbar.update(reading, runtime.engine.getFps(), options.playing(), ground);
    ui.emit();
  };
  const frames = runtime.scene.onAfterRenderObservable.add(update);
  const stopStatus = runtime.subscribeStatus(status => basemap.update(status));
  basemap.update(runtime.status);
  update();

  return {
    basemap: basemap.element,
    renderer: renderer.element,
    mountInputMethod: container => toolbar.mountInputMethod(container),
    toolbarTop: () => toolbar.top(),
    destroy() {
      runtime.scene.onAfterRenderObservable.remove(frames);
      stopStatus();
      toolbar.destroy();
      renderer.destroy();
      basemap.destroy();
      disconnectMapDetail();
      mapDetail.dispose();
      ui.dispose();
    },
  };
}
