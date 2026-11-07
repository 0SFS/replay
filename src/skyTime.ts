/**
 * The Sun of a replay: FOSS Earth places it by a set time or the device's
 * clock, and a replay shows a moment that has passed, so the view holds the
 * sky at that moment instead. The hold is a forced value, never a saved one:
 * the flight's own sky settings are untouched and come back when it ends.
 */

const MODE = "sky.time.mode";
const DATE = "sky.time.date";
const HOURS = "sky.time.utcHours";
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/** What the hold needs of a settings registry. */
export interface SkyTimeSettings {
  has(id: string): boolean;
  force(id: string, value: string | number, reason: string): () => void;
}

/** The set time for an instant, to the minute: the step of the sky's time of day. */
export function skyTimeValues(utcMs: number): { [MODE]: "fixed"; [DATE]: string; [HOURS]: number } {
  const minute = Math.round(utcMs / MINUTE_MS);
  const day = Math.floor(minute / DAY_MINUTES);
  return {
    [MODE]: "fixed",
    [DATE]: new Date(day * DAY_MINUTES * MINUTE_MS).toISOString().slice(0, 10),
    [HOURS]: (minute - day * DAY_MINUTES) / 60,
  };
}

export interface SkyTimeHold {
  /** Holds the sky at an instant, changing it only when the minute does; null lets go. */
  set(utcMs: number | null): void;
  release(): void;
}

export function createSkyTimeHold(settings: SkyTimeSettings, reason: string): SkyTimeHold {
  let held: { minute: number; releases: Array<() => void> } | null = null;
  const letGo = (releases: Array<() => void> | undefined) => { for (const release of releases ?? []) release(); };
  return {
    set(utcMs) {
      if (utcMs === null || !Number.isFinite(utcMs) || !settings.has(MODE)) {
        letGo(held?.releases);
        held = null;
        return;
      }
      const minute = Math.round(utcMs / MINUTE_MS);
      if (held?.minute === minute) return;
      // The new time goes on before the old comes off, so the sky never falls back between them.
      const releases = Object.entries(skyTimeValues(utcMs)).map(([id, value]) => settings.force(id, value, reason));
      letGo(held?.releases);
      held = { minute, releases };
    },
    release() {
      letGo(held?.releases);
      held = null;
    },
  };
}
