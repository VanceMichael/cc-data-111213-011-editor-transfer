// 把门户 contenteditable 的可见 DOM 回读为语义模型。
// 只读取浏览器已经提交的 DOM；不修改编辑器模型，也不调用任何写入接口。
// 工具栏无法表达的结构会记入 problems，由调用方留给人工处理。

const INLINE = ['SPAN', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'FONT', 'SUB', 'SUP', 'CODE', 'MARK', 'SMALL'];
const UNSUPPORTED = ['TABLE', 'FIGURE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME'];
const SKIPPED = ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'];

// 在浏览器上下文中执行；返回 { blocks, problems }。
// 注意：该函数会被序列化后在页面内运行，因此所有依赖都必须在函数体内声明。
export function readPortalDocument(root) {
  const inlineNames = ['SPAN', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'FONT', 'SUB', 'SUP', 'CODE', 'MARK', 'SMALL'];
  const inline = new Set(inlineNames);
  const unsupported = new Set(['TABLE', 'FIGURE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME']);
  const skipped = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const problems = [];
  const blocks = [];

  const isElement = node => Boolean(node && node.nodeType === 1);
  const tagOf = node => (isElement(node) ? node.nodeName.toUpperCase() : '');
  const note = message => { if (!problems.includes(message)) problems.push(message); };

  function inlineRuns(nodes) {
    const runs = [];
    const visit = (node, state) => {
      if (node.nodeType === 3) {
        if (node.nodeValue) runs.push({ text: node.nodeValue, emphasis: state.emphasis, link: state.link });
        return;
      }
      if (!isElement(node)) return;
      const name = tagOf(node);
      if (skipped.has(name) || name === 'BR') return;
      if (name === 'OL' || name === 'UL' || name === 'BLOCKQUOTE') return;
      if (!inline.has(name)) note(`内联位置出现了无法识别的元素 ${name}，已按普通文字回读，需人工核对。`);
      let emphasis = state.emphasis || name === 'B' || name === 'STRONG';
      if (name === 'I' || name === 'EM' || name === 'U' || name === 'S') {
        note(`发现工具栏无法表达的 ${name} 样式，已按普通文字回读，需人工核对。`);
      }
      let link = state.link;
      if (name === 'A' && node.getAttribute('href') != null) {
        const href = node.getAttribute('href');
        if (link != null && link !== href) note('发现嵌套且目标不同的链接，无法用单一链接目标表达。');
        link = href;
      }
      for (const child of node.childNodes) visit(child, { emphasis, link });
    };
    for (const node of nodes) visit(node, { emphasis: false, link: null });
    return mergeRuns(runs);
  }

  function mergeRuns(runs) {
    const merged = [];
    for (const run of runs) {
      const text = String(run.text ?? '').replace(/[\r\n\t]+/g, ' ');
      if (!text) continue;
      const previous = merged[merged.length - 1];
      if (previous && previous.emphasis === run.emphasis && previous.link === run.link) previous.text += text;
      else merged.push({ text, emphasis: Boolean(run.emphasis), link: run.link ?? null });
    }
    return merged;
  }

  function readList(listNode) {
    const items = [];
    let current = null;
    const attach = (node, owner) => {
      const nestedOrdered = tagOf(node) === 'OL';
      if (owner.children.length) {
        if (owner.childrenOrdered !== 'mixed' && owner.childrenOrdered !== nestedOrdered) {
          note('同一列表项内出现有序与无序混合的子列表，门户工具栏无法稳定表达。');
          owner.childrenOrdered = 'mixed';
        }
      } else {
        owner.childrenOrdered = nestedOrdered;
      }
      owner.children.push(...readList(node));
    };
    for (const child of listNode.childNodes) {
      if (!isElement(child)) {
        if ((child.nodeValue ?? '').trim()) note('列表中出现游离文字，无法确定所属条目。');
        continue;
      }
      const name = tagOf(child);
      if (name === 'LI') {
        const item = { runs: inlineRuns(child.childNodes), children: [], childrenOrdered: null };
        for (const inner of child.childNodes) {
          if (isElement(inner) && (tagOf(inner) === 'OL' || tagOf(inner) === 'UL')) {
            attach(inner, item);
            note('列表项内部的子列表位置需要人工核对。');
          }
        }
        items.push(item);
        current = item;
        continue;
      }
      if (name === 'OL' || name === 'UL') {
        if (!current) {
          note('列表开头出现没有父条目的嵌套列表，需人工核对。');
          continue;
        }
        attach(child, current);
        continue;
      }
      if (name === 'DIV' || name === 'P') {
        if ((child.textContent ?? '').trim()) note('列表项之外出现文字，无法确定所属条目，需人工核对。');
        for (const inner of child.childNodes) {
          if (isElement(inner) && (tagOf(inner) === 'OL' || tagOf(inner) === 'UL')) {
            if (current) attach(inner, current);
            else note('列表开头出现没有父条目的嵌套列表，需人工核对。');
          }
        }
        continue;
      }
      note(`列表中出现无法识别的元素 ${name}，需人工核对。`);
    }
    return items;
  }

  function readContainer(container, ownType) {
    let pending = [];
    const flush = () => {
      const runs = inlineRuns(pending);
      pending = [];
      if (runs.length) blocks.push({ type: ownType, runs });
    };
    for (const child of container.childNodes) {
      if (child.nodeType === 3) { pending.push(child); continue; }
      if (!isElement(child)) continue;
      const name = tagOf(child);
      if (skipped.has(name)) continue;
      if (inline.has(name) || name === 'BR') { pending.push(child); continue; }
      flush();
      readBlock(child);
    }
    flush();
  }

  function readBlock(node) {
    const name = tagOf(node);
    if (skipped.has(name)) return;
    if (name === 'OL' || name === 'UL') {
      blocks.push({ type: 'list', ordered: name === 'OL', items: readList(node) });
      return;
    }
    if (name === 'P' || name === 'DIV') { readContainer(node, 'paragraph'); return; }
    if (name === 'BLOCKQUOTE') { readContainer(node, 'warning'); return; }
    if (unsupported.has(name)) {
      note(`门户中出现 ${name} 结构，工具栏无法表达，需人工处理。`);
      blocks.push({ type: 'other', description: `${name} 结构` });
      return;
    }
    if (inline.has(name)) { readContainer(node, 'paragraph'); return; }
    note(`门户中出现未知块 ${name}，需人工核对。`);
    blocks.push({ type: 'other', description: `${name} 结构` });
  }

  readContainer(root, 'paragraph');

  const hasText = runs => runs.some(run => String(run.text ?? '').trim().length > 0);
  const itemHasText = item => hasText(item.runs) || item.children.some(itemHasText);
  const filtered = blocks.filter(block => {
    if (block.type === 'other') return true;
    if (block.type === 'list') return block.items.some(itemHasText);
    return hasText(block.runs);
  });
  return { blocks: filtered, problems };
}
