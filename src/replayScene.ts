import "@babylonjs/loaders/glTF";
import { Color3, CreateLines, CreateSphere, LoadAssetContainerAsync, Quaternion, StandardMaterial, TransformNode, Vector3, type AssetContainer, type Camera, type LinesMesh, type Scene } from "@babylonjs/core";
import { createCameraFollow } from "@0sfs/aircraft/cameraFollow";
import { createPlaceholderAircraft } from "@0sfs/aircraft/createPlaceholderAircraft";
import { attachChaseCameraInput, glideDecayFrom } from "@0sfs/controls/chaseCameraInput";
import { createFloatingOrigin } from "@0sfs/ground-contact/floatingOrigin";
import { FRAME_PROFILING_IDS, frameProfilingParameters } from "@foss-earth/renderer/settings";
import { geodeticToEcef, DEG_TO_RAD } from "foss-earth/cameraMath";
import { getOrbitInvertSettings, loadInputModePreference, loadInputSensitivityPreference } from "foss-earth/input";
import { createBabylonRuntime, resolveMapRuntimeConfig, whenMeshesReady, type BabylonRuntime } from "foss-earth/runtime";
import type { getAppSettings } from "foss-earth/settings";
import { createBrowserPositionSeaLevelPort, surfaceHeightDatum, type PositionSeaLevelPort } from "foss-earth/shell";
import { sampleIndexAt, type TimelineModel } from "./timeline.ts";
import { createSkyTimeHold } from "./skyTime.ts";
import { poseView, type GeoPoint, type TrackPose } from "./trackPose.ts";

const FPS_PER_KT = 6076.12 / 3600;

/** The trail drawn behind the aircraft and the path drawn ahead of it, in seconds. */
const TRAIL_BEHIND_S = 120;
const TRAIL_AHEAD_S = 60;

/** How wide the dot at each report along the path is, in CSS pixels, at any distance. */
const REPORT_DOT_PX = 5;

/** FOSS Earth's Interface → Position readout → Sea level grid: which EGM2008 grid the geoid comes from. */
const SEA_LEVEL_GRID_ID = "interface.position.seaLevelGrid";

export type ReplayModelState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

export interface ReplaySceneOptions {
  settings: ReturnType<typeof getAppSettings>;
  /** Where the site's files are: import.meta.env.BASE_URL in the app. */
  baseUrl: string;
}

/** What the view follows: an aircraft's pose at any time, and what to draw it with. */
export interface ReplaySubject {
  poseAt(t: number): TrackPose | null;
  /** The times of the track's samples. The path is drawn through the poses at these, so it keeps its shape as the replay moves. */
  times: readonly number[];
  /** Where the sample at an index of `times` was reported, for its dot; null where nothing was reported. */
  reportAt(index: number): GeoPoint | null;
  /** The instant of t = 0, in milliseconds since 1970: the sky is lit for start + t. */
  epochMs?: number;
  model?: TimelineModel;
  onModelState?(state: ReplayModelState): void;
}

export interface ReplayScene {
  runtime: BabylonRuntime;
  /** Where sea level is: the geoid's height above the WGS 84 ellipsoid. */
  seaLevel: PositionSeaLevelPort;
  /**
   * Where the aircraft was last drawn, its height as the globe draws heights:
   * above sea level over raster terrain, above the ellipsoid over Google 3D
   * Tiles. Null with no aircraft followed.
   */
  drawnPose(): TrackPose | null;
  /** Follows another aircraft, or none. Its model replaces the last one's. */
  follow(subject: ReplaySubject | null): void;
  /** Puts the aircraft where it was at `t`. */
  show(t: number): void;
  /** Keep drawing every frame while playing; draw on change while paused. */
  setPlaying(playing: boolean): void;
  destroy(): void;
}

/**
 * The 3D view of a replay: FOSS Earth's globe in the flight's simulator mode,
 * the aircraft at the origin with the world moved around it, a chase camera
 * that follows the direction of travel, and the path behind and ahead.
 */
export async function createReplayScene(canvas: HTMLCanvasElement, options: ReplaySceneOptions): Promise<ReplayScene> {
  // The globe measures its frames by these; each app registers them once.
  if (!options.settings.has(FRAME_PROFILING_IDS.enabled)) {
    options.settings.register(frameProfilingParameters({ tab: "debug", section: "frame-budget" }));
  }
  const map = resolveMapRuntimeConfig({ settings: options.settings });
  const runtime = await createBabylonRuntime(canvas, {
    settings: options.settings,
    googleApiKey: map.googleApiKey,
    preferGoogleTiles: map.preferGoogleTiles,
    rasterBaseMap: map.rasterBaseMap,
    terrainSource: map.terrainSource,
    rasterImagery: map.rasterImagery,
    simMode: true,
  });
  const scene = runtime.scene;
  const worldRoot = runtime.getWorldRoot();
  if (!worldRoot) {
    runtime.destroy();
    throw new Error("The globe gave no world root to move around the aircraft.");
  }
  const origin = createFloatingOrigin(scene, worldRoot);
  // Raster terrain is drawn at its heights above sea level, Google 3D Tiles at
  // theirs above the WGS 84 ellipsoid. A track's heights are the ellipsoid's,
  // so over raster terrain the geoid's height is taken away from them.
  const seaLevel = createBrowserPositionSeaLevelPort();
  const stopWatchingSeaLevel = seaLevel.subscribe?.(() => runtime.requestRender()) ?? (() => {});
  const drawnHeightMeters = (pose: GeoPoint): number => {
    if (surfaceHeightDatum(runtime.status.mode) === "ellipsoid") return pose.altMeters;
    const grid = options.settings.has(SEA_LEVEL_GRID_ID) ? options.settings.get<string>(SEA_LEVEL_GRID_ID) : "15";
    return pose.altMeters - (seaLevel.read({ latDeg: pose.latDeg, lonDeg: pose.lonDeg, heightDatum: "ellipsoid" }, grid).baseMeters ?? 0);
  };
  const aircraft = createPlaceholderAircraft(scene, origin.aircraftRoot);
  const follow = createCameraFollow();
  const trail = createTrail(scene);
  const sky = createSkyTimeHold(options.settings, "A replay shows the sky at the moment it replays.");
  let destroyed = false;
  let shownT = 0;
  let subject: ReplaySubject | null = null;
  let drawnPose: TrackPose | null = null;
  let container: AssetContainer | null = null;
  // The model loads under a hidden node and shows once all of it can draw, in place of the block.
  let holder: TransformNode | null = null;
  // Each follow() counts up, so a model that arrives after the next follow() is dropped.
  let generation = 0;

  // The chase camera glides as /fly's does, with FOSS Earth's Controls → Camera → Glide.
  const cameraInput = attachChaseCameraInput(canvas, {
    getMode: () => loadInputModePreference(new Set(["mouse", "trackpad"])),
    getSensitivity: loadInputSensitivityPreference,
    getOrbitInvert: getOrbitInvertSettings,
    orbit: (yaw, pitch) => { aircraft.orbitChaseCamera(yaw, pitch); runtime.requestRender(); },
    zoom: factor => { aircraft.zoomChaseCamera(factor); runtime.requestRender(); },
    decay: glideDecayFrom(options.settings),
    wake: () => runtime.requestRender(),
    getTouchWheelCooldownMs: () => 250,
  });

  const dropModel = () => {
    container?.dispose();
    container = null;
    holder?.dispose();
    holder = null;
    aircraft.modelRoot.rotationQuaternion = null;
    aircraft.modelRoot.position.setAll(0);
    aircraft.setModelLoaded(false);
  };

  const showModel = (next: ReplaySubject) => {
    const model = next.model;
    if (!model) { next.onModelState?.({ status: "none" }); return; }
    const mine = generation;
    const stale = () => destroyed || mine !== generation;
    next.onModelState?.({ status: "loading" });
    const url = new URL(model.url, new URL(options.baseUrl, window.location.href)).href;
    void LoadAssetContainerAsync(url, scene).then(async loaded => {
      if (stale()) { loaded.dispose(); return; }
      container = loaded;
      const hidden = new TransformNode("replay-model", scene);
      holder = hidden;
      hidden.parent = aircraft.modelRoot;
      hidden.setEnabled(false);
      for (const node of loaded.rootNodes) node.parent = hidden;
      aircraft.modelRoot.rotationQuaternion = Quaternion.RotationYawPitchRoll(model.yawRad ?? 0, 0, 0);
      if (model.offset) aircraft.modelRoot.position.set(model.offset.x, model.offset.y, model.offset.z);
      loaded.addAllToScene();
      for (const mesh of loaded.meshes) mesh.isPickable = false;
      await whenMeshesReady(loaded.meshes);
      if (stale()) return;
      hidden.setEnabled(true);
      aircraft.setModelLoaded(true);
      next.onModelState?.({ status: "ready" });
      runtime.requestRender();
    }).catch((error: unknown) => {
      if (stale()) return;
      next.onModelState?.({ status: "error", message: error instanceof Error ? error.message : String(error) });
    });
  };

  const place = (deltaSeconds: number) => {
    // A paused replay draws on request, so the glide asks for each frame it still has to move.
    if (cameraInput.step()) runtime.requestRender();
    const pose = subject?.poseAt(shownT) ?? null;
    if (!subject || !pose) { drawnPose = null; return; }
    const drawn = { ...pose, altMeters: drawnHeightMeters(pose) };
    drawnPose = drawn;
    runtime.setSimViewState(poseView(drawn));
    origin.apply(drawn);
    const values = pose.sample.values;
    const course = (values.trackDeg ?? pose.headingRad / DEG_TO_RAD) * DEG_TO_RAD;
    const groundFps = (values.groundSpeedKt ?? 0) * FPS_PER_KT;
    const verticalFpm = values.vsFromGeomFpm ?? values.geomRateFpm ?? values.baroRateFpm ?? 0;
    aircraft.setChaseFrame(follow.update("momentum", {
      headingRad: pose.headingRad,
      northVelocityFps: groundFps * Math.cos(course),
      eastVelocityFps: groundFps * Math.sin(course),
      verticalSpeedFps: verticalFpm / 60,
    }, deltaSeconds));
    const frame = origin.getWorldFromEcef();
    if (frame) trail.update(frame.m, subject, shownT, drawnHeightMeters);
  };

  runtime.setSimTick(place);
  runtime.setSimRunning(false);

  return {
    runtime,
    seaLevel,
    drawnPose: () => drawnPose,
    follow(next) {
      generation += 1;
      dropModel();
      subject = next;
      if (!next) drawnPose = null;
      trail.setVisible(next !== null);
      sky.set(next?.epochMs === undefined ? null : next.epochMs + shownT * 1000);
      if (next) {
        showModel(next);
        place(0);
      }
      runtime.requestRender();
    },
    show(t) {
      shownT = t;
      sky.set(subject?.epochMs === undefined ? null : subject.epochMs + t * 1000);
      runtime.requestRender();
    },
    setPlaying(playing) {
      runtime.setSimRunning(playing);
      runtime.requestRender();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      runtime.setSimTick(null);
      cameraInput.detach();
      sky.release();
      stopWatchingSeaLevel();
      seaLevel.dispose();
      trail.dispose();
      container?.dispose();
      origin.dispose();
      runtime.destroy();
    },
  };
}

/**
 * A line through points that are set again each frame. Babylon updates a line
 * in place only with as many points as it was made with, so it is made with
 * room to spare and the unused points repeat the last.
 */
function createPathLine(scene: Scene, name: string, color: Color3, alpha: number) {
  let points: Vector3[] = [];
  let line: LinesMesh | null = null;
  let visible = true;
  return {
    /** Sets the line to the first `count` points that `write` fills in. */
    draw(count: number, write: (points: Vector3[]) => void) {
      if (count > points.length || !line) {
        line?.dispose();
        points = Array.from({ length: Math.max(64, Math.ceil(count * 1.5)) }, () => new Vector3());
        write(points);
        for (let i = count; i < points.length; i++) points[i]!.copyFrom(points[Math.max(0, count - 1)]!);
        line = CreateLines(name, { points, updatable: true }, scene);
        line.color = color;
        line.alpha = alpha;
        line.isPickable = false;
        line.isVisible = visible;
        return;
      }
      write(points);
      for (let i = count; i < points.length; i++) points[i]!.copyFrom(points[Math.max(0, count - 1)]!);
      line = CreateLines(name, { points, instance: line }, scene);
    },
    setVisible(next: boolean) {
      visible = next;
      if (line) line.isVisible = next;
    },
    dispose() {
      line?.dispose();
      line = null;
    },
  };
}

/**
 * Dots at reports along the path: thin instances of one small sphere, scaled
 * each frame to keep their size on screen. Babylon draws a mesh with no thin
 * instances as itself, so it is hidden while there are none.
 */
function createReportDots(scene: Scene, name: string, color: Color3, alpha: number) {
  const dot = CreateSphere(name, { diameter: 1, segments: 4 }, scene);
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.emissiveColor = color;
  material.alpha = alpha;
  dot.material = material;
  dot.isPickable = false;
  // The dots lie along the path, far outside the sphere's own bounds.
  dot.alwaysSelectAsActiveMesh = true;
  dot.isVisible = false;
  let matrices = new Float32Array(0);
  let visible = true;
  let count = 0;
  return {
    /** Puts a dot at each of the first `points` given, `size(point)` across. */
    draw(points: readonly Vector3[], next: number, size: (point: Vector3) => number) {
      if (next * 16 > matrices.length) {
        matrices = new Float32Array(16 * Math.max(64, Math.ceil(next * 1.5)));
        dot.thinInstanceSetBuffer("matrix", matrices, 16, false);
      }
      for (let i = 0; i < next; i++) {
        const point = points[i]!, width = size(point), at = 16 * i;
        matrices.fill(0, at, at + 16);
        matrices[at] = matrices[at + 5] = matrices[at + 10] = width;
        matrices[at + 12] = point.x; matrices[at + 13] = point.y; matrices[at + 14] = point.z; matrices[at + 15] = 1;
      }
      count = next;
      dot.thinInstanceCount = count;
      dot.thinInstanceBufferUpdated("matrix");
      dot.isVisible = visible && count > 0;
    },
    setVisible(next: boolean) {
      visible = next;
      dot.isVisible = visible && count > 0;
    },
    dispose() {
      dot.dispose();
      material.dispose();
    },
  };
}

/**
 * Where the camera is now. The replay places the aircraft and the camera
 * before Babylon brings their matrices up to date for the frame, and a matrix
 * already worked out in the last frame is kept, so they are worked out again
 * here, outermost first.
 */
function cameraPositionNow(camera: Camera): Vector3 {
  const chain: TransformNode[] = [];
  for (let node = camera.parent; node; node = node.parent) if (node instanceof TransformNode) chain.unshift(node);
  for (const node of chain) node.computeWorldMatrix(true);
  camera.getViewMatrix(true);
  return camera.globalPosition;
}

/** A point on the globe in the world about the moving origin, given the ECEF-to-world matrix. */
function toWorld(m: ArrayLike<number>, point: GeoPoint, heightMeters: number, out: Vector3): Vector3 {
  const p = geodeticToEcef(point.latDeg * DEG_TO_RAD, point.lonDeg * DEG_TO_RAD, heightMeters);
  return out.set(
    m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
  );
}

/**
 * The path behind the aircraft in the accent colour and ahead of it faint,
 * redrawn about the moving origin, with a dot at each report. Its corners are
 * the track's samples, so only its ends move as the replay plays. The dots are
 * at the altitudes reported, which the path smooths, so they can sit off it.
 */
function createTrail(scene: Scene) {
  const flown = new Color3(1, 0.42, 0.25);
  const toCome = new Color3(0.85, 0.87, 0.9);
  const behind = createPathLine(scene, "replay-trail-behind", flown, 1);
  const ahead = createPathLine(scene, "replay-trail-ahead", toCome, 0.45);
  const behindDots = createReportDots(scene, "replay-reports-behind", flown, 1);
  const aheadDots = createReportDots(scene, "replay-reports-ahead", toCome, 0.6);
  const times: number[] = [];
  let dotPoints: Vector3[] = [];

  /** The sample times from `from` to `to`, with the two ends themselves, where the track has poses. */
  const span = (sampleTimes: readonly number[], from: number, to: number) => {
    times.length = 0;
    if (sampleTimes.length === 0) return;
    const start = Math.max(from, sampleTimes[0]!);
    const end = Math.min(to, sampleTimes.at(-1)!);
    if (end < start) return;
    times.push(start);
    for (let i = sampleIndexAt(sampleTimes, start) + 1; i < sampleTimes.length && sampleTimes[i]! < end; i++) {
      if (sampleTimes[i]! > start) times.push(sampleTimes[i]!);
    }
    if (end > start) times.push(end);
  };

  const line = (path: ReturnType<typeof createPathLine>, m: ArrayLike<number>, subject: ReplaySubject, heightMeters: (point: GeoPoint) => number) => {
    const poses = times.map(time => subject.poseAt(time)).filter(pose => pose !== null);
    path.draw(poses.length, points => {
      poses.forEach((pose, i) => toWorld(m, pose, heightMeters(pose), points[i]!));
    });
  };

  /** Dots at the reports from index `first` up to time `to`. */
  const dots = (target: ReturnType<typeof createReportDots>, m: ArrayLike<number>, subject: ReplaySubject, first: number, to: number,
    heightMeters: (point: GeoPoint) => number, size: (point: Vector3) => number) => {
    let count = 0;
    for (let i = Math.max(0, first); i < subject.times.length && subject.times[i]! <= to; i++) {
      const report = subject.reportAt(i);
      if (!report) continue;
      if (count === dotPoints.length) dotPoints = [...dotPoints, ...Array.from({ length: Math.max(64, dotPoints.length) }, () => new Vector3())];
      toWorld(m, report, heightMeters(report), dotPoints[count++]!);
    }
    target.draw(dotPoints, count, size);
  };

  return {
    update(m: ArrayLike<number>, subject: ReplaySubject, t: number, heightMeters: (point: GeoPoint) => number) {
      span(subject.times, t - TRAIL_BEHIND_S, t);
      line(behind, m, subject, heightMeters);
      span(subject.times, t, t + TRAIL_AHEAD_S);
      line(ahead, m, subject, heightMeters);

      // Metres per CSS pixel at a metre from the camera, whose field of view is vertical.
      const camera = scene.activeCamera;
      const engine = scene.getEngine();
      const pixels = engine.getRenderingCanvas()?.clientHeight || engine.getRenderHeight();
      const eye = camera ? cameraPositionNow(camera) : null;
      const perPixel = camera ? 2 * Math.tan(camera.fov / 2) / pixels : 0;
      const size = (point: Vector3) => (eye ? Vector3.Distance(eye, point) * perPixel * REPORT_DOT_PX : 0);
      const from = t - TRAIL_BEHIND_S;
      const firstBehind = sampleIndexAt(subject.times, from);
      dots(behindDots, m, subject, firstBehind >= 0 && subject.times[firstBehind]! >= from ? firstBehind : firstBehind + 1, t, heightMeters, size);
      dots(aheadDots, m, subject, sampleIndexAt(subject.times, t) + 1, t + TRAIL_AHEAD_S, heightMeters, size);
    },
    setVisible(visible: boolean) {
      for (const part of [behind, ahead, behindDots, aheadDots]) part.setVisible(visible);
    },
    dispose() {
      for (const part of [behind, ahead, behindDots, aheadDots]) part.dispose();
    },
  };
}
