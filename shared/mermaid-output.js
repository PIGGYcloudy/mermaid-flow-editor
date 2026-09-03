const DIAGRAM_DECLARATION = /^(?:flowchart\b|graph\b|sequenceDiagram\b|classDiagram(?:-v2)?\b|stateDiagram(?:-v2)?\b|erDiagram\b|journey\b|gantt\b|pie\b|mindmap\b|timeline\b|quadrantChart\b|xychart-beta\b|block-beta\b|sankey-beta\b|architecture-beta\b|gitGraph\b|C4(?:Context|Container|Component|Dynamic|Deployment)\b)/im;
const DIAGRAM_START = new RegExp(
  `^(?:---\\s*$|${DIAGRAM_DECLARATION.source.replace(/^\\^/, '')})`,
  'im'
);
const FLOWCHART_START = /^(?:flowchart|graph)\b/im;
const FENCE = /```(?:mermaid\b[ \t]*)?\r?\n?([\s\S]*?)```/i;
const BRACKET_PAIRS = { '[': ']', '{': '}', '(': ')' };
const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));
const DENY_RULES = [
  {
    pattern: /%%\{\s*(?:init|config)\s*:/i,
    error: '不允許 init 或 config directive。'
  },
  {
    pattern: /^\s*click\s+\S+/im,
    error: '不允許 click 語法。'
  },
  {
    pattern: /(?:https?:\/\/|\/\/[A-Za-z0-9.-]+(?:\/|\b)|\b(?:javascript|vbscript|file)\s*:|\bdata\s*:\s*text\/html)/i,
    error: '不允許外部 URL 或危險 URI scheme。'
  },
  {
    pattern: /<\/?[A-Za-z][^>\n]*>/,
    error: '不允許未跳脫的 HTML 標籤。'
  },
  {
    pattern: /\bon(?:abort|animationend|animationstart|blur|change|click|error|focus|load|message|mouseover|submit)\s*=/i,
    error: '不允許 HTML event handler。'
  }
];

function stripOutputWrapper(text, repairs) {
  let candidate = text.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\u2060]/g, '');
  if (candidate !== text) repairs.push('已移除不可見格式字元');

  const fenced = candidate.match(FENCE);
  if (fenced) {
    candidate = fenced[1];
    repairs.push('已移除 Markdown code block 標記');
  }

  candidate = candidate.trim();
  const diagramStart = candidate.search(DIAGRAM_START);
  if (diagramStart > 0) {
    candidate = candidate.slice(diagramStart).trim();
    repairs.push('已移除 Mermaid 圖表前的說明文字');
  }
  return candidate;
}

function repairQuotedLabels(line) {
  let output = '';
  let changed = false;

  for (let index = 0; index < line.length; index += 1) {
    const opener = line[index];
    if (!BRACKET_PAIRS[opener] || line[index + 1] !== '"') {
      output += opener;
      continue;
    }

    const closer = BRACKET_PAIRS[opener];
    output += `${opener}"`;
    index += 2;
    for (; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"' && line[index + 1] === closer) {
        output += `"${closer}`;
        index += 1;
        break;
      }
      if (character === closer) {
        output += `"${closer}`;
        changed = true;
        break;
      }
      if (character === '"') {
        output += '&quot;';
        changed = true;
      } else {
        output += character;
      }
    }
  }

  return { line: output, changed };
}

function appendMissingLineClosers(line) {
  if (!/^[ \t]*(?:[A-Za-z][A-Za-z0-9_]*|subgraph\b)/.test(line)) return line;

  const stack = [];
  let inQuotedLabel = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') inQuotedLabel = !inQuotedLabel;
    if (inQuotedLabel) continue;
    if (BRACKET_PAIRS[character]) {
      stack.push(character);
    } else if (CLOSING_BRACKETS.has(character)) {
      if (!stack.length || BRACKET_PAIRS[stack.at(-1)] !== character) return line;
      stack.pop();
    }
  }

  if (inQuotedLabel || stack.length < 1 || stack.length > 2) return line;
  return line + stack.reverse().map((opener) => BRACKET_PAIRS[opener]).join('');
}

function repairFlowchart(code, repairs) {
  if (!FLOWCHART_START.test(code)) return code;
  let repairedQuotes = false;
  let repairedArrows = false;
  let repairedBrackets = false;

  const lines = code.split('\n').map((originalLine) => {
    let line = originalLine.replace(/(^|\s)->(?=\s|$)/g, '$1-->');
    if (line !== originalLine) repairedArrows = true;

    const quoted = repairQuotedLabels(line);
    line = quoted.line;
    repairedQuotes ||= quoted.changed;

    const balanced = appendMissingLineClosers(line);
    if (balanced !== line) repairedBrackets = true;
    return balanced;
  });

  if (repairedArrows) repairs.push('已修正 flowchart 單箭頭為 -->');
  if (repairedQuotes) repairs.push('已安全處理節點標籤中的雙引號');
  if (repairedBrackets) repairs.push('已補上行尾缺少的節點閉合括號');
  return lines.join('\n');
}

export function normalizeMermaidOutput(value) {
  const repairs = [];
  if (typeof value !== 'string') return { code: '', repairs };
  const code = repairFlowchart(stripOutputWrapper(value, repairs), repairs).trim();
  return { code, repairs };
}

export function validateMermaidEnvelope(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { valid: false, error: 'AI 沒有回傳 Mermaid 內容。' };
  }
  if (!DIAGRAM_DECLARATION.test(code)) {
    return { valid: false, error: 'AI 回傳內容不是完整的 Mermaid 圖表。' };
  }
  if (/```/.test(code)) {
    return { valid: false, error: 'Mermaid 內容仍包含 Markdown code block 標記。' };
  }
  const denied = DENY_RULES.find((rule) => rule.pattern.test(code));
  if (denied) return { valid: false, error: denied.error };
  if (FLOWCHART_START.test(code) && /(^|\s)->(?=\s|$)/m.test(code)) {
    return { valid: false, error: 'Flowchart 包含無效的單箭頭 ->。' };
  }
  if (FLOWCHART_START.test(code)) {
    let openSubgraphs = 0;
    for (const line of code.split(/\r?\n/)) {
      if (/^\s*subgraph\b/i.test(line)) openSubgraphs += 1;
      else if (/^\s*end\s*(?:%%.*)?$/i.test(line)) {
        if (openSubgraphs === 0) {
          return { valid: false, error: 'subgraph 與 end 數量不匹配（多餘的 end）。' };
        }
        openSubgraphs -= 1;
      }
    }
    if (openSubgraphs > 0) {
      return { valid: false, error: `subgraph 與 end 數量不匹配（缺少 ${openSubgraphs} 個 end）。` };
    }
  }

  const stack = [];
  let inQuote = false;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character === '"') inQuote = !inQuote;
    if (inQuote) continue;
    if (BRACKET_PAIRS[character]) stack.push({ character, index });
    else if (CLOSING_BRACKETS.has(character)) {
      const opener = stack.pop();
      if (!opener || BRACKET_PAIRS[opener.character] !== character) {
        return { valid: false, error: `括號不成對（字元 ${index + 1}）。` };
      }
    }
  }
  if (inQuote) return { valid: false, error: '雙引號不成對。' };
  if (stack.length) {
    return { valid: false, error: `括號不成對（字元 ${stack.at(-1).index + 1}）。` };
  }
  return { valid: true };
}

export function formatMermaidParseError(error) {
  const raw = error instanceof Error ? error.message : String(error || '未知的 Mermaid 語法錯誤');
  const compact = raw.replace(/\r/g, '').trim().slice(0, 1_200);
  const line = compact.match(/(?:line|第)\s*(\d+)/i)?.[1];
  const detail = compact.split('\n').slice(0, 8).join('\n');
  return line ? `第 ${line} 行附近無法解析：\n${detail}` : `Mermaid 無法解析：\n${detail}`;
}
