import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { serializeTldrawJson, Tldraw, type Editor, type TLComponents } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";
import { summarizeWhiteboard, type WhiteboardShape } from "./whiteboard/scene";
import type { WhiteboardPanelHandle, WhiteboardSnapshot } from "./whiteboard/types";

type WhiteboardPanelProps = {
  onSnapshotChange: (snapshot: WhiteboardSnapshot) => void;
  readOnly?: boolean;
};

const WHITEBOARD_COMPONENTS: TLComponents = {
  PageMenu: null
};

const WHITEBOARD_OPTIONS = {
  maxPages: 1
};

// Vite turns these official tldraw asset imports into same-origin build files.
const LOCAL_TLDRAW_ASSET_URLS = getAssetUrlsByImport();

function describeShapes(editor: Editor): WhiteboardShape[] {
  return editor.getCurrentPageShapesSorted().map((shape) => {
    const bounds = editor.getShapePageBounds(shape);
    const text = editor.getShapeUtil(shape).getText(shape);
    const bindings = editor.getBindingsInvolvingShape(shape).map((binding) => ({
      type: binding.type,
      fromId: binding.fromId,
      toId: binding.toId
    }));

    return {
      id: shape.id,
      type: shape.type,
      parentId: shape.parentId,
      text,
      bounds: bounds
        ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h }
        : { x: shape.x, y: shape.y, width: 0, height: 0 },
      bindings
    };
  });
}

export const WhiteboardPanel = forwardRef<WhiteboardPanelHandle, WhiteboardPanelProps>(
  function WhiteboardPanel({ onSnapshotChange, readOnly = false }, ref) {
    const editorRef = useRef<Editor | null>(null);
    const stopListeningRef = useRef<(() => void) | null>(null);
    const revisionRef = useRef(0);
    const notifyTimerRef = useRef<number | null>(null);

    useEffect(() => () => {
      stopListeningRef.current?.();
      if (notifyTimerRef.current !== null) window.clearTimeout(notifyTimerRef.current);
    }, []);

    useEffect(() => {
      editorRef.current?.updateInstanceState({ isReadonly: readOnly });
    }, [readOnly]);

    function handleMount(editor: Editor) {
      stopListeningRef.current?.();
      editorRef.current = editor;
      editor.updateInstanceState({ isReadonly: readOnly });
      stopListeningRef.current = editor.store.listen(() => {
        revisionRef.current += 1;
        const changedAt = Date.now();
        if (notifyTimerRef.current !== null) window.clearTimeout(notifyTimerRef.current);
        notifyTimerRef.current = window.setTimeout(() => {
          const shapes = describeShapes(editor);
          onSnapshotChange({
            revision: revisionRef.current,
            changedAt,
            elementCount: shapes.length,
            summary: summarizeWhiteboard(shapes)
          });
        }, 250);
      }, { scope: "document" });
    }

    useImperativeHandle(ref, () => ({
      async exportPng() {
        const editor = editorRef.current;
        if (!editor) return null;
        const shapes = editor.getCurrentPageShapes();
        if (shapes.length === 0) return null;
        const bounds = editor.getCurrentPageBounds();
        const largestSide = bounds ? Math.max(bounds.w, bounds.h) : 0;
        const scale = largestSide > 1280 ? 1280 / largestSide : 1;
        const { url } = await editor.toImageDataUrl(shapes, {
          format: "png",
          background: true,
          padding: 24,
          pixelRatio: 1,
          scale
        });
        return url;
      },
      async exportSceneJson() {
        const editor = editorRef.current;
        if (!editor || editor.getCurrentPageShapes().length === 0) return null;
        return serializeTldrawJson(editor);
      },
      getSnapshot() {
        const editor = editorRef.current;
        const shapes = editor ? describeShapes(editor) : [];
        return {
          revision: revisionRef.current,
          changedAt: Date.now(),
          elementCount: shapes.length,
          summary: summarizeWhiteboard(shapes)
        };
      },
      reset() {
        const editor = editorRef.current;
        if (notifyTimerRef.current !== null) window.clearTimeout(notifyTimerRef.current);
        notifyTimerRef.current = null;
        if (editor) editor.deleteShapes(Array.from(editor.getCurrentPageShapeIds()));
        revisionRef.current = 0;
      }
    }), []);

    return (
      <div className="whiteboard-canvas tldraw__editor" aria-label="Interview whiteboard">
        <Tldraw
          components={WHITEBOARD_COMPONENTS}
          colorScheme="light"
          licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
          assetUrls={LOCAL_TLDRAW_ASSET_URLS}
          onMount={handleMount}
          options={WHITEBOARD_OPTIONS}
        />
      </div>
    );
  }
);
