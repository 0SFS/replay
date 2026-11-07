import type { DeviceHints } from "foss-earth/mapDetailPolicy";
import type { BabylonRuntime } from "foss-earth/runtime";
import type { getAppSettings } from "foss-earth/settings";
import type { MapDetailController, MapSourcePanelOptions, PositionSeaLevelPort, RendererPanelOptions } from "foss-earth/shell";

/**
 * What the page that serves the replay lends it: its toolbar, the ports FOSS
 * Earth's panels take from a host, and the device's hints for World detail.
 * /fly/ lends its own (fly `src/replay/replayHost.ts`), so the replay's toolbar
 * is the flight's and not a copy of it. Without a host there is no toolbar.
 */
export interface ReplayHost {
  /** Puts the toolbar along the bottom of `parent`, over the view. */
  createToolbar(parent: HTMLElement, options: ReplayToolbarOptions): ReplayToolbar;
  createUiHost(settings: ReturnType<typeof getAppSettings>, document: Document): ReplayUiHost;
  /** The device's CPU and memory, which World detail's recommendation is chosen from. */
  deviceHints(): DeviceHints;
}

/** Where the aircraft is drawn and which way it points. */
export interface ReplayToolbarReading {
  latDeg: number;
  lonDeg: number;
  /** The height it is drawn at: above sea level over raster terrain, above the WGS 84 ellipsoid over Google 3D Tiles. */
  altMeters: number;
  headingRad: number;
  pitchRad: number;
}

export interface ReplayToolbarOptions {
  runtime: BabylonRuntime;
  /** The detail controller behind the World detail rail beside the basemap. */
  mapDetail: MapDetailController;
  /** Where sea level is over Google 3D Tiles, whose heights are the ellipsoid's. */
  seaLevel: PositionSeaLevelPort;
  /** Play or pause was pressed. */
  onPlayingChange(playing: boolean): void;
  /** What the toolbar's buttons open. Each shows its tab, or hides it when it is showing. */
  toggle: { fps(): void; renderer(): void; basemap(): void; position(): void; inputMethod(): void };
  /** The tabs the frame rate and the position open, named in their titles. */
  tabNames: { fps: string; position: string };
}

export interface ReplayToolbar {
  /**
   * After each drawn frame: where the aircraft is drawn (null with no flight
   * open) and the height of the terrain under it, or null where none has loaded.
   */
  update(reading: ReplayToolbarReading | null, fps: number | null, playing: boolean, groundHeightMeters: number | null): void;
  /** Draws the Input method section into `container`. Returns an unmount. */
  mountInputMethod(container: HTMLElement): () => void;
  /** The toolbar's top on the screen in CSS pixels, or null while it is not shown: the windows' menus end above it. */
  top(): number | null;
  destroy(): void;
}

/** The ports FOSS Earth's Basemap and Renderer tabs take from their host. */
export interface ReplayUiHost {
  storage: MapSourcePanelOptions["panelStorage"];
  refresh: MapSourcePanelOptions["refresh"];
  /** Tells the refresh's listeners: after each drawn frame. */
  emit(): void;
  publicUi: MapSourcePanelOptions["ui"];
  createTrack: MapSourcePanelOptions["detailPanel"]["createTrack"];
  renderer: RendererPanelOptions["ui"];
  dispose(): void;
}
