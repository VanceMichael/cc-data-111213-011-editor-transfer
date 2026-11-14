// 浏览器录入：只通过门户可见的工具栏按钮、键盘输入与输入法提交来写入 contenteditable。
// 不使用任何 HTML 字符串回填、不修改编辑器内部模型、不调用后台写入接口。
// 成功与否以页面回读后的业务语义比较为准，而不是 HTML 字符串相等。

import { chromium } from 'playwright';
import { startPortal } from './portal.js';
import {
  compareSemantics,
  matchingPrefixLength,
  planDocument,
  runText
} from './semantics.js';
import { readPortalDocument } from './readback.js';

const READER = readPortalDocument.toString();
const BOLD = '强调';
const PARAGRAPH = '段落';
const WARNING = '警告块';

export class EntryConflictError extends Error {
  constructor(detail) {
    super('草稿修订冲突：已停止写入，未覆盖他人内容');
    this.name = 'EntryConflictError';
    this.conflict = detail;
  }
}

export class EntryVerificationError extends Error {
  constructor(detail) {
    super('回读语义与来源不一致');
    this.name = 'EntryVerificationError';
    this.verification = detail;
  }
}

export class ExistingContentError extends Error {
  constructor(existing) {
    super('草稿已有内容；未显式允许替换时不会清空');
    this.name = 'ExistingContentError';
    this.existing = existing;
  }
}

const charsOf = value => [...String(value ?? '')];

function blockSummary(block) {
  if (block.type === 'list') {
    return {
      type: 'list',
      ordered: block.ordered,
      items: block.items.length,
      text: block.items.map(item => runText(item.runs)).join(' / ').slice(0, 80)
    };
  }
  return { type: block.type, text: runText(block.runs).slice(0, 80) };
}

function flattenItems(items, depth = 1, output = []) {
  for (const item of items) {
    output.push({ item, depth });
    flattenItems(item.children ?? [], depth + 1, output);
  }
  return output;
}

function styleRanges(runs) {
  const text = runText(runs);
  const emphasis = [];
  const links = [];
  let offset = 0;
  for (const run of runs) {
    const length = charsOf(run.text).length;
    if (run.emphasis && length) emphasis.push([offset, offset + length]);
    if (run.link && length) links.push([offset, offset + length, run.link]);
    offset += length;
  }
  return { text, length: offset, emphasis, links };
}

export class DraftEntry {
  constructor({ page, plan, options = {}, hooks = {} }) {
    this.page = page;
    this.plan = plan;
    this.options = options;
    this.hooks = hooks;
    this.cdp = null;
    this.revision = null;
    this.boundaries = [];
    this.verifiedBlocks = 0;
  }

  editor() { return this.page.getByRole('textbox', { name: '说明正文' }); }
  notice() { return this.page.locator('#notice'); }
  revisionLabel() { return this.page.locator('#revision'); }
  button(name) { return this.page.getByRole('button', { name, exact: true }); }

  async initialize() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.page.goto(this.options.portalUrl);
    await this.page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
    this.revision = await this.visibleRevision();
    // 页面刚读取时编辑器内容就是已持久化内容；把与来源一致的前缀记为已核验，
    // 使新会话可以从“中途重新读取”处继续，而不会误报未保存内容。
    const baseline = await this.readDocument();
    this.verifiedBlocks = Math.min(
      matchingPrefixLength(this.plan.blocks, baseline),
      this.plan.gate.limit
    );
  }

  async visibleRevision() {
    const text = await this.revisionLabel().textContent();
    const match = /修订\s*(\d+)/.exec(text ?? '');
    if (!match) throw new Error(`无法读取草稿修订号：${text}`);
    return Number(match[1]);
  }

  async noticeText() { return (await this.notice().textContent()) ?? ''; }

  async readDocument() {
    return this.page.evaluate(source => {
      const factory = eval(`(${source})`);
      return factory(document.querySelector('#editor'));
    }, READER);
  }

  // —— 可见交互 ——

  async caretInEditor() {
    return this.page.evaluate(() => document.activeElement?.id === 'editor');
  }

  // 任何操作前把光标放到正文末尾，避免点击落在正文中间。
  async focusEnd() {
    await this.editor().click();
    await this.page.keyboard.press('Control+End');
    if (!(await this.caretInEditor())) throw new Error('编辑器未获得焦点');
  }

  async clearDocument() {
    await this.focusEnd();
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.press('Delete');
  }

  // 输入法合成：先给出组合串，再由浏览器以提交事件落字。
  async compose(text) {
    const value = String(text ?? '');
    if (!value) return;
    await this.cdp.send('Input.imeSetComposition', {
      text: value, selectionStart: value.length, selectionEnd: value.length
    });
    await this.cdp.send('Input.insertText', { text: value });
  }

  async blockInfo() {
    return this.page.evaluate(() => ({
      format: String(document.queryCommandValue('formatBlock') || ''),
      bold: document.queryCommandState('bold'),
      focused: document.activeElement?.id === 'editor'
    }));
  }

  async clearBold() {
    const info = await this.blockInfo();
    if (!info.bold) return;
    await this.button(BOLD).click();
    if ((await this.blockInfo()).bold) throw new Error('无法关闭继承的强调状态');
  }

  async ensureParagraph() {
    await this.focusEnd();
    await this.button(PARAGRAPH).click();
    await this.clearBold();
  }

  async selectedText() {
    return this.page.evaluate(() => (getSelection()?.toString() ?? '').replace(/\u00a0/g, ' '));
  }

  // 从当前块开头按字符数重选；每次尝试都重新定位，避免选区因焦点变化丢失。
  async selectRangeFromStart(start, end) {
    await this.page.keyboard.press('Home');
    for (let index = 0; index < start; index += 1) await this.page.keyboard.press('ArrowRight');
    for (let index = 0; index < end - start; index += 1) await this.page.keyboard.press('Shift+ArrowRight');
  }

  // 模拟选区丢失（点击别处、焦点变化），验证下一次尝试会重新定位并重选。
  // 返回 true 表示本次尝试的选区已被外部干扰清除，需要重试。
  async disturbSelectionIfRequested() {
    if (!this.options.disturbSelection) return false;
    this.options.disturbSelection -= 1;
    await this.page.evaluate(() => {
      getSelection()?.removeAllRanges();
      document.activeElement?.blur();
    });
    return true;
  }

  async styleText(ranges) {
    for (const [start, end] of ranges.emphasis) {
      let applied = false;
      for (let attempt = 0; attempt < 4 && !applied; attempt += 1) {
        await this.focusEnd();
        await this.selectRangeFromStart(start, end);
        if (await this.disturbSelectionIfRequested()) continue;
        if (!(await this.selectedText()).trim()) continue;
        await this.button(BOLD).click();
        applied = true;
      }
      if (!applied) throw new EntryVerificationError({ differences: ['无法在强调范围内保持选区'] });
    }
    for (const [start, end, target] of ranges.links) {
      let applied = false;
      for (let attempt = 0; attempt < 4 && !applied; attempt += 1) {
        await this.focusEnd();
        await this.selectRangeFromStart(start, end);
        if (await this.disturbSelectionIfRequested()) continue;
        if (!(await this.selectedText()).trim()) continue;
        const before = await this.page.evaluate(() => document.querySelectorAll('#editor a').length);
        let settle;
        const dialog = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('链接输入框未出现')), 4000);
          settle = async prompt => {
            clearTimeout(timer);
            if (!prompt) { reject(new Error('链接输入框未出现')); return; }
            try { await prompt.accept(target); resolve(); } catch (error) { reject(error); }
          };
        });
        const handler = prompt => { settle(prompt); };
        this.page.once('dialog', handler);
        try {
          await this.button('链接').click();
          await dialog;
        } catch (error) {
          this.page.off('dialog', handler);
          throw new EntryVerificationError({ differences: [`链接输入失败：${error.message}`] });
        }
        await this.page.waitForFunction(
          count => document.querySelectorAll('#editor a').length > count,
          before, { timeout: 4000 }
        );
        applied = true;
      }
      if (!applied) throw new EntryVerificationError({ differences: ['无法创建链接选区'] });
    }
  }

  async enterParagraph(block) {
    await this.ensureParagraph();
    const ranges = styleRanges(block.runs);
    await this.compose(ranges.text);
    await this.styleText(ranges);
  }

  async enterWarning(block) {
    await this.ensureParagraph();
    await this.button(WARNING).click();
    const ranges = styleRanges(block.runs);
    await this.compose(ranges.text);
    await this.styleText(ranges);
  }

  async finishParagraph() {
    await this.page.keyboard.press('End');
    await this.page.keyboard.press('Enter');
    await this.clearBold();
  }

  async finishWarning() {
    await this.page.keyboard.press('End');
    await this.page.keyboard.press('Enter');
    await this.clearBold();
    await this.button(PARAGRAPH).click();
    await this.clearBold();
  }

  async caretContext() {
    return this.page.evaluate(() => {
      let node = getSelection()?.anchorNode;
      const editor = document.querySelector('#editor');
      let inList = false;
      let inItem = false;
      while (node && node !== editor) {
        if (node.nodeName === 'OL' || node.nodeName === 'UL') inList = true;
        if (node.nodeName === 'LI') inItem = true;
        node = node.parentNode;
      }
      return { inList, inItem };
    });
  }

  // 用可见的 Enter 逐层退出列表，不猜测层级数字。
  async exitList() {
    for (let guard = 0; guard < 24; guard += 1) {
      const context = await this.caretContext();
      if (!context.inList && !context.inItem) return;
      await this.page.keyboard.press('Enter');
      await this.clearBold();
    }
    throw new Error('无法用 Enter 退出列表');
  }

  async indent(delta) {
    for (let index = 0; index < Math.abs(delta); index += 1) {
      await this.button(delta > 0 ? '增加缩进' : '减少缩进').click();
    }
  }

  async enterList(block) {
    await this.ensureParagraph();
    await this.button(block.ordered ? '有序步骤' : '要点').click();
    const flat = flattenItems(block.items);
    let currentDepth = 1;
    for (const [index, entry] of flat.entries()) {
      if (index > 0) {
        await this.page.keyboard.press('End');
        await this.page.keyboard.press('Enter');
        await this.clearBold();
        await this.indent(entry.depth - currentDepth);
        await this.clearBold();
      }
      const ranges = styleRanges(entry.item.runs);
      await this.compose(ranges.text);
      await this.styleText(ranges);
      currentDepth = entry.depth;
    }
    await this.page.keyboard.press('End');
    await this.page.keyboard.press('Enter');
    await this.clearBold();
    await this.exitList();
    await this.ensureParagraph();
  }

  // —— 保存与冲突 ——

  // 草稿修订号是“我看到并已验证的版本”。它被推进或提示出现冲突时停止。
  async assertUnchanged() {
    const notice = await this.noticeText();
    if (notice.includes('冲突')) {
      throw new EntryConflictError({ notice, revision: await this.visibleRevision() });
    }
    const revision = await this.visibleRevision();
    if (this.revision != null && revision !== this.revision) {
      throw new EntryConflictError({
        notice: notice || '草稿已被其他编辑者修改',
        expectedRevision: this.revision,
        revision
      });
    }
  }

  async waitForNotice(text, timeout = 8000) {
    await this.page.waitForFunction(
      value => document.querySelector('#notice').textContent.includes(value),
      text, { timeout }
    );
  }

  async waitForSaveOutcome(before, { timeout } = {}) {
    const saveDelay = Number(this.options.saveDelay ?? 0);
    const deadline = Date.now() + (timeout ?? saveDelay + 20000);
    let stableSince = null;
    while (Date.now() < deadline) {
      const notice = await this.noticeText();
      const revision = await this.visibleRevision();
      if (notice.includes('冲突')) {
        throw new EntryConflictError({ notice, revision, expectedRevision: before });
      }
      if (revision > before && notice === '草稿已保存') {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= 80) {
          this.revision = revision;
          return revision;
        }
      } else {
        stableSince = null;
      }
      await this.page.waitForTimeout(25);
    }
    throw new Error('保存未在时限内完成');
  }

  // 录入时的输入会触发门户自己的自动保存。这里只等待并采纳它产生的修订号，
  // 不把它误判为他人修改；真正的他人修改在边界开始时修订号仍不变即可发现。
  async settleAutosave(knownRevision, { quiet = 900 } = {}) {
    const deadline = Date.now() + quiet * 2 + Number(this.options.saveDelay ?? 0) * 3;
    let last = knownRevision;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      const notice = await this.noticeText();
      if (notice.includes('冲突')) {
        throw new EntryConflictError({ notice, revision: await this.visibleRevision() });
      }
      const revision = await this.visibleRevision();
      if (revision !== last) {
        last = revision;
        quietSince = Date.now();
      } else if (notice === '草稿已保存' && Date.now() - quietSince >= quiet) {
        this.revision = revision;
        return { revision, changed: revision !== knownRevision };
      }
      await this.page.waitForTimeout(25);
    }
    this.revision = await this.visibleRevision();
    return { revision: this.revision, changed: this.revision !== knownRevision };
  }

  // 显式保存草稿：只按“保存草稿”按钮，并等待修订号前进且提示稳定。
  // 这里不先比对修订号：本页自动保存可能仍在飞行中；它属于本次录入，
  // 由门户自身的保存队列串行化。真正的他人修改由边界开头的重新读取发现。
  async saveDraft() {
    const before = this.revision ?? await this.visibleRevision();
    const startedAt = Date.now();
    await this.button('保存草稿').click();
    const revision = await this.waitForSaveOutcome(before);
    return { revision, elapsedMs: Date.now() - startedAt };
  }

  async reloadVisible() {
    // 提示文本可能还是上一次的值；同时等待“重新读取”发出的真实 GET 响应，
    // 避免把旧提示误当成新的读取结果。
    const response = this.page.waitForResponse(
      reply => reply.url().endsWith('/api/document') && reply.request().method() === 'GET',
      { timeout: 8000 }
    );
    await this.button('重新读取').click();
    await response;
    await this.waitForNotice('草稿已读取');
    this.revision = await this.visibleRevision();
  }

  // 冲突发生后：先记录本地未保存的编辑，再用可见的“重新读取”查看他人内容，
  // 然后说明差异。不重试、不覆盖，是否合并由人工决定。
  remotePrefixedBlocks(remote) {
    return matchingPrefixLength(this.plan.blocks, remote);
  }

  async describeConflict(error) {
    const localBeforeReload = await this.readDocument().catch(() => null);
    const before = this.revision;
    try {
      await this.reloadVisible();
    } catch (reloadError) {
      return {
        ...error.conflict,
        localBeforeReload,
        remote: null,
        reloadError: reloadError.message,
        localEditsPreserved: false,
        guidance: '无法读取他人内容；本地编辑仍留在编辑器中，请人工处理。'
      };
    }
    const remote = await this.readDocument();
    const localPrefix = localBeforeReload
      ? matchingPrefixLength(this.plan.blocks, localBeforeReload)
      : 0;
    const remoteComparison = compareSemantics({ blocks: this.plan.blocks }, remote);
    // 他人版本中多出来的块（例如人工追加的警告）只做说明，绝不覆盖或删除。
    const extraRemoteBlocks = remote.blocks.slice(this.remotePrefixedBlocks(remote));
    return {
      ...error.conflict,
      localBeforeReload,
      remote,
      remoteRevision: this.revision,
      revisionBeforeReload: before,
      localVerifiedPrefix: localPrefix,
      localBlockCount: localBeforeReload?.blocks.length ?? 0,
      remoteBlockCount: remote.blocks.length,
      extraRemoteBlocks,
      differencesAgainstIntendedRemotely: remoteComparison.differences,
      readbackProblems: remote.problems,
      localEditsPreserved: false,
      guidance: extraRemoteBlocks.length
        ? '冲突已说明，未继续写入。他人版本含来源之外的额外内容，录入不会覆盖；重新读取已丢弃本地未保存输入，请人工对照后再决定如何继续。'
        : '冲突已说明，未继续写入。重新读取已丢弃本地未保存输入；请人工对照两侧内容后再决定如何继续。'
    };
  }

  // —— 回读验证 ——

  async verifyPrefix(count) {
    const actual = await this.readDocument();
    const result = compareSemantics({ blocks: this.plan.blocks.slice(0, count) }, actual);
    const problems = actual.problems ?? [];
    return {
      ...result,
      equal: result.equal && problems.length === 0,
      differences: problems.length
        ? [...result.differences, ...problems.map(problem => `回读警告：${problem}`)]
        : result.differences,
      actual
    };
  }

  // 保护编辑器里尚未保存的人工修改：如果正文不再等于上次已核验的边界，
  // 绝不直接“重新读取”把别人的输入冲掉，而是先说明冲突。
  async guardEditorState() {
    const actual = await this.readDocument();
    const prefix = matchingPrefixLength(this.plan.blocks, actual);
    // 浏览器可能在末尾留下一个空块；只有其后没有其它内容时才忽略。
    const trailingEmpty = prefix >= this.verifiedBlocks && actual.blocks
      .slice(prefix)
      .every(block => block.type !== 'list'
        && !(block.runs ?? []).some(run => String(run.text ?? '').trim().length > 0));
    if (prefix !== this.verifiedBlocks || !trailingEmpty || actual.problems.length) {
      const detail = {
        kind: '编辑器含未保存或无法识别的内容',
        expectedBlocks: this.verifiedBlocks,
        matchingPrefix: prefix,
        actualBlocks: actual.blocks.length,
        problems: actual.problems,
        actual,
        guidance: '录入已停止，未重新读取、未覆盖编辑器中的现有内容。请人工核对后再决定如何继续。'
      };
      if (this.hooks.onUnsavedContent) await this.hooks.onUnsavedContent(this, detail);
      throw new EntryConflictError(detail);
    }
  }

  // 边界开始时用可见的“重新读取”核对他人是否已推进修订号。
  // 此时编辑器中只有上次边界已持久化的内容，重新读取不会丢本地输入。
  async refreshAndCheck() {
    const expected = this.revision;
    await this.reloadVisible();
    if (expected != null && this.revision !== expected) {
      throw new EntryConflictError({
        notice: '草稿修订号已在其他编辑者保存后推进',
        expectedRevision: expected,
        revision: this.revision,
        remote: await this.readDocument()
      });
    }
  }

  // 一个可重试的编辑边界：核对修订 → 写入一块 → 回读比较 → 保存 → 重新读取 → 再次回读。
  async checkpoint(index) {
    const block = this.plan.blocks[index];
    await this.guardEditorState();
    await this.refreshAndCheck();

    if (block.type === 'list') await this.enterList(block);
    else if (block.type === 'warning') {
      await this.enterWarning(block);
      await this.finishWarning();
    } else {
      await this.enterParagraph(block);
      await this.finishParagraph();
    }

    // 门户会在输入后自动保存；先等它落定并把新修订号记为本地结果。
    // 这既避免把自动保存误报为他人修改，也保证显式保存基于最新修订。
    const settled = await this.settleAutosave(this.revision);
    if (this.hooks.afterAutosaveSettled) await this.hooks.afterAutosaveSettled(this, settled);
    // 自动保存与显式保存之间仍可能插入他人保存；这里再读一次修订号。
    if (this.revision !== (await this.visibleRevision())) {
      throw new EntryConflictError({
        notice: '自动保存后草稿修订号再次变化',
        expectedRevision: this.revision,
        revision: await this.visibleRevision()
      });
    }
    const local = await this.verifyPrefix(index + 1);
    if (!local.equal) {
      throw new EntryVerificationError({
        boundary: index,
        blockId: block.id,
        phase: '保存前回读',
        differences: local.differences,
        actual: local.actual
      });
    }
    if (this.hooks.beforeSave) await this.hooks.beforeSave(this, index + 1);
    const saved = await this.saveDraft();
    await this.reloadVisible();
    const persisted = await this.verifyPrefix(index + 1);
    if (!persisted.equal) {
      throw new EntryVerificationError({
        boundary: index,
        blockId: block.id,
        phase: '重新读取后回读',
        differences: persisted.differences,
        actual: persisted.actual
      });
    }
    const boundary = {
      blockIndex: index,
      blockId: block.id,
      sourceIndex: block.sourceIndex,
      summary: blockSummary(block),
      draftRevision: saved.revision,
      saveElapsedMs: saved.elapsedMs,
      verifiedBeforeSave: true,
      verifiedAfterReload: true
    };
    this.boundaries.push(boundary);
    this.verifiedBlocks = index + 1;
    if (this.hooks.afterCheckpoint) await this.hooks.afterCheckpoint(this, boundary);
    return boundary;
  }

  // 不可越过第一个不受支持的结构：否则步骤顺序会被改变。
  entryLimit() {
    const requested = this.options.maxSupportedBlocks ?? this.plan.gate.limit;
    return Math.min(requested, this.plan.gate.limit);
  }

  completionReport(limit) {
    return {
      draftRevision: this.revision,
      clearedExistingContent: this.clearedRevision ?? null,
      published: false,
      publication: '未发布：门户没有可见发布控件，草稿修订号不等于最终发布。',
      editableBoundaries: this.boundaries.length,
      enteredBlockCount: limit,
      unsupported: this.plan.unsupported.map(item => ({
        id: item.id, type: item.type, sourceIndex: item.sourceIndex, reason: item.reason
      })),
      pendingAfterGate: this.plan.blocks.slice(limit).map(block => ({
        id: block.id,
        sourceIndex: block.sourceIndex,
        summary: blockSummary(block),
        reason: limit < this.plan.gate.limit
          ? '本次运行按调用方要求提前停止，未录入。'
          : '位于需人工处理的结构之后，为避免改变步骤顺序未录入。'
      }))
    };
  }

  // 显式替换已有草稿：先在页面内清空，再用可见的“保存草稿”把清空结果持久化。
  // 这样边界开始时的“重新读取”不会把旧内容带回来，也不会产生未保存的临时状态。
  async prepareReplacement() {
    await this.clearDocument();
    await this.settleAutosave(this.revision);
    const saved = await this.saveDraft();
    this.clearedRevision = saved.revision;
    this.verifiedBlocks = 0;
    this.boundaries = [];
    await this.reloadVisible();
    return saved.revision;
  }

  async run() {
    const limit = this.entryLimit();
    for (let index = 0; index < limit; index += 1) await this.checkpoint(index);
    await this.reloadVisible();
    const verification = await this.verifyPrefix(limit);
    return {
      plan: this.plan,
      gate: this.plan.gate,
      boundaries: this.boundaries,
      verification,
      ...this.completionReport(limit)
    };
  }

  // 中途重新读取后继续：只有回读内容与来源前缀完全一致才续录；
  // 出现额外内容（例如他人写入的警告）就停下并说明冲突，不追加、不覆盖。
  async resume({ maxSupportedBlocks } = {}) {
    // 续录前先看编辑器：有来源之外的额外内容（例如他人追加的警告）就停下，
    // 不重新读取、不追加，也不覆盖。
    const limit = Math.min(maxSupportedBlocks ?? this.entryLimit(), this.plan.gate.limit);
    await this.guardEditorState();
    await this.reloadVisible();
    const actual = await this.readDocument();
    const prefix = Math.min(matchingPrefixLength(this.plan.blocks, actual), limit);
    if (actual.blocks.length !== prefix || actual.problems.length) {
      throw new EntryConflictError({
        kind: '重新读取后发现来源之外的额外内容',
        matchingPrefix: prefix,
        actualBlocks: actual.blocks.length,
        problems: actual.problems,
        revision: this.revision,
        remote: actual,
        guidance: '请人工核对额外内容后再继续，录入未追加任何块。'
      });
    }
    this.verifiedBlocks = prefix;
    const boundaries = [];
    for (let index = prefix; index < limit; index += 1) boundaries.push(await this.checkpoint(index));
    await this.reloadVisible();
    const verification = await this.verifyPrefix(limit);
    return {
      plan: this.plan,
      gate: this.plan.gate,
      resumedFromPrefix: prefix,
      boundaries,
      verification,
      ...this.completionReport(limit)
    };
  }
}

export function createPlan(source) {
  return planDocument(source);
}

export async function enterAgainstPortal({
  page, source, replaceExisting = false, options = {}, hooks = {}
}) {
  const plan = planDocument(source);
  const entry = new DraftEntry({ page, plan, options, hooks });
  await entry.initialize();
  const existing = await entry.readDocument();
  const hasContent = (existing.blocks ?? []).some(block => block.type !== 'other');
  if (hasContent && !replaceExisting) throw new ExistingContentError(existing);
  const clearedRevision = replaceExisting && hasContent ? await entry.prepareReplacement() : null;
  const result = await entry.run();
  return { ...result, plan, unsupported: plan.unsupported, clearedRevision };
}

export async function enterWithPortal({
  source, saveDelay = 0, replaceExisting = false, options = {}, hooks = {}, browser
} = {}) {
  const plan = planDocument(source);
  if (!plan.blocks.length) throw new Error('来源中没有可录入的受支持块');
  const portal = await startPortal({ saveDelay });
  const engine = browser ?? await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ownBrowser = !browser;
  const page = await engine.newPage();
  try {
    const entry = new DraftEntry({ page, plan, options: { ...options, portalUrl: portal.url, saveDelay }, hooks });
    await entry.initialize();
    const existing = await entry.readDocument();
    const hasContent = (existing.blocks ?? []).some(block => block.type !== 'other');
    if (hasContent && !replaceExisting) throw new ExistingContentError(existing);
    const clearedRevision = replaceExisting && hasContent ? await entry.prepareReplacement() : null;
    const result = await entry.run();
    return { ...result, plan, unsupported: plan.unsupported, clearedRevision };
  } finally {
    await page.close();
    if (ownBrowser) await engine.close();
    await portal.close();
  }
}
