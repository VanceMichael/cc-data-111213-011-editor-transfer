// 业务语义模型：只描述门户可见工具栏能够表达的段落、有序/要点列表、强调、链接和警告。
// 录入成功与否以这个模型的回读结果为准，而不是 HTML 字符串相等。

export const WARNING_LABEL = '警告：';
export const collapseText = value => String(value ?? '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t\r\n\f]+/g, ' ')
  .trim();

export function absoluteLink(href, base) {
  if (href == null || href === '') return null;
  try { return new URL(href, base || 'http://portal.invalid/').href; }
  catch { return String(href); }
}

export function mergeRuns(runs) {
  const merged = [];
  for (const run of runs) {
    if (!run || !run.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.bold === run.bold && last.link === run.link) last.text += run.text;
    else merged.push({ text: run.text, bold: !!run.bold, link: run.link ?? null });
  }
  return merged;
}

// 在浏览器中执行：把编辑器（或任意容器）的 DOM 读成业务语义模型。
// 必须自包含，因为它会通过 Playwright 序列化进页面执行。
export function extractSemanticFromRoot(root, base) {
  if (root && typeof root === 'object' && !root.nodeType && ('root' in root || 'base' in root)) {
    base = root.base;
    root = root.root;
  }
  root = root || (typeof document !== 'undefined' ? document.body : null);
  if (!root) return { blocks: [] };
  const baseUrl = base || document.baseURI;
  const BLOCK_TAGS = ['P', 'DIV', 'BLOCKQUOTE'];
  const LIST_TAGS = ['OL', 'UL'];
  const collapse = value => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n\f]+/g, ' ')
    .trim();
  const absolute = href => {
    if (href == null || href === '') return null;
    try { return new URL(href, baseUrl).href; } catch { return String(href); }
  };

  const charsFromNodes = nodes => {
    const chars = [];
    const pushSpace = format => chars.push({ text: ' ', bold: format.bold, link: format.link });
    const walk = (node, format) => {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const char of Array.from(node.nodeValue ?? '')) {
          chars.push({ text: char, bold: format.bold, link: format.link });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'BR') { pushSpace(format); return; }
      if (tag === 'OL' || tag === 'UL' || tag === 'LI') return;
      if (tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE') {
        pushSpace(format);
        for (const child of node.childNodes) walk(child, format);
        pushSpace(format);
        return;
      }
      const weight = node.style?.fontWeight;
      const bold = format.bold || tag === 'B' || tag === 'STRONG'
        || weight === 'bold' || Number(weight) >= 600;
      const link = tag === 'A' ? (node.getAttribute('href') ?? '') : format.link;
      for (const child of node.childNodes) walk(child, { bold, link });
    };
    for (const node of nodes) walk(node, { bold: false, link: null });
    return chars;
  };

  const runsFromNodes = nodes => {
    const chars = charsFromNodes(nodes);
    while (chars.length && !chars[0].text.trim()) chars.shift();
    while (chars.length && !chars[chars.length - 1].text.trim()) chars.pop();
    const runs = [];
    let pendingSpace = false;
    for (const char of chars) {
      if (/\s/.test(char.text)) { pendingSpace = runs.length > 0; continue; }
      if (pendingSpace) {
        const last = runs[runs.length - 1];
        if (last) last.text += ' ';
        pendingSpace = false;
      }
      const last = runs[runs.length - 1];
      const link = char.link ? absolute(char.link) : null;
      if (last && last.bold === char.bold && last.link === link) last.text += char.text;
      else runs.push({ text: char.text, bold: !!char.bold, link });
    }
    return runs;
  };

  const isWarning = runs => !!runs.length && runs[0].bold && runs[0].text.startsWith('警告：');

  const classifyParagraph = runs => (isWarning(runs) ? { type: 'warning', runs } : { type: 'paragraph', runs });

  const extractList = list => {
    const type = list.tagName === 'OL' ? 'orderedList' : 'unorderedList';
    const items = [];
    let current = null;
    for (const child of list.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === 'LI') {
        const nested = [];
        const inline = [];
        for (const node of child.childNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'OL' || node.tagName === 'UL')) nested.push(node);
          else inline.push(node);
        }
        current = { runs: runsFromNodes(inline), children: nested.map(extractList) };
        items.push(current);
      } else if (child.tagName === 'OL' || child.tagName === 'UL') {
        if (!current) { current = { runs: [], children: [] }; items.push(current); }
        current.children.push(extractList(child));
      }
    }
    return { type, items };
  };

  const blocks = [];
  const extractContainer = container => {
    let inline = [];
    const flush = () => {
      const runs = runsFromNodes(inline);
      if (runs.length) blocks.push(classifyParagraph(runs));
      inline = [];
    };
    for (const node of container.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && LIST_TAGS.includes(node.tagName)) {
        flush();
        blocks.push(extractList(node));
      } else if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.includes(node.tagName)) {
        flush();
        extractContainer(node);
      } else {
        inline.push(node);
      }
    }
    flush();
  };

  extractContainer(root);
  return { blocks };
}

// 把来源 JSON 规范化成同一套语义模型。来源可以是 runs，也可以退化为 text。
export function normalizeSourceBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const normalizeRun = run => ({
    text: collapseText(run?.text),
    bold: !!run?.bold,
    link: run?.link ? absoluteLink(run.link) : null
  });
  const sourceRuns = owner => (Array.isArray(owner?.runs)
    ? owner.runs.map(normalizeRun)
    : (owner?.text ? [normalizeRun({ text: owner.text })] : [])).filter(run => run.text);

  if (block.type === 'paragraph' || block.type === 'warning') {
    let runs = mergeRuns(sourceRuns(block));
    if (block.type === 'warning') {
      if (!runs.length) return null;
      if (!(runs[0].bold && runs[0].text.startsWith(WARNING_LABEL))) {
        runs = mergeRuns([{ text: WARNING_LABEL, bold: true, link: null }, ...runs]);
      }
      return { type: 'warning', runs };
    }
    if (!runs.length) return null;
    return { type: 'paragraph', runs };
  }

  if (block.type === 'orderedList' || block.type === 'unorderedList') {
    if (!Array.isArray(block.items) || !block.items.length) return null;
    return {
      type: block.type,
      items: block.items.map(item => ({
        runs: mergeRuns(sourceRuns(item)),
        children: Array.isArray(item?.children) ? item.children.map(normalizeSourceBlock).filter(Boolean) : []
      }))
    };
  }

  return {
    type: 'unsupported',
    originalType: block.type ?? 'unknown',
    preview: collapseText(block.text ?? block.title ?? '')
  };
}

export function normalizeSourceDocument(document) {
  return { blocks: (document?.blocks ?? []).map(normalizeSourceBlock).filter(Boolean) };
}

// 门户可见工具栏只能表达一层列表。嵌套列表不能拍平，必须留给人工。
export function isSupportedBlock(block) {
  if (!block) return false;
  if (block.type === 'paragraph' || block.type === 'warning') return true;
  if (block.type === 'orderedList' || block.type === 'unorderedList') {
    return block.items.every(item => !item.children?.length);
  }
  return false;
}

export function describeBlock(block) {
  if (!block) return '空块';
  if (block.type === 'paragraph' || block.type === 'warning') {
    return `${block.type === 'warning' ? '警告块' : '段落'}「${block.runs.map(run => run.text).join('')}」`;
  }
  if (block.type === 'orderedList' || block.type === 'unorderedList') {
    return `${block.type === 'orderedList' ? '有序步骤' : '要点列表'}（${block.items.length} 项${block.items.some(item => item.children?.length) ? '，含嵌套' : ''}）`;
  }
  return `不支持的结构（${block.originalType ?? block.type}）`;
}

// 只能按顺序录入连续的支持前缀；遇到不支持的结构就停下，后面的块一并交人工，
// 避免为了“录完”而调整步骤顺序。
export function planTransfer(document) {
  const source = normalizeSourceDocument(document);
  const supported = [];
  const unsupported = [];
  for (let index = 0; index < source.blocks.length; index++) {
    const block = source.blocks[index];
    if (!unsupported.length && isSupportedBlock(block)) {
      supported.push({ index, block });
      continue;
    }
    const blocked = !isSupportedBlock(block);
    unsupported.push({
      index,
      block,
      reason: blocked
        ? (block.type === 'orderedList' || block.type === 'unorderedList'
          ? '门户可见工具栏没有缩进控件，Tab 只会移走焦点，无法表达嵌套列表'
          : `门户无法表达 ${block.originalType ?? block.type} 结构`)
        : '为保持步骤顺序，没有越过前面的不支持结构继续录入'
    });
  }
  return {
    source,
    supported,
    unsupported,
    supportedDocument: { blocks: supported.map(entry => entry.block) }
  };
}

function canonicalRuns(runs) {
  return mergeRuns((runs ?? []).map(run => ({
    text: collapseText(run.text),
    bold: !!run.bold,
    link: run.link ? absoluteLink(run.link) : null
  })).filter(run => run.text));
}

function canonicalBlock(block) {
  if (block.type === 'paragraph' || block.type === 'warning') {
    // 类型保留来源判断；警告标签的加粗会由文字段差异单独暴露，
    // 不会因为“类型仍是警告”就掩盖漏加粗。
    return { type: block.type, runs: canonicalRuns(block.runs) };
  }
  return {
    type: block.type,
    items: (block.items ?? []).map(item => ({
      runs: canonicalRuns(item.runs),
      children: (item.children ?? []).map(canonicalBlock)
    }))
  };
}

export function canonicalDocument(document) {
  return { blocks: (document?.blocks ?? []).filter(Boolean).map(canonicalBlock) };
}

function diffRuns(expected, actual, path, differences) {
  if (expected.length !== actual.length) {
    differences.push({ path: `${path}.length`, kind: 'runCount', expected: expected.length, actual: actual.length });
  }
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
    if (expected[i].text !== actual[i].text) {
      differences.push({ path: `${path}[${i}].text`, kind: 'text', expected: expected[i].text, actual: actual[i].text });
    }
    if (expected[i].bold !== actual[i].bold) {
      differences.push({ path: `${path}[${i}].bold`, kind: 'bold', expected: expected[i].bold, actual: actual[i].bold });
    }
    if (expected[i].link !== actual[i].link) {
      differences.push({ path: `${path}[${i}].link`, kind: 'link', expected: expected[i].link, actual: actual[i].link });
    }
  }
}

function diffBlock(expected, actual, path, differences) {
  if (!actual) {
    differences.push({ path, kind: 'missing', expected: expected.type, actual: null });
    return;
  }
  if (expected.type !== actual.type) {
    differences.push({ path: `${path}.type`, kind: 'type', expected: expected.type, actual: actual.type });
    return;
  }
  if (expected.type === 'paragraph' || expected.type === 'warning') {
    diffRuns(expected.runs, actual.runs, `${path}.runs`, differences);
    return;
  }
  if (expected.items.length !== actual.items.length) {
    differences.push({ path: `${path}.items`, kind: 'itemCount', expected: expected.items.length, actual: actual.items.length });
  }
  for (let i = 0; i < Math.min(expected.items.length, actual.items.length); i++) {
    diffRuns(expected.items[i].runs, actual.items[i].runs, `${path}.items[${i}].runs`, differences);
    const expectedChildren = expected.items[i].children ?? [];
    const actualChildren = actual.items[i].children ?? [];
    if (expectedChildren.length !== actualChildren.length) {
      differences.push({ path: `${path}.items[${i}].children`, kind: 'childCount', expected: expectedChildren.length, actual: actualChildren.length });
    }
    for (let j = 0; j < Math.min(expectedChildren.length, actualChildren.length); j++) {
      diffBlock(expectedChildren[j], actualChildren[j], `${path}.items[${i}].children[${j}]`, differences);
    }
  }
}

// 只忽略允许的排版归一化（空白、段落/div 包装、列表外层容器）。
// 步骤顺序、列表类型、强调和链接目标都必须一致。
export function compareSemantics(expectedDocument, actualDocument) {
  const expected = canonicalDocument(expectedDocument);
  const actual = canonicalDocument(actualDocument);
  const differences = [];
  if (expected.blocks.length !== actual.blocks.length) {
    differences.push({
      path: 'blocks.length', kind: 'blockCount',
      expected: expected.blocks.length, actual: actual.blocks.length
    });
  }
  for (let i = 0; i < Math.min(expected.blocks.length, actual.blocks.length); i++) {
    diffBlock(expected.blocks[i], actual.blocks[i], `blocks[${i}]`, differences);
  }
  return { equal: differences.length === 0, expected, actual, differences };
}

export function warningSignatures(document) {
  return canonicalDocument(document).blocks
    .filter(block => block.type === 'warning')
    .map(block => block.runs.map(run => run.text).join(''));
}

export function summarizeDifferences(differences) {
  return differences.slice(0, 8).map(difference => {
    const where = difference.path
      .replace(/^blocks\[(\d+)\]/, (_, index) => `第 ${Number(index) + 1} 块`)
      .replace(/\.items\[(\d+)\]/g, (_, index) => `第 ${Number(index) + 1} 项`)
      .replace(/\.runs\[(\d+)\]/g, (_, index) => `第 ${Number(index) + 1} 段文字`);
    const labels = { text: '文字', bold: '强调', link: '链接目标', type: '结构', itemCount: '条目数', runCount: '文字段数', blockCount: '块数', childCount: '子列表数', missing: '缺失' };
    return `${where}：${labels[difference.kind] ?? difference.kind} 期望 ${JSON.stringify(difference.expected)}，回读 ${JSON.stringify(difference.actual)}`;
  });
}
