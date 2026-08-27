import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import Editor, { type OnMount } from '@monaco-editor/react';
import mermaid from 'mermaid';
import { SYSTEM_PROMPT } from '../shared/system-prompt.js';
import {
  formatMermaidParseError,
  normalizeMermaidOutput,
  validateMermaidEnvelope
} from '../shared/mermaid-output.js';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Download,
  FileImage,
  FileText,
  FileUp,
  GripHorizontal,
  LayoutTemplate,
  Loader2,
  Maximize2,
  Minus,
  Palette,
  Plus,
  PlugZap,
  RefreshCw,
  Save,
  Square,
  Sparkles
} from 'lucide-react';
import './styles.css';
import {
  bringWorkspaceWindowToFront,
  clamp,
  clampWorkspaceLayout,
  clampWorkspaceRect,
  createDefaultWorkspaceLayout,
  parseStoredWorkspaceLayout,
  WORKSPACE_COMPACT_BREAKPOINT,
  WORKSPACE_COORDINATE_LIMIT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKSPACE_WINDOW_SIZE_LIMIT,
  type WorkspaceLayout,
  type WorkspaceWindowId,
  type WorkspaceWindowRect
} from './workspace-layout';

const SAMPLE = `flowchart TD
  A([開始]) --> B{需求是否清楚?}
  B -- 是 --> C[撰寫 Mermaid]
  B -- 否 --> D[和 AI 討論流程]
  D --> C
  C --> E[預覽與修正]
  E --> F([匯出])
`;

const STORAGE_KEY = 'mermaid-flow-editor.api-config';
const SESSION_API_KEY = 'mermaid-flow-editor.api-key';
const MODEL_LIST_TIMEOUT_MS = 20_000;
const MODEL_TEST_TIMEOUT_MS = 185_000;
const CHAT_TIMEOUT_MS = 185_000;

function readStoredWorkspaceLayout() {
  try {
    return parseStoredWorkspaceLayout(
      window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

function persistWorkspaceLayout(layout: WorkspaceLayout) {
  try {
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Persistence is optional when browser storage is disabled.
  }
}

function clearStoredWorkspaceLayout() {
  try {
    window.localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  } catch {
    // Reset still works in memory when browser storage is disabled.
  }
}

type ApiConfig = {
  apiUrl: string;
  apiKey: string;
  model: string;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  rawOutput?: {
    content: string;
    truncated: boolean;
  };
};

const EXPORT_BACKGROUNDS = {
  white: { label: '白色', color: '#ffffff' },
  black: { label: '黑色', color: '#000000' },
  transparent: { label: '透明（PDF 仍為白頁）', color: 'transparent' }
} as const;

type ExportBackground = keyof typeof EXPORT_BACKGROUNDS;

type ApiResponse = {
  data: unknown;
  text: string;
  isJson: boolean;
};

class ApiRequestError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details;
  }
}

type PreparedSvg = {
  content: string;
  width: number;
  height: number;
};

const EXPORT_SCALES = [
  { value: 1, label: '1x' },
  { value: 2, label: '2x' },
  { value: 4, label: '4x' }
] as const;

type ExportScale = (typeof EXPORT_SCALES)[number]['value'];

type WindowInteraction = {
  id: WorkspaceWindowId;
  mode: 'drag' | 'resize';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startRect: WorkspaceWindowRect;
  workspaceScale: number;
};

type WorkspaceCamera = {
  scale: number;
  x: number;
  y: number;
};

type WorkspacePanInteraction = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

type DiagramViewport = {
  scale: number;
  x: number;
  y: number;
  mode: 'fit' | 'custom';
};

type DiagramSize = {
  width: number;
  height: number;
};

type DiagramPanInteraction = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

const MIN_PREVIEW_SCALE = 0.01;
const MAX_PREVIEW_SCALE = 5;
const PREVIEW_FIT_PADDING = 28;
const MIN_WORKSPACE_SCALE = 0.5;
const MIN_WORKSPACE_CAMERA_SCALE = 0.000001;
const MAX_WORKSPACE_SCALE = 2;
const WORKSPACE_CAMERA_OFFSET_LIMIT =
  (WORKSPACE_COORDINATE_LIMIT + WORKSPACE_WINDOW_SIZE_LIMIT) * MAX_WORKSPACE_SCALE +
  10_000;
const WORKSPACE_CAMERA_STORAGE_KEY = 'mermaid-flow-editor.workspace-camera.v1';

function parseModelIds(payload: unknown) {
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : [];

  return [...new Set(items
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        return (item as { id: string }).id;
      }
      return '';
    })
    .filter(Boolean))];
}

function getAssistantContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function getServerNormalizationRepairs(payload: unknown) {
  if (!payload || typeof payload !== 'object') return [];
  const metadata = (payload as { mermaidOutput?: unknown }).mermaidOutput;
  if (!metadata || typeof metadata !== 'object') return [];
  const repairs = (metadata as { repairs?: unknown }).repairs;
  return Array.isArray(repairs)
    ? repairs.filter((repair): repair is string => typeof repair === 'string')
    : [];
}

type MermaidOutputMetadata = {
  rawContent: string;
  normalizedContent: string;
  rawContentTruncated: boolean;
  normalizedContentTruncated: boolean;
};

function getMermaidOutputMetadata(payload: unknown): MermaidOutputMetadata | null {
  if (!payload || typeof payload !== 'object') return null;
  const metadata = (payload as { mermaidOutput?: unknown }).mermaidOutput;
  if (!metadata || typeof metadata !== 'object') return null;
  const value = metadata as Partial<MermaidOutputMetadata>;
  if (typeof value.rawContent !== 'string' || typeof value.normalizedContent !== 'string') {
    return null;
  }
  return {
    rawContent: value.rawContent,
    normalizedContent: value.normalizedContent,
    rawContentTruncated: value.rawContentTruncated === true,
    normalizedContentTruncated: value.normalizedContentTruncated === true
  };
}

function getRawMermaidOutput(metadata: MermaidOutputMetadata | null, fallback: string) {
  const rawContent = metadata?.rawContent || fallback;
  return rawContent
    ? { content: rawContent, truncated: metadata?.rawContentTruncated === true }
    : undefined;
}

function downloadBlob(name: string, type: string, content: BlobPart) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function downloadDataUrl(name: string, url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function sanitizeFileBaseName(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'diagram';
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(`請求逾時（${Math.round(timeoutMs / 1_000)} 秒）。`);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function readApiResponse(response: Response): Promise<ApiResponse> {
  const text = await response.text();
  if (!text.trim()) return { data: null, text: '', isJson: false };

  try {
    return { data: JSON.parse(text) as unknown, text, isJson: true };
  } catch {
    return { data: null, text, isJson: false };
  }
}

function getApiErrorMessage(response: Response, payload: ApiResponse, fallback: string) {
  if (payload.data && typeof payload.data === 'object') {
    const body = payload.data as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
    if (body.error && typeof body.error === 'object') {
      const nestedMessage = (body.error as { message?: unknown }).message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage;
    }
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  }

  const plainText = payload.text.replace(/\s+/g, ' ').trim().slice(0, 500);
  return plainText || `${fallback}（HTTP ${response.status}）`;
}

async function requestApiJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
) {
  return runWithTimeout(
    async (requestSignal) => {
      const response = await fetch(url, { ...init, signal: requestSignal });
      const payload = await readApiResponse(response);

      if (!response.ok) {
        throw new ApiRequestError(
          getApiErrorMessage(response, payload, 'API 請求失敗'),
          response.status,
          payload.data
        );
      }
      if (!payload.text) throw new Error('API 回傳空內容。');
      if (!payload.isJson) {
        throw new Error(`API 回傳非 JSON 格式：${payload.text.slice(0, 200)}`);
      }

      return payload.data;
    },
    timeoutMs,
    signal
  );
}

function parseSvgDimensions(svg: SVGSVGElement) {
  const viewBox = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);

  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { x: viewBox[0], y: viewBox[1], width: viewBox[2], height: viewBox[3] };
  }

  const width = Number.parseFloat(svg.getAttribute('width') || '');
  const height = Number.parseFloat(svg.getAttribute('height') || '');
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { x: 0, y: 0, width, height };
  }

  throw new Error('無法判斷 Mermaid SVG 的自然尺寸。');
}

function getRenderedSvgSize(svgMarkup: string): DiagramSize | null {
  if (!svgMarkup) return null;
  try {
    const document = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    const svg = document.documentElement;
    if (svg.tagName.toLowerCase() !== 'svg' || document.querySelector('parsererror')) {
      return null;
    }
    const dimensions = parseSvgDimensions(svg as unknown as SVGSVGElement);
    return { width: dimensions.width, height: dimensions.height };
  } catch {
    return null;
  }
}

function fitDiagramViewport(
  viewportWidth: number,
  viewportHeight: number,
  diagram: DiagramSize
): DiagramViewport {
  const availableWidth = Math.max(1, viewportWidth - PREVIEW_FIT_PADDING * 2);
  const availableHeight = Math.max(1, viewportHeight - PREVIEW_FIT_PADDING * 2);
  const scale = clamp(
    Math.min(availableWidth / diagram.width, availableHeight / diagram.height, 1),
    MIN_PREVIEW_SCALE,
    MAX_PREVIEW_SCALE
  );
  return {
    scale,
    x: (viewportWidth - diagram.width * scale) / 2,
    y: (viewportHeight - diagram.height * scale) / 2,
    mode: 'fit'
  };
}

function fitDiagramWidthViewport(
  viewportWidth: number,
  viewportHeight: number,
  diagram: DiagramSize
): DiagramViewport {
  const availableWidth = Math.max(1, viewportWidth - PREVIEW_FIT_PADDING * 2);
  const scale = clamp(
    availableWidth / diagram.width,
    MIN_PREVIEW_SCALE,
    MAX_PREVIEW_SCALE
  );
  return {
    scale,
    x: (viewportWidth - diagram.width * scale) / 2,
    y: PREVIEW_FIT_PADDING,
    mode: 'custom'
  };
}

function centerDiagramViewport(
  viewportWidth: number,
  viewportHeight: number,
  diagram: DiagramSize,
  scale: number
): DiagramViewport {
  return {
    scale,
    x: (viewportWidth - diagram.width * scale) / 2,
    y: (viewportHeight - diagram.height * scale) / 2,
    mode: 'custom'
  };
}

function clampDiagramPosition(
  viewport: DiagramViewport,
  viewportWidth: number,
  viewportHeight: number,
  diagram: DiagramSize
): DiagramViewport {
  const minimumVisible = 48;
  const scaledWidth = diagram.width * viewport.scale;
  const scaledHeight = diagram.height * viewport.scale;
  const minimumX = Math.min(minimumVisible - scaledWidth, viewportWidth - minimumVisible);
  const maximumX = Math.max(minimumVisible - scaledWidth, viewportWidth - minimumVisible);
  const minimumY = Math.min(minimumVisible - scaledHeight, viewportHeight - minimumVisible);
  const maximumY = Math.max(minimumVisible - scaledHeight, viewportHeight - minimumVisible);
  return {
    ...viewport,
    x: clamp(viewport.x, minimumX, maximumX),
    y: clamp(viewport.y, minimumY, maximumY)
  };
}

function normalizeWorkspaceCamera(camera: WorkspaceCamera): WorkspaceCamera {
  return {
    scale: clamp(
      Number.isFinite(camera.scale) ? camera.scale : 1,
      MIN_WORKSPACE_CAMERA_SCALE,
      MAX_WORKSPACE_SCALE
    ),
    x: clamp(
      Number.isFinite(camera.x) ? camera.x : 0,
      -WORKSPACE_CAMERA_OFFSET_LIMIT,
      WORKSPACE_CAMERA_OFFSET_LIMIT
    ),
    y: clamp(
      Number.isFinite(camera.y) ? camera.y : 0,
      -WORKSPACE_CAMERA_OFFSET_LIMIT,
      WORKSPACE_CAMERA_OFFSET_LIMIT
    )
  };
}

function readStoredWorkspaceCamera(): WorkspaceCamera | null {
  try {
    const value = window.localStorage.getItem(WORKSPACE_CAMERA_STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<WorkspaceCamera>;
    if (![parsed.scale, parsed.x, parsed.y].every((item) => typeof item === 'number')) {
      return null;
    }
    return normalizeWorkspaceCamera(parsed as WorkspaceCamera);
  } catch {
    return null;
  }
}

function persistWorkspaceCamera(camera: WorkspaceCamera) {
  try {
    window.localStorage.setItem(WORKSPACE_CAMERA_STORAGE_KEY, JSON.stringify(camera));
  } catch {
    // Persistence is optional when browser storage is disabled.
  }
}

function clearStoredWorkspaceCamera() {
  try {
    window.localStorage.removeItem(WORKSPACE_CAMERA_STORAGE_KEY);
  } catch {
    // Reset still works in memory when browser storage is disabled.
  }
}

function prepareExportSvg(svgMarkup: string, background: ExportBackground): PreparedSvg {
  const document = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.tagName.toLowerCase() !== 'svg' || document.querySelector('parsererror')) {
    throw new Error('Mermaid SVG 內容無法解析。');
  }

  const dimensions = parseSvgDimensions(svg as unknown as SVGSVGElement);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', String(dimensions.width));
  svg.setAttribute('height', String(dimensions.height));
  svg.setAttribute('viewBox', `${dimensions.x} ${dimensions.y} ${dimensions.width} ${dimensions.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const style = svg.getAttribute('style') || '';
  const normalizedStyle = style
    .replace(/(?:^|;)\s*max-(?:width|height)\s*:[^;]*/gi, '')
    .replace(/(?:^|;)\s*background(?:-color)?\s*:[^;]*/gi, '')
    .replace(/^;+|;+$/g, '')
    .trim();
  svg.setAttribute('style', `${normalizedStyle}${normalizedStyle ? ';' : ''}display:block;max-width:none;max-height:none`);

  if (background !== 'transparent') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(dimensions.x));
    rect.setAttribute('y', String(dimensions.y));
    rect.setAttribute('width', String(dimensions.width));
    rect.setAttribute('height', String(dimensions.height));
    rect.setAttribute('fill', EXPORT_BACKGROUNDS[background].color);
    rect.setAttribute('class', 'export-background');
    rect.setAttribute(
      'style',
      `fill:${EXPORT_BACKGROUNDS[background].color} !important;stroke:none !important`
    );
    svg.insertBefore(rect, svg.firstChild);
  }

  return {
    content: new XMLSerializer().serializeToString(svg),
    width: dimensions.width,
    height: dimensions.height
  };
}

async function renderSvgToPng(
  svg: PreparedSvg,
  requestedPixelRatio = 2,
  backgroundColor?: string
) {
  const maxCanvasDimension = 16_384;
  const maxCanvasPixels = 16_000_000;
  const pixelRatio = Math.min(
    requestedPixelRatio,
    maxCanvasDimension / svg.width,
    maxCanvasDimension / svg.height,
    Math.sqrt(maxCanvasPixels / (svg.width * svg.height))
  );
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new Error('圖表尺寸過大，無法建立匯出圖片。');
  }

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'left:-100000px',
    'top:0',
    `width:${svg.width}px`,
    `height:${svg.height}px`,
    'overflow:hidden'
  ].join(';');
  host.innerHTML = svg.content;
  document.body.appendChild(host);

  try {
    const svgElement = host.querySelector('svg');
    if (!svgElement) throw new Error('找不到可匯出的 SVG 節點。');
    const { toPng } = await import('html-to-image');
    return await toPng(svgElement as unknown as HTMLElement, {
      width: svg.width,
      height: svg.height,
      canvasWidth: svg.width,
      canvasHeight: svg.height,
      pixelRatio,
      backgroundColor,
      skipAutoScale: false
    });
  } finally {
    host.remove();
  }
}

function loadStoredApiConfig(): ApiConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ApiConfig>) : {};
    return {
      apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl : '',
      apiKey: window.sessionStorage.getItem(SESSION_API_KEY) || '',
      model: typeof parsed.model === 'string' ? parsed.model : ''
    };
  } catch {
    return { apiUrl: '', apiKey: '', model: '' };
  }
}

function App() {
  const [code, setCodeState] = useState(SAMPLE);
  const [renderedSvg, setRenderedSvg] = useState('');
  const [syntaxError, setSyntaxError] = useState('');
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => loadStoredApiConfig());
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState('請輸入 API URL 與 Key');
  const [modelRefreshVersion, setModelRefreshVersion] = useState(0);
  const [chatInput, setChatInput] = useState('幫我產生一個客服工單處理流程圖');
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [isCallingAi, setIsCallingAi] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [exportBaseName, setExportBaseName] = useState('diagram');
  const [exportBackground, setExportBackground] = useState<ExportBackground>('white');
  const [exportScale, setExportScale] = useState<ExportScale>(2);
  const [renderedCode, setRenderedCode] = useState('');
  const [renderedTheme, setRenderedTheme] = useState('');
  const [isRendering, setIsRendering] = useState(true);
  const [renderVersion, setRenderVersion] = useState(0);
  const [exporting, setExporting] = useState<'svg' | 'png' | 'pdf' | null>(null);
  const [exportStatus, setExportStatus] = useState('');
  const [windowLayout, setWindowLayout] = useState<WorkspaceLayout>(() => {
    const stored = readStoredWorkspaceLayout();
    return (
      stored ||
      createDefaultWorkspaceLayout(window.innerWidth, Math.max(1, window.innerHeight - 76))
    );
  });
  const [isCompactWorkspace, setIsCompactWorkspace] = useState(
    () => window.innerWidth <= WORKSPACE_COMPACT_BREAKPOINT
  );
  const [diagramViewport, setDiagramViewport] = useState<DiagramViewport>({
    scale: 1,
    x: 0,
    y: 0,
    mode: 'fit'
  });
  const [workspaceCamera, setWorkspaceCamera] = useState<WorkspaceCamera>(
    () =>
      (readStoredWorkspaceLayout() && readStoredWorkspaceCamera()) || {
        scale: 1,
        x: 0,
        y: 0
      }
  );
  const [isPanningDiagram, setIsPanningDiagram] = useState(false);
  const [isPanningWorkspace, setIsPanningWorkspace] = useState(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef(SAMPLE);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const modelTestControllerRef = useRef<AbortController | null>(null);
  const chatControllerRef = useRef<AbortController | null>(null);
  const windowInteractionRef = useRef<WindowInteraction | null>(null);
  const workspacePanInteractionRef = useRef<WorkspacePanInteraction | null>(null);
  const diagramPanInteractionRef = useRef<DiagramPanInteraction | null>(null);
  const diagramViewportRef = useRef(diagramViewport);
  const workspaceCameraRef = useRef(workspaceCamera);
  const windowLayoutRef = useRef(windowLayout);
  const shouldPersistWorkspaceLayoutRef = useRef(
    !isCompactWorkspace || Boolean(readStoredWorkspaceLayout())
  );
  const diagramSize = useMemo(() => getRenderedSvgSize(renderedSvg), [renderedSvg]);
  const activeWindowId = useMemo(() => {
    const ids: WorkspaceWindowId[] = ['editor', 'preview', 'assistant'];
    return ids.sort(
      (left, right) => windowLayout[left].zIndex - windowLayout[right].zIndex
    )[ids.length - 1];
  }, [windowLayout]);

  const updateCode = (value: string) => {
    codeRef.current = value;
    setCodeState(value);
  };

  const updateDiagramViewport = (action: React.SetStateAction<DiagramViewport>) => {
    setDiagramViewport((current) => {
      const next = typeof action === 'function' ? action(current) : action;
      diagramViewportRef.current = next;
      return next;
    });
  };

  const updateWorkspaceLayout = (action: React.SetStateAction<WorkspaceLayout>) => {
    setWindowLayout((current) => {
      const next = typeof action === 'function' ? action(current) : action;
      windowLayoutRef.current = next;
      return next;
    });
  };

  const updateWorkspaceCamera = (action: React.SetStateAction<WorkspaceCamera>) => {
    setWorkspaceCamera((current) => {
      const next = typeof action === 'function' ? action(current) : action;
      const normalized = normalizeWorkspaceCamera(next);
      workspaceCameraRef.current = normalized;
      return normalized;
    });
  };

  const resetWorkspaceCamera = () => {
    updateWorkspaceCamera({ scale: 1, x: 0, y: 0 });
  };

  const zoomWorkspace = (factor: number, clientX?: number, clientY?: number) => {
    const desktop = desktopRef.current;
    if (!desktop || isCompactWorkspace) return;
    const bounds = desktop.getBoundingClientRect();
    const anchorX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const anchorY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;

    updateWorkspaceCamera((current) => {
      const minimumScale =
        current.scale < MIN_WORKSPACE_SCALE
          ? MIN_WORKSPACE_CAMERA_SCALE
          : MIN_WORKSPACE_SCALE;
      const nextScale = clamp(current.scale * factor, minimumScale, MAX_WORKSPACE_SCALE);
      const worldX = (anchorX - current.x) / current.scale;
      const worldY = (anchorY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: anchorX - worldX * nextScale,
        y: anchorY - worldY * nextScale
      };
    });
  };

  const showWorkspaceAtOriginalScale = () => {
    zoomWorkspace(1 / workspaceCameraRef.current.scale);
  };

  const fitWorkspaceToWindows = () => {
    const desktop = desktopRef.current;
    if (!desktop || isCompactWorkspace) return;
    const rects = Object.values(windowLayoutRef.current);
    const minimumX = Math.min(...rects.map((rect) => rect.x));
    const minimumY = Math.min(...rects.map((rect) => rect.y));
    const maximumX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maximumY = Math.max(...rects.map((rect) => rect.y + rect.height));
    const contentWidth = Math.max(1, maximumX - minimumX);
    const contentHeight = Math.max(1, maximumY - minimumY);
    const padding = 48;
    const availableWidth = Math.max(1, desktop.clientWidth - padding * 2);
    const availableHeight = Math.max(1, desktop.clientHeight - padding * 2);
    const scale = clamp(
      Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
      MIN_WORKSPACE_CAMERA_SCALE,
      MAX_WORKSPACE_SCALE
    );
    updateWorkspaceCamera({
      scale,
      x: desktop.clientWidth / 2 - ((minimumX + maximumX) / 2) * scale,
      y: desktop.clientHeight / 2 - ((minimumY + maximumY) / 2) * scale
    });
  };

  const focusWorkspaceWindow = (id: WorkspaceWindowId) => {
    if (isCompactWorkspace) return;
    updateWorkspaceLayout((current) => bringWorkspaceWindowToFront(current, id));
  };

  const resetWorkspaceLayout = () => {
    const desktop = desktopRef.current;
    const width = desktop?.clientWidth || window.innerWidth;
    const height = desktop?.clientHeight || Math.max(1, window.innerHeight - 76);
    resetWorkspaceCamera();
    clearStoredWorkspaceLayout();
    clearStoredWorkspaceCamera();
    if (isCompactWorkspace) {
      shouldPersistWorkspaceLayoutRef.current = false;
      return;
    }
    shouldPersistWorkspaceLayoutRef.current = true;
    updateWorkspaceLayout(clampWorkspaceLayout(createDefaultWorkspaceLayout(width, height)));
    window.requestAnimationFrame(() => editorRef.current?.layout());
  };

  const getWorkspaceWindowStyle = (id: WorkspaceWindowId): React.CSSProperties => {
    const rect = windowLayout[id];
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: rect.zIndex
    };
  };

  const beginWindowInteraction = (
    event: React.PointerEvent<HTMLElement>,
    id: WorkspaceWindowId,
    mode: WindowInteraction['mode']
  ) => {
    if (isCompactWorkspace || event.button !== 0) return;
    event.preventDefault();
    const focusedLayout = bringWorkspaceWindowToFront(windowLayout, id);
    updateWorkspaceLayout(focusedLayout);
    event.currentTarget.setPointerCapture(event.pointerId);
    windowInteractionRef.current = {
      id,
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: focusedLayout[id],
      workspaceScale: workspaceCameraRef.current.scale
    };
    document.body.classList.add(mode === 'resize' ? 'window-resizing' : 'window-dragging');
  };

  const moveWindowInteraction = (event: React.PointerEvent<HTMLElement>) => {
    const interaction = windowInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    const deltaX = (event.clientX - interaction.startClientX) / interaction.workspaceScale;
    const deltaY = (event.clientY - interaction.startClientY) / interaction.workspaceScale;

    updateWorkspaceLayout((current) => {
      const start = {
        ...interaction.startRect,
        zIndex: current[interaction.id].zIndex
      };
      const nextRect = clampWorkspaceRect(
        interaction.id,
        interaction.mode === 'drag'
          ? { ...start, x: start.x + deltaX, y: start.y + deltaY }
          : { ...start, width: start.width + deltaX, height: start.height + deltaY },
        interaction.mode === 'resize'
      );
      return { ...current, [interaction.id]: nextRect };
    });
  };

  const endWindowInteraction = (event: React.PointerEvent<HTMLElement>) => {
    const interaction = windowInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    windowInteractionRef.current = null;
    document.body.classList.remove('window-dragging', 'window-resizing');
    window.requestAnimationFrame(() => {
      editorRef.current?.layout();
      persistWorkspaceLayout(windowLayoutRef.current);
    });
  };

  const beginWorkspacePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      isCompactWorkspace ||
      !event.isPrimary ||
      (event.button !== 0 && event.button !== 1)
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (event.button === 0 && target?.closest('.desktop-window')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = workspaceCameraRef.current;
    workspacePanInteractionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: current.x,
      startY: current.y
    };
    setIsPanningWorkspace(true);
  };

  const moveWorkspacePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = workspacePanInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    updateWorkspaceCamera((current) => ({
      ...current,
      x: interaction.startX + event.clientX - interaction.startClientX,
      y: interaction.startY + event.clientY - interaction.startClientY
    }));
  };

  const endWorkspacePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = workspacePanInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    workspacePanInteractionRef.current = null;
    setIsPanningWorkspace(false);
  };

  const handleWorkspaceKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      isCompactWorkspace ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const amount = event.shiftKey ? 80 : 32;
    updateWorkspaceCamera((current) => ({
      ...current,
      x:
        current.x +
        (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0),
      y:
        current.y +
        (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0)
    }));
  };

  const handleWindowKeyboard = (
    event: React.KeyboardEvent<HTMLElement>,
    id: WorkspaceWindowId,
    mode: WindowInteraction['mode']
  ) => {
    if (isCompactWorkspace || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    focusWorkspaceWindow(id);
    const amount = (event.shiftKey ? 40 : 12) / workspaceCameraRef.current.scale;

    updateWorkspaceLayout((current) => {
      const rect = current[id];
      const horizontal = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
      const vertical = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
      const candidate =
        mode === 'resize'
          ? { ...rect, width: rect.width + horizontal, height: rect.height + vertical }
          : { ...rect, x: rect.x + horizontal, y: rect.y + vertical };
      return {
        ...current,
        [id]: clampWorkspaceRect(id, candidate, mode === 'resize')
      };
    });
    window.requestAnimationFrame(() => {
      editorRef.current?.layout();
      persistWorkspaceLayout(windowLayoutRef.current);
    });
  };

  const fitPreviewToWindow = () => {
    const stage = previewRef.current;
    if (!stage || !diagramSize) return;
    updateDiagramViewport(
      fitDiagramViewport(stage.clientWidth, stage.clientHeight, diagramSize)
    );
  };

  const fitPreviewToWidth = () => {
    const stage = previewRef.current;
    if (!stage || !diagramSize) return;
    updateDiagramViewport(
      fitDiagramWidthViewport(stage.clientWidth, stage.clientHeight, diagramSize)
    );
  };

  const showPreviewAtOriginalSize = () => {
    const stage = previewRef.current;
    if (!stage || !diagramSize) return;
    updateDiagramViewport(
      centerDiagramViewport(stage.clientWidth, stage.clientHeight, diagramSize, 1)
    );
  };

  const zoomPreview = (factor: number, clientX?: number, clientY?: number) => {
    const stage = previewRef.current;
    if (!stage || !diagramSize) return;
    const bounds = stage.getBoundingClientRect();
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const clientToStageX = stageWidth / Math.max(1, bounds.width);
    const clientToStageY = stageHeight / Math.max(1, bounds.height);
    const anchorX =
      clientX === undefined ? stageWidth / 2 : (clientX - bounds.left) * clientToStageX;
    const anchorY =
      clientY === undefined ? stageHeight / 2 : (clientY - bounds.top) * clientToStageY;

    updateDiagramViewport((current) => {
      const nextScale = clamp(current.scale * factor, MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE);
      const worldX = (anchorX - current.x) / current.scale;
      const worldY = (anchorY - current.y) / current.scale;
      return clampDiagramPosition(
        {
          scale: nextScale,
          x: anchorX - worldX * nextScale,
          y: anchorY - worldY * nextScale,
          mode: 'custom'
        },
        stageWidth,
        stageHeight,
        diagramSize
      );
    });
  };

  const beginDiagramPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!diagramSize || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = diagramViewportRef.current;
    diagramPanInteractionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: current.x,
      startY: current.y
    };
    setIsPanningDiagram(true);
  };

  const moveDiagramPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = diagramPanInteractionRef.current;
    const stage = previewRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || !stage || !diagramSize) {
      return;
    }
    const current = diagramViewportRef.current;
    const bounds = stage.getBoundingClientRect();
    const clientToStageX = stage.clientWidth / Math.max(1, bounds.width);
    const clientToStageY = stage.clientHeight / Math.max(1, bounds.height);
    updateDiagramViewport(
      clampDiagramPosition(
        {
          ...current,
          x:
            interaction.startX +
            (event.clientX - interaction.startClientX) * clientToStageX,
          y:
            interaction.startY +
            (event.clientY - interaction.startClientY) * clientToStageY,
          mode: 'custom'
        },
        stage.clientWidth,
        stage.clientHeight,
        diagramSize
      )
    );
  };

  const endDiagramPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = diagramPanInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    diagramPanInteractionRef.current = null;
    setIsPanningDiagram(false);
  };

  const handlePreviewKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!diagramSize) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomPreview(1.2);
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      zoomPreview(1 / 1.2);
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      showPreviewAtOriginalSize();
      return;
    }
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      fitPreviewToWindow();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;

    event.preventDefault();
    const amount = event.shiftKey ? 80 : 32;
    const stage = previewRef.current;
    if (!stage) return;
    updateDiagramViewport((current) =>
      clampDiagramPosition(
        {
          ...current,
          x:
            current.x +
            (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0),
          y:
            current.y +
            (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0),
          mode: 'custom'
        },
        stage.clientWidth,
        stage.clientHeight,
        diagramSize
      )
    );
  };

  const connectionConfigured = Boolean(apiConfig.apiUrl.trim() && apiConfig.apiKey.trim());
  const aiEnabled = useMemo(
    () => Boolean(connectionConfigured && apiConfig.model.trim() && !isLoadingModels),
    [apiConfig.model, connectionConfigured, isLoadingModels]
  );
  const mermaidTheme = exportBackground === 'black' ? 'dark' : 'default';
  const canExport = Boolean(
    renderedSvg &&
      renderedCode === code &&
      renderedTheme === mermaidTheme &&
      !syntaxError &&
      !isRendering
  );
  useEffect(() => {
    diagramViewportRef.current = diagramViewport;
  }, [diagramViewport]);

  useEffect(() => {
    workspaceCameraRef.current = workspaceCamera;
  }, [workspaceCamera]);

  useEffect(() => {
    windowLayoutRef.current = windowLayout;
  }, [windowLayout]);

  useEffect(() => {
    const stage = previewRef.current;
    if (!stage || !diagramSize || syntaxError) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomPreview(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, [diagramSize, syntaxError]);

  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop || isCompactWorkspace) return;

    const handleWheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.diagram-stage')) return;
      const overWindow = Boolean(target?.closest('.desktop-window'));
      if (overWindow && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomWorkspace(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    desktop.addEventListener('wheel', handleWheel, { passive: false });
    return () => desktop.removeEventListener('wheel', handleWheel);
  }, [isCompactWorkspace]);

  useEffect(() => {
    if (isCompactWorkspace || !shouldPersistWorkspaceLayoutRef.current) return;
    const id = window.setTimeout(() => {
      persistWorkspaceLayout(windowLayout);
    }, 120);
    return () => window.clearTimeout(id);
  }, [isCompactWorkspace, windowLayout]);

  useEffect(() => {
    if (isCompactWorkspace) return;
    const id = window.setTimeout(() => {
      persistWorkspaceCamera(workspaceCamera);
    }, 120);
    return () => window.clearTimeout(id);
  }, [isCompactWorkspace, workspaceCamera]);

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${WORKSPACE_COMPACT_BREAKPOINT}px)`);
    const updateMode = () => setIsCompactWorkspace(media.matches);
    updateMode();
    media.addEventListener('change', updateMode);
    return () => media.removeEventListener('change', updateMode);
  }, []);

  useEffect(() => {
    if (isCompactWorkspace || readStoredWorkspaceLayout()) return;
    const desktop = desktopRef.current;
    if (!desktop?.clientWidth || !desktop.clientHeight) return;
    const next = clampWorkspaceLayout(
      createDefaultWorkspaceLayout(desktop.clientWidth, desktop.clientHeight)
    );
    shouldPersistWorkspaceLayoutRef.current = true;
    windowLayoutRef.current = next;
    updateWorkspaceLayout(next);
  }, [isCompactWorkspace]);

  useEffect(() => {
    if (apiConfig.apiUrl || apiConfig.model) {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          apiUrl: apiConfig.apiUrl,
          model: apiConfig.model
        })
      );
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    if (apiConfig.apiKey) window.sessionStorage.setItem(SESSION_API_KEY, apiConfig.apiKey);
    else window.sessionStorage.removeItem(SESSION_API_KEY);
  }, [apiConfig]);

  const clearStoredApiConfig = () => {
    const modelTestController = modelTestControllerRef.current;
    const chatController = chatControllerRef.current;
    modelTestControllerRef.current = null;
    chatControllerRef.current = null;
    modelTestController?.abort();
    chatController?.abort();
    window.localStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(SESSION_API_KEY);
    setApiConfig({
      apiUrl: '',
      apiKey: '',
      model: ''
    });
    setAvailableModels([]);
    setIsLoadingModels(false);
    setIsTestingModel(false);
    setIsCallingAi(false);
    setModelStatus('請輸入 API URL 與 Key');
    setModelRefreshVersion((value) => value + 1);
  };

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: mermaidTheme,
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'theme',
        'themeVariables',
        'themeCSS'
      ],
      flowchart: { htmlLabels: true, curve: 'basis' }
    });
  }, [mermaidTheme]);

  useEffect(() => {
    let cancelled = false;
    setIsRendering(true);
    setExportStatus('');
    const id = window.setTimeout(async () => {
      try {
        await mermaid.parse(code);
        const { svg } = await mermaid.render(`mermaid-${Date.now()}`, code);
        if (!cancelled) {
          setRenderedSvg(svg);
          setRenderedCode(code);
          setRenderedTheme(mermaidTheme);
          setSyntaxError('');
        }
      } catch (error) {
        if (!cancelled) {
          setSyntaxError(formatMermaidParseError(error));
          setRenderedCode('');
          setRenderedTheme('');
        }
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [code, mermaidTheme, renderVersion]);

  useEffect(() => {
    if (!diagramSize || syntaxError) return;
    const id = window.requestAnimationFrame(() => {
      const stage = previewRef.current;
      if (!stage) return;
      updateDiagramViewport((current) =>
        current.mode === 'fit'
          ? fitDiagramViewport(stage.clientWidth, stage.clientHeight, diagramSize)
          : clampDiagramPosition(
              current,
              stage.clientWidth,
              stage.clientHeight,
              diagramSize
            )
      );
    });
    return () => window.cancelAnimationFrame(id);
  }, [renderedSvg, diagramSize, syntaxError]);

  useEffect(() => {
    diagramPanInteractionRef.current = null;
    setIsPanningDiagram(false);
  }, [renderedSvg, syntaxError]);

  useEffect(() => {
    if (!isCompactWorkspace) return;
    workspacePanInteractionRef.current = null;
    setIsPanningWorkspace(false);
  }, [isCompactWorkspace]);

  useEffect(() => {
    const stage = previewRef.current;
    if (!stage || !diagramSize || syntaxError) return;
    let previousWidth = stage.clientWidth;
    let previousHeight = stage.clientHeight;

    const observer = new ResizeObserver(() => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height || (width === previousWidth && height === previousHeight)) return;
      const widthChange = width - previousWidth;
      const heightChange = height - previousHeight;
      previousWidth = width;
      previousHeight = height;

      updateDiagramViewport((current) =>
        current.mode === 'fit'
          ? fitDiagramViewport(width, height, diagramSize)
          : clampDiagramPosition(
              {
                ...current,
                x: current.x + widthChange / 2,
                y: current.y + heightChange / 2
              },
              width,
              height,
              diagramSize
            )
      );
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [diagramSize, syntaxError]);

  useEffect(
    () => {
      const saveLatestLayout = () => {
        if (shouldPersistWorkspaceLayoutRef.current) {
          persistWorkspaceLayout(windowLayoutRef.current);
        }
        persistWorkspaceCamera(workspaceCameraRef.current);
      };
      window.addEventListener('pagehide', saveLatestLayout);
      return () => {
        window.removeEventListener('pagehide', saveLatestLayout);
        saveLatestLayout();
        modelTestControllerRef.current?.abort();
        chatControllerRef.current?.abort();
        workspacePanInteractionRef.current = null;
        diagramPanInteractionRef.current = null;
        document.body.classList.remove('window-dragging', 'window-resizing');
      };
    },
    []
  );

  useEffect(() => {
    if (modelTestControllerRef.current) {
      modelTestControllerRef.current.abort();
      setModelStatus('模型設定已變更，請重新測試。');
    }
    if (chatControllerRef.current) {
      chatControllerRef.current.abort();
      setChatLog((items) => [
        ...items,
        { role: 'assistant', content: '呼叫已取消：模型設定已變更。' }
      ]);
    }
  }, [apiConfig.apiUrl, apiConfig.apiKey, apiConfig.model]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;

    const model = editor.getModel();
    if (!model) return;

    if (!syntaxError) {
      monaco.editor.setModelMarkers(model, 'mermaid', []);
      return;
    }

    monaco.editor.setModelMarkers(model, 'mermaid', [
      {
        startLineNumber: 1,
        endLineNumber: Math.max(1, model.getLineCount()),
        startColumn: 1,
        endColumn: Math.max(1, model.getLineMaxColumn(Math.max(1, model.getLineCount()))),
        message: syntaxError,
        severity: monaco.MarkerSeverity.Error
      }
    ]);
  }, [syntaxError]);

  useEffect(() => {
    const apiUrl = apiConfig.apiUrl.trim();
    const apiKey = apiConfig.apiKey.trim();
    if (!apiUrl || !apiKey) {
      setAvailableModels([]);
      setIsLoadingModels(false);
      setModelStatus(!apiUrl ? '請輸入 API URL' : '請輸入 API Key');
      return;
    }

    const controller = new AbortController();
    setAvailableModels([]);
    setIsLoadingModels(true);
    const id = window.setTimeout(async () => {
      setModelStatus('正在抓取模型列表...');
      try {
        const data = await requestApiJson(
          '/api/models',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiUrl, apiKey })
          },
          MODEL_LIST_TIMEOUT_MS,
          controller.signal
        );
        const ids = parseModelIds(data);
        if (!ids.length) throw new Error('API 沒有回傳可用模型。');
        setAvailableModels(ids);
        setModelStatus(`已取得 ${ids.length} 個模型，尚未測試`);
        setApiConfig((current) => ({
          ...current,
          model: ids.includes(current.model)
            ? current.model
            : ids.length === 1
              ? ids[0]
              : ''
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        setAvailableModels([]);
        setApiConfig((current) => ({ ...current, model: '' }));
        setModelStatus(error instanceof Error ? error.message : '模型列表抓取失敗。');
      } finally {
        if (!controller.signal.aborted) setIsLoadingModels(false);
      }
    }, 600);

    return () => {
      controller.abort();
      window.clearTimeout(id);
    };
  }, [
    apiConfig.apiUrl,
    apiConfig.apiKey,
    modelRefreshVersion
  ]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.languages.register({ id: 'mermaid' });
  };

  const uploadFile = async (file?: File) => {
    if (!file) return;
    updateCode(await file.text());
  };

  const exportFileName = (extension: string) => sanitizeFileBaseName(exportBaseName) + '.' + extension;

  const updateConnectionConfig = (
    patch: Partial<ApiConfig>,
    status = '設定已變更，尚未測試',
    reloadModels = false
  ) => {
    if (reloadModels) {
      setAvailableModels([]);
      setIsLoadingModels(true);
    }
    setModelStatus(status);
    setApiConfig((current) => ({ ...current, ...patch }));
  };

  const getConnectionPayload = () => {
    return {
      apiUrl: apiConfig.apiUrl.trim(),
      apiKey: apiConfig.apiKey.trim()
    };
  };

  const testModelConnection = async () => {
    if (!aiEnabled) return;
    modelTestControllerRef.current?.abort();
    const controller = new AbortController();
    modelTestControllerRef.current = controller;
    setIsTestingModel(true);
    setModelStatus('正在測試模型連線...');
    try {
      const data = await requestApiJson(
        '/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...getConnectionPayload(),
            model: apiConfig.model.trim(),
            operation: 'connection-test',
            messages: [
              { role: 'system', content: 'Reply with exactly OK.' },
              { role: 'user', content: 'ping' }
            ]
          })
        },
        MODEL_TEST_TIMEOUT_MS,
        controller.signal
      );
      if (!getAssistantContent(data).trim()) {
        throw new Error('API 雖有回應，但沒有有效的 assistant 文字內容。');
      }
      setModelStatus('模型連線正常');
    } catch (error) {
      if (controller.signal.aborted) return;
      setModelStatus(error instanceof Error ? error.message : '模型測試失敗。');
    } finally {
      if (modelTestControllerRef.current === controller) {
        modelTestControllerRef.current = null;
        setIsTestingModel(false);
      }
    }
  };

  const callAi = async (mode: 'generate' | 'fix') => {
    if (!aiEnabled) return;
    chatControllerRef.current?.abort();
    const controller = new AbortController();
    chatControllerRef.current = controller;
    setIsCallingAi(true);
    const requestCode = codeRef.current;
    const requestText = JSON.stringify(
      mode === 'fix'
        ? {
            mode: 'FIX_SYNTAX',
            parseError: syntaxError || '(未提供)',
            currentMermaid: requestCode
          }
        : {
            mode: 'GENERATE_OR_REWRITE',
            userRequest: chatInput.trim(),
            currentMermaid: requestCode
          },
      null,
      2
    );

    setChatLog((items) => [
      ...items,
      {
        role: 'user',
        content: mode === 'fix' ? '修正目前圖表的 Mermaid 語法錯誤' : chatInput.trim()
      }
    ]);

    try {
      const data = await requestApiJson(
        '/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...getConnectionPayload(),
            model: apiConfig.model.trim(),
            operation: 'mermaid',
            input: requestText,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: requestText }
            ]
          })
        },
        CHAT_TIMEOUT_MS,
        controller.signal
      );
      const assistantRawContent = getAssistantContent(data);
      const metadata = getMermaidOutputMetadata(data);
      const normalized = normalizeMermaidOutput(assistantRawContent);
      const content = normalized.code;
      const envelope = validateMermaidEnvelope(content);
      if (!envelope.valid) {
        setChatLog((items) => [
          ...items,
          {
            role: 'assistant',
            content: `AI 回傳內容無法安全套用，已保留目前圖表。\n${envelope.error}`,
            rawOutput: getRawMermaidOutput(metadata, assistantRawContent)
          }
        ]);
        return;
      }
      try {
        await mermaid.parse(content);
      } catch (error) {
        setChatLog((items) => [
          ...items,
          {
            role: 'assistant',
            content: `AI 回傳的 Mermaid 無法解析，已保留目前圖表。\n${formatMermaidParseError(error)}`,
            rawOutput: getRawMermaidOutput(metadata, assistantRawContent)
          }
        ]);
        return;
      }
      if (controller.signal.aborted) return;
      if (codeRef.current !== requestCode) {
        setChatLog((items) => [
          ...items,
          {
            role: 'assistant',
            content: `模型已完成，但您在等待期間修改了圖表，因此未自動套用。\n\n${content}`
          }
        ]);
        return;
      }
      updateCode(content);
      const repairs = [...new Set([
        ...getServerNormalizationRepairs(data),
        ...normalized.repairs
      ])];
      setChatLog((items) => [
        ...items,
        {
          role: 'assistant',
          content: repairs.length
            ? `已自動修復：${repairs.join('、')}\n\n${content}`
            : content
        }
      ]);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      const rejectedMermaid = error instanceof ApiRequestError && error.status === 422;
      setChatLog((items) => [
        ...items,
        {
          role: 'assistant',
          content: rejectedMermaid
            ? `AI 回傳的 Mermaid 無法安全套用，已保留目前圖表。\n${error.message}`
            : `呼叫失敗：${error instanceof Error ? error.message : String(error)}`,
          rawOutput: rejectedMermaid
            ? getRawMermaidOutput(getMermaidOutputMetadata(error.details), '')
            : undefined
        }
      ]);
    } finally {
      if (chatControllerRef.current === controller) {
        chatControllerRef.current = null;
        setIsCallingAi(false);
      }
    }
  };

  const cancelAiCall = () => {
    const controller = chatControllerRef.current;
    if (!controller) return;
    controller.abort();
    setChatLog((items) => [
      ...items,
      { role: 'assistant', content: '已取消這次模型呼叫。' }
    ]);
  };

  const exportDiagram = async (format: 'svg' | 'png' | 'pdf') => {
    if (!canExport) {
      setExportStatus('圖表仍在渲染或有語法錯誤，請稍候再匯出。');
      return;
    }

    setExporting(format);
    setExportStatus(`正在匯出 ${format.toUpperCase()}...`);
    try {
      const preparedSvg = prepareExportSvg(renderedSvg, exportBackground);

      if (format === 'svg') {
        downloadBlob(
          exportFileName('svg'),
          'image/svg+xml;charset=utf-8',
          preparedSvg.content
        );
      } else {
        if (format === 'png') {
          const png = await renderSvgToPng(
            preparedSvg,
            exportScale,
            exportBackground === 'transparent'
              ? undefined
              : EXPORT_BACKGROUNDS[exportBackground].color
          );
          downloadDataUrl(exportFileName('png'), png);
        } else {
          const { jsPDF } = await import('jspdf');
          const orientation = preparedSvg.width >= preparedSvg.height ? 'landscape' : 'portrait';
          const pdf = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const margin = 24;
          const availableWidth = pageWidth - margin * 2;
          const availableHeight = pageHeight - margin * 2;
          const scale = Math.min(
            availableWidth / preparedSvg.width,
            availableHeight / preparedSvg.height
          );
          const exportWidth = preparedSvg.width * scale;
          const exportHeight = preparedSvg.height * scale;
          const x = (pageWidth - exportWidth) / 2;
          const y = (pageHeight - exportHeight) / 2;
          const pdfBackground = exportBackground === 'black' ? '#000000' : '#ffffff';
          const pdfPixelRatio = scale * 2;
          const png = await renderSvgToPng(preparedSvg, pdfPixelRatio, pdfBackground);

          pdf.setFillColor(pdfBackground);
          pdf.rect(0, 0, pageWidth, pageHeight, 'F');
          pdf.addImage(png, 'PNG', x, y, exportWidth, exportHeight, undefined, 'FAST');
          pdf.save(exportFileName('pdf'));
        }
      }
      setExportStatus(`${format.toUpperCase()} 匯出完成。`);
    } catch (error) {
      setExportStatus(`匯出失敗：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(null);
    }
  };

  const workspaceGridScale = Math.max(0.25, workspaceCamera.scale);
  const workspaceGridSize = 22 * workspaceGridScale;
  const workspaceViewportStyle = isCompactWorkspace
    ? undefined
    : ({
        '--workspace-grid-size': `${workspaceGridSize}px`,
        '--workspace-grid-line': `${Math.max(0.65, workspaceGridScale)}px`,
        '--workspace-grid-x': `${((workspaceCamera.x % workspaceGridSize) + workspaceGridSize) % workspaceGridSize}px`,
        '--workspace-grid-y': `${((workspaceCamera.y % workspaceGridSize) + workspaceGridSize) % workspaceGridSize}px`
      } as React.CSSProperties);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Mermaid Flow Editor</h1>
          <p>縮放桌面、拖曳視窗、自由編排與檢視複雜流程圖</p>
        </div>
        <div className="toolbar">
          <div className="workspace-zoom-controls" role="group" aria-label="工作區畫布縮放">
            <button
              title="縮小工作區"
              aria-label="縮小工作區"
              disabled={isCompactWorkspace || workspaceCamera.scale <= MIN_WORKSPACE_SCALE}
              onClick={() => zoomWorkspace(1 / 1.2)}
            >
              <Minus size={16} />
            </button>
            <output className="workspace-zoom-readout" aria-label="工作區縮放比例">
              {workspaceCamera.scale < 0.01
                ? '<1%'
                : `${Math.round(workspaceCamera.scale * 100)}%`}
            </output>
            <button
              title="放大工作區"
              aria-label="放大工作區"
              disabled={isCompactWorkspace || workspaceCamera.scale >= MAX_WORKSPACE_SCALE}
              onClick={() => zoomWorkspace(1.2)}
            >
              <Plus size={16} />
            </button>
            <button
              className="workspace-zoom-reset"
              title="工作區顯示為 1:1"
              aria-label="工作區顯示為 1:1"
              disabled={isCompactWorkspace || workspaceCamera.scale === 1}
              onClick={showWorkspaceAtOriginalScale}
            >
              1:1
            </button>
            <button
              title="顯示全部視窗"
              aria-label="顯示全部視窗"
              disabled={isCompactWorkspace}
              onClick={fitWorkspaceToWindows}
            >
              <Maximize2 size={16} />
            </button>
          </div>
          <button
            title="恢復原有版面配置"
            aria-label="恢復原有版面配置"
            onClick={resetWorkspaceLayout}
          >
            <LayoutTemplate size={18} />
          </button>
          <label className="icon-button" title="上傳 Mermaid 或文字檔">
            <FileUp size={18} />
            <input
              type="file"
              accept=".mmd,.mermaid,.txt"
              onChange={(event) => uploadFile(event.target.files?.[0])}
            />
          </label>
          <button title="匯出文字檔" onClick={() => downloadBlob(exportFileName('mmd'), 'text/plain;charset=utf-8', code)}>
            <FileText size={18} />
          </button>
          <button
            title="匯出 SVG"
            disabled={!canExport || Boolean(exporting)}
            onClick={() => void exportDiagram('svg')}
          >
            <Save size={18} />
          </button>
          <button
            title="匯出 PNG"
            disabled={!canExport || Boolean(exporting)}
            onClick={() => void exportDiagram('png')}
          >
            <FileImage size={18} />
          </button>
          <button
            title="匯出 PDF"
            disabled={!canExport || Boolean(exporting)}
            onClick={() => void exportDiagram('pdf')}
          >
            <Download size={18} />
          </button>
        </div>
      </header>

      <div
        ref={desktopRef}
        className={`editor-preview workspace-viewport ${!isCompactWorkspace ? 'can-pan-workspace' : ''} ${isPanningWorkspace ? 'is-panning-workspace' : ''}`}
        style={workspaceViewportStyle}
        role="region"
        aria-label="工作區畫布；空白處拖曳或方向鍵可平移，滾輪可縮放"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
        tabIndex={isCompactWorkspace ? -1 : 0}
        onPointerDown={beginWorkspacePan}
        onPointerMove={moveWorkspacePan}
        onPointerUp={endWorkspacePan}
        onPointerCancel={endWorkspacePan}
        onLostPointerCapture={endWorkspacePan}
        onKeyDown={handleWorkspaceKeyboard}
      >
        <div
          className="desktop workspace-plane"
          data-workspace-scale={workspaceCamera.scale}
          style={
            isCompactWorkspace
              ? undefined
              : {
                  transform: `translate3d(${workspaceCamera.x}px, ${workspaceCamera.y}px, 0) scale(${workspaceCamera.scale})`
                }
          }
        >
          <section
            className={`desktop-window pane editor-pane ${activeWindowId === 'editor' ? 'is-active' : ''}`}
            data-window-id="editor"
            style={getWorkspaceWindowStyle('editor')}
            onPointerDownCapture={() => focusWorkspaceWindow('editor')}
            onFocusCapture={() => focusWorkspaceWindow('editor')}
          >
            <div className="pane-header window-titlebar">
              <div
                className="window-drag-handle"
                role={isCompactWorkspace ? undefined : 'button'}
                tabIndex={isCompactWorkspace ? -1 : 0}
                aria-label={
                  isCompactWorkspace ? undefined : '拖曳 Mermaid 編輯器視窗；方向鍵可移動'
                }
                onPointerDown={(event) => beginWindowInteraction(event, 'editor', 'drag')}
                onPointerMove={moveWindowInteraction}
                onPointerUp={endWindowInteraction}
                onPointerCancel={endWindowInteraction}
                onLostPointerCapture={endWindowInteraction}
                onKeyDown={(event) => handleWindowKeyboard(event, 'editor', 'drag')}
              >
                <GripHorizontal size={16} />
                <span>Mermaid</span>
              </div>
              <span className={syntaxError ? 'status error' : 'status ok'}>
                {syntaxError ? 'Syntax error' : isRendering ? 'Rendering' : 'Ready'}
              </span>
            </div>
            <Editor
              height="100%"
              defaultLanguage="mermaid"
              language="mermaid"
              theme="vs-dark"
              value={code}
              onMount={handleEditorMount}
              onChange={(value) => updateCode(value || '')}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                wordWrap: 'on',
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true
              }}
            />
            <div
              className="window-resize-handle"
              role={isCompactWorkspace ? undefined : 'separator'}
              tabIndex={isCompactWorkspace ? -1 : 0}
              aria-label={
                isCompactWorkspace ? undefined : '調整 Mermaid 編輯器視窗大小；方向鍵可調整'
              }
              onPointerDown={(event) => beginWindowInteraction(event, 'editor', 'resize')}
              onPointerMove={moveWindowInteraction}
              onPointerUp={endWindowInteraction}
              onPointerCancel={endWindowInteraction}
              onLostPointerCapture={endWindowInteraction}
              onKeyDown={(event) => handleWindowKeyboard(event, 'editor', 'resize')}
            />
          </section>

          <section
            className={`desktop-window pane preview-pane ${activeWindowId === 'preview' ? 'is-active' : ''}`}
            data-window-id="preview"
            style={getWorkspaceWindowStyle('preview')}
            onPointerDownCapture={() => focusWorkspaceWindow('preview')}
            onFocusCapture={() => focusWorkspaceWindow('preview')}
          >
            <div className="pane-header window-titlebar">
              <div
                className="window-drag-handle"
                role={isCompactWorkspace ? undefined : 'button'}
                tabIndex={isCompactWorkspace ? -1 : 0}
                aria-label={isCompactWorkspace ? undefined : '拖曳預覽視窗；方向鍵可移動'}
                onPointerDown={(event) => beginWindowInteraction(event, 'preview', 'drag')}
                onPointerMove={moveWindowInteraction}
                onPointerUp={endWindowInteraction}
                onPointerCancel={endWindowInteraction}
                onLostPointerCapture={endWindowInteraction}
                onKeyDown={(event) => handleWindowKeyboard(event, 'preview', 'drag')}
              >
                <GripHorizontal size={16} />
                <span>Preview</span>
              </div>
              <div className="preview-controls">
                <button
                  className="subtle-button"
                  title="縮小預覽"
                  aria-label="縮小預覽"
                  disabled={!diagramSize || Boolean(syntaxError) || isRendering}
                  onClick={() => zoomPreview(1 / 1.2)}
                >
                  <Minus size={15} />
                </button>
                <output className="zoom-readout" aria-label="預覽縮放比例">
                  {Math.round(diagramViewport.scale * 100)}%
                </output>
                <button
                  className="subtle-button"
                  title="放大預覽"
                  aria-label="放大預覽"
                  disabled={!diagramSize || Boolean(syntaxError) || isRendering}
                  onClick={() => zoomPreview(1.2)}
                >
                  <Plus size={15} />
                </button>
                <button
                  className="subtle-button text-button"
                  title="以原始大小顯示 (100%)"
                  aria-label="以原始大小顯示 (100%)"
                  disabled={!diagramSize || Boolean(syntaxError) || isRendering}
                  onClick={showPreviewAtOriginalSize}
                >
                  1:1
                </button>
                <button
                  className="subtle-button text-button"
                  title="配合寬度"
                  aria-label="配合寬度"
                  disabled={!diagramSize || Boolean(syntaxError) || isRendering}
                  onClick={fitPreviewToWidth}
                >
                  寬度
                </button>
                <button
                  className="subtle-button"
                  title="適合預覽視窗 (Fit)"
                  aria-label="適合預覽視窗 (Fit)"
                  disabled={!diagramSize || Boolean(syntaxError) || isRendering}
                  onClick={fitPreviewToWindow}
                >
                  <Maximize2 size={15} />
                </button>
                <button
                  className="subtle-button"
                  title="重新渲染"
                  aria-label="重新渲染"
                  onClick={() => setRenderVersion((value) => value + 1)}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>
            {syntaxError ? (
              <div className="error-box">
                <AlertTriangle size={20} />
                <pre>{syntaxError}</pre>
              </div>
            ) : (
              <div
                ref={previewRef}
                className={`diagram-stage ${isPanningDiagram ? 'is-panning' : ''} ${exportBackground === 'transparent' ? 'transparent-background' : ''}`}
                tabIndex={0}
                role="region"
                aria-label="流程圖預覽；使用滾輪縮放、拖曳平移，按 F 適合視窗"
                style={
                  exportBackground === 'transparent'
                    ? undefined
                    : { backgroundColor: EXPORT_BACKGROUNDS[exportBackground].color }
                }
                onPointerDown={beginDiagramPan}
                onPointerMove={moveDiagramPan}
                onPointerUp={endDiagramPan}
                onPointerCancel={endDiagramPan}
                onLostPointerCapture={endDiagramPan}
                onDoubleClick={fitPreviewToWindow}
                onKeyDown={handlePreviewKeyboard}
              >
                {diagramSize ? (
                  <div
                    ref={previewCanvasRef}
                    className="diagram-canvas"
                    style={{
                      width: diagramSize.width,
                      height: diagramSize.height,
                      transform: `translate3d(${diagramViewport.x}px, ${diagramViewport.y}px, 0) scale(${diagramViewport.scale})`
                    }}
                    dangerouslySetInnerHTML={{ __html: renderedSvg }}
                  />
                ) : null}
              </div>
            )}
            <div
              className="window-resize-handle"
              role={isCompactWorkspace ? undefined : 'separator'}
              tabIndex={isCompactWorkspace ? -1 : 0}
              aria-label={isCompactWorkspace ? undefined : '調整預覽視窗大小；方向鍵可調整'}
              onPointerDown={(event) => beginWindowInteraction(event, 'preview', 'resize')}
              onPointerMove={moveWindowInteraction}
              onPointerUp={endWindowInteraction}
              onPointerCancel={endWindowInteraction}
              onLostPointerCapture={endWindowInteraction}
              onKeyDown={(event) => handleWindowKeyboard(event, 'preview', 'resize')}
            />
          </section>

      <aside
        className={`desktop-window ai-panel ${activeWindowId === 'assistant' ? 'is-active' : ''}`}
        data-window-id="assistant"
        style={getWorkspaceWindowStyle('assistant')}
        onPointerDownCapture={() => focusWorkspaceWindow('assistant')}
        onFocusCapture={() => focusWorkspaceWindow('assistant')}
      >
        <div className="pane-header window-titlebar panel-title">
          <div
            className="window-drag-handle"
            role={isCompactWorkspace ? undefined : 'button'}
            tabIndex={isCompactWorkspace ? -1 : 0}
            aria-label={
              isCompactWorkspace ? undefined : '拖曳 AI Assistant 視窗；方向鍵可移動'
            }
            onPointerDown={(event) => beginWindowInteraction(event, 'assistant', 'drag')}
            onPointerMove={moveWindowInteraction}
            onPointerUp={endWindowInteraction}
            onPointerCancel={endWindowInteraction}
            onLostPointerCapture={endWindowInteraction}
            onKeyDown={(event) => handleWindowKeyboard(event, 'assistant', 'drag')}
          >
            <GripHorizontal size={16} />
            <Bot size={19} />
            <h2>AI Assistant</h2>
          </div>
        </div>
        <div className="ai-panel-content">

        <details className="settings-block" open>
          <summary>
            <span>
              <Palette size={16} />
              匯出設定
            </span>
          </summary>
          <div className="settings-body">
            <label>
              檔名
              <input
                placeholder="diagram"
                value={exportBaseName}
                onChange={(event) => setExportBaseName(event.target.value)}
              />
            </label>
            <label>
              背景
              <select
                value={exportBackground}
                onChange={(event) => setExportBackground(event.target.value as ExportBackground)}
              >
                {Object.entries(EXPORT_BACKGROUNDS).map(([value, option]) => (
                  <option key={value} value={value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              PNG 解析度 / 縮放
              <select
                value={exportScale}
                onChange={(event) => setExportScale(Number(event.target.value) as ExportScale)}
              >
                {EXPORT_SCALES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {exportStatus ? (
              <p
                className={`inline-status ${exportStatus.includes('失敗') ? 'error' : ''}`}
                role={exportStatus.includes('失敗') ? 'alert' : 'status'}
                aria-live="polite"
              >
                {exportStatus}
              </p>
            ) : null}
          </div>
        </details>

        <details className="settings-block">
          <summary>
            <span>
              <ChevronDown size={16} />
              模型設定
            </span>
            <span className="connection-state">{isLoadingModels ? '讀取中' : modelStatus}</span>
          </summary>
          <div className="settings-body">
            <label>
              API URL
              <input
                placeholder="例如 https://api.openai.com/v1"
                value={apiConfig.apiUrl}
                onChange={(event) =>
                  updateConnectionConfig(
                    { apiUrl: event.target.value },
                    '正在更新模型列表...',
                    true
                  )
                }
              />
              <small>支援 OpenAI-compatible API endpoint。</small>
            </label>
            <label>
              API Key
              <input
                type="password"
                placeholder="Bearer token"
                value={apiConfig.apiKey}
                onChange={(event) =>
                  updateConnectionConfig(
                    { apiKey: event.target.value },
                    '正在更新模型列表...',
                    true
                  )
                }
              />
              <small>自訂 Key 只保留到目前瀏覽器工作階段，關閉後不會永久儲存。</small>
            </label>
            <label>
              Model
              <span className="model-control-row">
                {availableModels.length ? (
                  <select
                    value={apiConfig.model}
                    onChange={(event) => updateConnectionConfig({ model: event.target.value })}
                  >
                    <option value="" disabled>
                      請選擇模型
                    </option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    placeholder={connectionConfigured ? '正在讀取模型...' : '請先完成連線設定'}
                    value={apiConfig.model}
                    onChange={(event) => updateConnectionConfig({ model: event.target.value })}
                  />
                )}
                <button
                  className="icon-button secondary-button"
                  type="button"
                  title="重新載入模型"
                  aria-label="重新載入模型"
                  disabled={!connectionConfigured || isLoadingModels}
                  onClick={() => {
                    setIsLoadingModels(true);
                    setModelRefreshVersion((value) => value + 1);
                  }}
                >
                  <RefreshCw className={isLoadingModels ? 'spin' : undefined} size={17} />
                </button>
              </span>
            </label>
            <button
              className="wide-button"
              disabled={!aiEnabled || isTestingModel}
              onClick={() => void testModelConnection()}
            >
              {isTestingModel ? <Loader2 className="spin" size={17} /> : <PlugZap size={17} />}
              測試模型連線
            </button>
            <button className="wide-button secondary-button" type="button" onClick={clearStoredApiConfig}>
              重設瀏覽器模型設定
            </button>
          </div>
        </details>

        <label>
          Prompt
          <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} />
        </label>
        <div className="ai-actions">
          <button
            disabled={!aiEnabled || isCallingAi || !chatInput.trim()}
            onClick={() => void callAi('generate')}
          >
            {isCallingAi ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
            {isCallingAi ? '模型處理中' : '生成/改寫'}
          </button>
          {isCallingAi ? (
            <button className="secondary-button" onClick={cancelAiCall}>
              <Square size={16} />
              取消
            </button>
          ) : (
            <button disabled={!aiEnabled || !syntaxError} onClick={() => void callAi('fix')}>
              <AlertTriangle size={17} />
              修正錯誤
            </button>
          )}
        </div>
        <details>
          <summary>內建 system prompt</summary>
          <pre>{SYSTEM_PROMPT}</pre>
        </details>
        <div className="chat-log">
          {chatLog.map((message, index) => (
            <article key={`${message.role}-${index}`} className={message.role}>
              <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
              <pre>{message.content}</pre>
              {message.rawOutput ? (
                <details className="raw-ai-output">
                  <summary>檢視 AI 原始輸出（未套用）</summary>
                  <pre>{message.rawOutput.content}</pre>
                  {message.rawOutput.truncated ? <small>內容已截斷。</small> : null}
                </details>
              ) : null}
            </article>
          ))}
        </div>
        </div>
        <div
          className="window-resize-handle"
          role={isCompactWorkspace ? undefined : 'separator'}
          tabIndex={isCompactWorkspace ? -1 : 0}
          aria-label={
            isCompactWorkspace ? undefined : '調整 AI Assistant 視窗大小；方向鍵可調整'
          }
          onPointerDown={(event) => beginWindowInteraction(event, 'assistant', 'resize')}
          onPointerMove={moveWindowInteraction}
          onPointerUp={endWindowInteraction}
          onPointerCancel={endWindowInteraction}
          onLostPointerCapture={endWindowInteraction}
          onKeyDown={(event) => handleWindowKeyboard(event, 'assistant', 'resize')}
        />
      </aside>
        </div>
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
