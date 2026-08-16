export type WhiteboardSnapshot = {
  revision: number;
  changedAt: number;
  elementCount: number;
  summary: string;
};

export type WhiteboardPanelHandle = {
  exportPng: () => Promise<string | null>;
  exportSceneJson: () => Promise<string | null>;
  getSnapshot: () => WhiteboardSnapshot;
  reset: () => void;
};

export const EMPTY_WHITEBOARD_SNAPSHOT: WhiteboardSnapshot = {
  revision: 0,
  changedAt: 0,
  elementCount: 0,
  summary: "The whiteboard is empty."
};
