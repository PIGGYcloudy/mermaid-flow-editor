import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMermaidParseError,
  normalizeMermaidOutput,
  validateMermaidEnvelope
} from '../shared/mermaid-output.js';

test('normalizeMermaidOutput strips markdown fences, chatter, and invisible noise', () => {
  const result = normalizeMermaidOutput(
    '\uFEFF這是產生結果：\n```mermaid\nflowchart TD\n  A[開始] --> B[完成]\n```\n希望有幫助'
  );

  assert.equal(result.code, 'flowchart TD\n  A[開始] --> B[完成]');
  assert.deepEqual(result.repairs, [
    '已移除不可見格式字元',
    '已移除 Markdown code block 標記'
  ]);
});

test('normalizeMermaidOutput only applies deterministic flowchart repairs', () => {
  const result = normalizeMermaidOutput([
    'flowchart TD',
    '  A["使用者說 "你好""] -> B[完成',
    '  B --> C["結束]'
  ].join('\n'));

  assert.equal(
    result.code,
    'flowchart TD\n  A["使用者說 &quot;你好&quot;"] --> B[完成]\n  B --> C["結束"]'
  );
  assert.deepEqual(result.repairs, [
    '已修正 flowchart 單箭頭為 -->',
    '已安全處理節點標籤中的雙引號',
    '已補上行尾缺少的節點閉合括號'
  ]);
});

test('validateMermaidEnvelope rejects incomplete or structurally malformed output', () => {
  assert.deepEqual(validateMermaidEnvelope('這不是 Mermaid'), {
    valid: false,
    error: 'AI 回傳內容不是完整的 Mermaid 圖表。'
  });
  assert.deepEqual(validateMermaidEnvelope('flowchart TD\nA[開始} --> B[完成]'), {
    valid: false,
    error: '括號不成對（字元 18）。'
  });
  assert.deepEqual(validateMermaidEnvelope('flowchart TD\nA[開始] --> B[完成]'), { valid: true });
  assert.equal(validateMermaidEnvelope('---\ntitle: only metadata\n---').valid, false);
});

test('validateMermaidEnvelope rejects deterministic unsafe Mermaid features', () => {
  const denied = [
    ['flowchart TD\n%%{init: {"theme":"dark"}}%%\nA[開始]', /directive/],
    ['flowchart TD\n%%{config: {"flowchart":{"curve":"basis"}}}%%\nA[開始]', /directive/],
    ['flowchart TD\nA --> B\nclick A "https://example.com"', /click/],
    ['flowchart TD\nA["javascript:alert(1)"]', /URI scheme/],
    ['flowchart TD\nA["https://example.com/path"]', /外部 URL/],
    ['flowchart TD\nA["<img src=x>"]', /HTML 標籤/],
    ['flowchart TD\nA["onload=run()"]', /event handler/],
    ['flowchart TD\nsubgraph SG1[群組]\nA --> B', /缺少 1 個 end/],
    ['flowchart TD\nA --> B\nend', /多餘的 end/]
  ];

  for (const [code, errorPattern] of denied) {
    const validation = validateMermaidEnvelope(code);
    assert.equal(validation.valid, false, code);
    assert.match(validation.error, errorPattern);
  }
});

test('subgraph matching is scoped to flowcharts', () => {
  assert.deepEqual(validateMermaidEnvelope([
    'flowchart TD',
    'subgraph OUTER[外層]',
    'subgraph INNER[內層]',
    'A --> B',
    'end',
    'end'
  ].join('\n')), { valid: true });
  assert.deepEqual(validateMermaidEnvelope('sequenceDiagram\nloop Retry\nA->>B: ping\nend'), {
    valid: true
  });
});

test('formatMermaidParseError exposes a bounded, user-friendly line hint', () => {
  assert.equal(
    formatMermaidParseError(new Error('Parse error on line 7:\nUnexpected token')),
    '第 7 行附近無法解析：\nParse error on line 7:\nUnexpected token'
  );
});
