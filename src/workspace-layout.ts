export type WorkspaceWindowId = 'editor' | 'preview' | 'assistant';

export type WorkspaceWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

export type WorkspaceLayout = Record<WorkspaceWindowId, WorkspaceWindowRect>;

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'mermaid-flow-editor.workspace-layout.v1';
export const WORKSPACE_COMPACT_BREAKPOINT = 900;

export const WORKSPACE_COORDINATE_LIMIT = 100_000;
export const WORKSPACE_WINDOW_SIZE_LIMIT = 50_000;

export const MIN_WINDOW_SIZES: Record<
  WorkspaceWindowId,
  { width: number; height: number }
> = {
  editor: { width: 300, height: 260 },
  preview: { width: 300, height: 260 },
  assistant: { width: 300, height: 320 }
};

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function createDefaultWorkspaceLayout(
  containerWidth: number,
  containerHeight: number
): WorkspaceLayout {
  const width = Math.max(1, containerWidth);
  const height = Math.max(1, containerHeight);
  const gap = 12;
  const assistantWidth = clamp(width * 0.32, 320, 380);
  const paneWidth = Math.max(300, (width - assistantWidth - gap * 4) / 2);
  const windowHeight = Math.max(0, Math.min(height - gap * 2, height * 0.9));

  return {
    editor: {
      x: gap,
      y: gap,
      width: paneWidth,
      height: windowHeight,
      zIndex: 1
    },
    preview: {
      x: gap * 2 + paneWidth,
      y: gap,
      width: paneWidth,
      height: windowHeight,
      zIndex: 2
    },
    assistant: {
      x: width - assistantWidth - gap,
      y: gap,
      width: assistantWidth,
      height: windowHeight,
      zIndex: 3
    }
  };
}

export function clampWorkspaceRect(
  id: WorkspaceWindowId,
  rect: WorkspaceWindowRect,
  enforceMinimumSize = true
): WorkspaceWindowRect {
  const minimum = MIN_WINDOW_SIZES[id];
  const minimumWidth = enforceMinimumSize ? minimum.width : 1;
  const minimumHeight = enforceMinimumSize ? minimum.height : 1;

  return {
    x: clamp(rect.x, -WORKSPACE_COORDINATE_LIMIT, WORKSPACE_COORDINATE_LIMIT),
    y: clamp(rect.y, -WORKSPACE_COORDINATE_LIMIT, WORKSPACE_COORDINATE_LIMIT),
    width: clamp(rect.width, minimumWidth, WORKSPACE_WINDOW_SIZE_LIMIT),
    height: clamp(rect.height, minimumHeight, WORKSPACE_WINDOW_SIZE_LIMIT),
    zIndex: clamp(Number.isFinite(rect.zIndex) ? rect.zIndex : 1, 1, 1000)
  };
}

export function clampWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    editor: clampWorkspaceRect('editor', layout.editor, false),
    preview: clampWorkspaceRect('preview', layout.preview, false),
    assistant: clampWorkspaceRect('assistant', layout.assistant, false)
  };
}

function isWindowRect(value: unknown): value is WorkspaceWindowRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Partial<WorkspaceWindowRect>;
  return [rect.x, rect.y, rect.width, rect.height, rect.zIndex].every(
    (item) => typeof item === 'number' && Number.isFinite(item)
  );
}

export function parseStoredWorkspaceLayout(value: string | null): WorkspaceLayout | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceLayout>;
    if (
      !isWindowRect(parsed.editor) ||
      !isWindowRect(parsed.preview) ||
      !isWindowRect(parsed.assistant)
    ) {
      return null;
    }
    return clampWorkspaceLayout({
      editor: parsed.editor,
      preview: parsed.preview,
      assistant: parsed.assistant
    });
  } catch {
    return null;
  }
}

export function bringWorkspaceWindowToFront(
  layout: WorkspaceLayout,
  id: WorkspaceWindowId
): WorkspaceLayout {
  const ids: WorkspaceWindowId[] = ['editor', 'preview', 'assistant'];
  const ordered = ids.sort((left, right) => layout[left].zIndex - layout[right].zIndex);
  if (ordered[ordered.length - 1] === id) return layout;

  const nextOrder = [...ordered.filter((item) => item !== id), id];
  const next = { ...layout };
  nextOrder.forEach((item, index) => {
    next[item] = { ...layout[item], zIndex: index + 1 };
  });
  return next;
}
