/** The tabs the 3D view brings, which its toolbar opens. */
export type ReplayViewTabId = "basemap" | "renderer" | "controls";

export type TabId = "replay" | "map" | "moments" | "radio" | "flights" | "sources" | ReplayViewTabId | "test";

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "replay", label: "Replay" },
  { id: "map", label: "Map" },
  { id: "moments", label: "Moments" },
  { id: "radio", label: "Radio" },
  { id: "flights", label: "Flights" },
  { id: "sources", label: "Sources" },
];
/** The 3D view's tabs, named as /fly/ and FOSS Earth name theirs. They open from the toolbar, or from +. */
export const VIEW_TABS: readonly { id: ReplayViewTabId; label: string }[] = [
  { id: "basemap", label: "Basemap" },
  { id: "renderer", label: "Renderer" },
  { id: "controls", label: "Controls" },
];
export const TEST_TAB = { id: "test", label: "Test" } as const;

/** A tab's name, as the tab strip and the toolbar's titles give it. */
export function tabLabel(tabId: TabId): string {
  return [...TABS, ...VIEW_TABS, TEST_TAB].find(tab => tab.id === tabId)!.label;
}
