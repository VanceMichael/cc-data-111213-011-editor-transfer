// 来源文档 JSON 与门户可见编辑结果之间的语义层。
// 只描述门户可见工具栏能够表达的结构：段落、警告块、有序/无序嵌套列表、强调和链接。
// 其他结构保留在 unsupported 中，交由人工处理，录入侧不会静默丢弃。

const SUPPORTED_BLOCK_TYPES = new Set(['paragraph', 'warning', 'list']);

function normalizeRuns(value) {
  if (Array.isArray(value)) {
    return value.map(run => ({
      text: String(run.text ?? ''),
      emphasis: Boolean(run.emphasis ?? run.bold),
      link: run.link == null ? null : String(run.link)
    }));
  }
  if (typeof value === 'string') return [{ text: value, emphasis: false, link: null }];
  return [];
}

function unsupportedReason(block) {
  switch (block.type) {
    case 'table': {
      const rows = Array.isArray(block.rows) ? block.rows.length : 0;
      const caption = block.caption ? `“${block.caption}”` : '无标题';
      return `表格（${caption}，${rows} 行）无法由门户的可见工具栏创建，需人工处理。`;
    }
    case 'image':
      return `图片（${block.alt ?? block.src ?? '未命名'}）无法由可见工具栏插入，需人工处理。`;
    case 'attachment':
      return `附件（${block.name ?? '未命名'}）无法由可见工具栏插入，需人工处理。`;
    default:
      return `不支持的块类型“${String(block.type)}”，需人工处理。`;
  }
}

function blockId(block, index) {
  if (block.id != null) return String(block.id);
  const head = normalizeRuns(block.runs ?? block.text).map(run => run.text).join('').slice(0, 24);
  return head ? `${block.type}:${head}` : `${block.type}#${index}`;
}

function normalizeItem(item, parentOrdered, path, problems) {
  const runs = normalizeRuns(item.runs ?? item.text);
  const hasChildren = Array.isArray(item.children) && item.children.length > 0;
  if (!hasChildren) return { runs, children: [], childrenOrdered: null };
  const childOrdered = item.childOrdered == null ? parentOrdered : Boolean(item.childOrdered);
  if (childOrdered !== parentOrdered) {
    problems.push(
      `${path} 的子列表类型与上级列表不同（${describeOrdered(childOrdered)}嵌在${describeOrdered(parentOrdered)}中）；`
      + '门户工具栏无法稳定创建这种混合嵌套，需人工处理。'
    );
    return { runs, children: [], childrenOrdered: null };
  }
  return {
    runs,
    children: item.children.map((child, index) =>
      normalizeItem(child, childOrdered, `${path}.children[${index}]`, problems)),
    childrenOrdered: childOrdered
  };
}

function describeOrdered(value) {
  if (value === 'mixed') return '混合列表';
  if (value == null) return '无子列表';
  return value ? '有序列表' : '无序列表';
}

// 把来源 JSON 分成“浏览器可表达”与“必须留给人工”两部分，并保留原顺序。
export function planDocument(source) {
  if (!source || typeof source !== 'object') throw new Error('资料必须包含文档对象');
  if (!Array.isArray(source.blocks)) throw new Error('资料必须包含 blocks 数组');
  const blocks = [];
  const unsupported = [];
  const sequence = [];
  source.blocks.forEach((block, sourceIndex) => {
    const id = blockId(block, sourceIndex);
    if (!SUPPORTED_BLOCK_TYPES.has(block.type)) {
      const item = {
        id,
        sourceIndex,
        type: String(block.type),
        reason: unsupportedReason(block),
        source: block
      };
      unsupported.push(item);
      sequence.push({ kind: 'unsupported', item, sourceIndex });
      return;
    }
    if (block.type === 'list') {
      const problems = [];
      const items = (Array.isArray(block.items) ? block.items : []).map((item, index) =>
        normalizeItem(item, Boolean(block.ordered), `blocks[${sourceIndex}].items[${index}]`, problems));
      if (problems.length) {
        const item = {
          id,
          sourceIndex,
          type: 'list',
          reason: problems.join(' '),
          source: block
        };
        unsupported.push(item);
        sequence.push({ kind: 'unsupported', item, sourceIndex });
        return;
      }
      const supported = { id, sourceIndex, type: 'list', ordered: Boolean(block.ordered), items };
      blocks.push(supported);
      sequence.push({ kind: 'block', block: supported, sourceIndex });
      return;
    }
    const supported = { id, sourceIndex, type: block.type, runs: normalizeRuns(block.runs ?? block.text) };
    blocks.push(supported);
    sequence.push({ kind: 'block', block: supported, sourceIndex });
  });
  const firstUnsupportedIndex = sequence.findIndex(entry => entry.kind === 'unsupported');
  const gate = firstUnsupportedIndex < 0
    ? { limit: blocks.length, afterBlockId: blocks.at(-1)?.id ?? null, unsupported: [], pending: [] }
    : {
        limit: sequence.slice(0, firstUnsupportedIndex).filter(entry => entry.kind === 'block').length,
        afterBlockId: blocks[Math.max(0, sequence.slice(0, firstUnsupportedIndex).filter(entry => entry.kind === 'block').length - 1)]?.id ?? null,
        unsupported: sequence.slice(firstUnsupportedIndex).filter(entry => entry.kind === 'unsupported').map(entry => entry.item),
        pending: sequence.slice(firstUnsupportedIndex).filter(entry => entry.kind === 'block').map(entry => entry.block)
      };
  return {
    title: String(source.title ?? ''),
    revision: source.revision ?? 0,
    blocks,
    unsupported,
    sequence,
    gate,
    supportedCount: blocks.length
  };
}

// —— 回读模型（期望与实际共用） ——

function mergeRuns(runs) {
  const merged = [];
  for (const run of runs ?? []) {
    const text = String(run.text ?? '');
    if (!text) continue;
    const emphasis = Boolean(run.emphasis);
    const link = run.link == null ? null : String(run.link);
    const previous = merged[merged.length - 1];
    if (previous && previous.emphasis === emphasis && previous.link === link) previous.text += text;
    else merged.push({ text, emphasis, link });
  }
  return merged;
}

function normalizeItemForCompare(item) {
  const runs = mergeRuns(item.runs);
  const children = (item.children ?? [])
    .map(child => normalizeItemForCompare(child))
    .filter(child => child.runs.length || child.children.length);
  const childrenOrdered = children.length
    ? (item.childrenOrdered === 'mixed' ? 'mixed' : Boolean(item.childrenOrdered))
    : null;
  return { runs, children, childrenOrdered };
}

export function normalizeForCompare(model) {
  const blocks = [];
  for (const block of model.blocks ?? []) {
    if (block.type === 'paragraph' || block.type === 'warning') {
      const runs = mergeRuns(block.runs);
      if (runs.length) blocks.push({ type: block.type, runs });
      continue;
    }
    if (block.type === 'list') {
      const items = (block.items ?? [])
        .map(item => normalizeItemForCompare(item))
        .filter(item => item.runs.length || item.children.length);
      if (items.length) blocks.push({ type: 'list', ordered: Boolean(block.ordered), items });
      continue;
    }
    blocks.push({ type: 'other', description: String(block.description ?? '无法识别的结构') });
  }
  return { blocks };
}

export function runText(runs) {
  return (runs ?? []).map(run => run.text).join('');
}

// 逐字符比较：空白（含 NBSP、换行、编辑器的软空格）只视为排版，不参与比较，
// run 边界差异同样忽略；不允许文字、步骤顺序、强调位置或链接目标变化。
export function compareRuns(expectedRuns, actualRuns) {
  const expected = characterProfile(expectedRuns);
  const actual = characterProfile(actualRuns);
  if (expected.text !== actual.text) {
    return { equal: false, reason: `文字不一致：期望“${expected.text}”，回读“${actual.text}”` };
  }
  const length = Math.max(expected.chars.length, actual.chars.length);
  for (let index = 0; index < length; index += 1) {
    const left = expected.chars[index];
    const right = actual.chars[index];
    if (!right) return { equal: false, reason: `第 ${index + 1} 个字符缺失` };
    if (left.emphasis !== right.emphasis) {
      return { equal: false, reason: `“${left.char}”的强调状态不一致` };
    }
    if (left.link !== right.link) {
      return {
        equal: false,
        reason: `“${left.char}”的链接目标不一致：期望 ${left.link ?? '无'}，回读 ${right.link ?? '无'}`
      };
    }
  }
  return { equal: true };
}

function characterProfile(runs) {
  const raw = [];
  for (const run of mergeRuns(runs)) {
    for (const char of [...run.text]) raw.push({ char, emphasis: run.emphasis, link: run.link });
  }
  const chars = raw.filter(item => !/\s/.test(item.char));
  return { text: chars.map(item => item.char).join(''), chars };
}

function compareItems(expected, actual, path, differences) {
  if (expected.length !== actual.length) {
    differences.push(`${path} 的条目数量不一致：期望 ${expected.length}，回读 ${actual.length}`);
    return;
  }
  expected.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const runs = compareRuns(item.runs, actual[index].runs);
    if (!runs.equal) differences.push(`${itemPath}：${runs.reason}`);
    if (item.childrenOrdered !== actual[index].childrenOrdered) {
      differences.push(
        `${itemPath} 的子列表类型不一致：期望 ${describeOrdered(item.childrenOrdered)}，`
        + `回读 ${describeOrdered(actual[index].childrenOrdered)}`
      );
    }
    compareItems(item.children, actual[index].children, `${itemPath}.children`, differences);
  });
}

export function compareSemantics(expectedModel, actualModel) {
  const expected = normalizeForCompare(expectedModel);
  const actual = normalizeForCompare(actualModel);
  const differences = [];
  if (expected.blocks.length !== actual.blocks.length) {
    differences.push(`顶层块数量不一致：期望 ${expected.blocks.length}，回读 ${actual.blocks.length}`);
  }
  const count = Math.min(expected.blocks.length, actual.blocks.length);
  for (let index = 0; index < count; index += 1) {
    const left = expected.blocks[index];
    const right = actual.blocks[index];
    const path = `blocks[${index}]`;
    if (left.type !== right.type) {
      differences.push(
        `${path} 类型不一致：期望 ${left.type}，回读 ${right.type}`
        + `${right.description ? `（${right.description}）` : ''}`
      );
      continue;
    }
    if (left.type === 'list') {
      if (left.ordered !== right.ordered) {
        differences.push(
          `${path} 列表类型不一致：期望 ${describeOrdered(left.ordered)}，回读 ${describeOrdered(right.ordered)}`
        );
      }
      compareItems(left.items, right.items, `${path}.items`, differences);
      continue;
    }
    const runs = compareRuns(left.runs, right.runs);
    if (!runs.equal) differences.push(`${path}：${runs.reason}`);
  }
  return { equal: differences.length === 0, differences };
}

// 找出回读模型与期望块列表共同的最长前缀，用于重载后的续录边界。
export function matchingPrefixLength(expectedBlocks, actualModel) {
  const blocks = actualModel.blocks ?? [];
  let count = 0;
  while (count < expectedBlocks.length && count < blocks.length) {
    const result = compareSemantics(
      { blocks: [expectedBlocks[count]] },
      { blocks: [blocks[count]] }
    );
    if (!result.equal) break;
    count += 1;
  }
  return count;
}
