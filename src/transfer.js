// 通过门户的可见工具栏录入结构化资料。
// 只使用点击工具栏、键盘输入、选区、撤销这类用户可执行的操作；
// 不往编辑器内部模型塞数据，也不调用后台写入接口代替人工保存。

import { setTimeout as sleep } from 'node:timers/promises';
import {
  compareSemantics, describeBlock, extractSemanticFromRoot, planTransfer,
  summarizeDifferences, warningSignatures
} from './semantic.js';

const EDITOR_LABEL = '说明正文';
const TOOLS = { bold: '强调', orderedList: '有序步骤', unorderedList: '要点', link: '链接' };

const editor = page => page.getByRole('textbox', { name: EDITOR_LABEL });
const isList = block => block?.type === 'orderedList' || block?.type === 'unorderedList';

export async function readEditorSemantics(page, base = page.url()) {
  return editor(page).evaluate(extractSemanticFromRoot, base);
}

export async function readNotice(page) {
  return page.locator('#notice').textContent();
}

export async function readRevision(page) {
  const text = await page.locator('#revision').textContent();
  const match = /修订\s*(\d+)/.exec(text ?? '');
  return match ? Number(match[1]) : null;
}

async function readServerDocument(page) {
  return page.evaluate(() => fetch('/api/document').then(response => response.json()));
}

const sameBlocks = (left, right) => compareSemantics({ blocks: left }, { blocks: right }).equal;

function isPrefix(prefix, blocks) {
  return prefix.length <= blocks.length && sameBlocks(prefix, blocks.slice(0, prefix.length));
}

function lastType(blocks) {
  if (!blocks.length) return null;
  return isList(blocks[blocks.length - 1]) ? 'list' : 'text';
}

async function clickTool(page, name) {
  await page.getByRole('button', { name }).click();
  await sleep(15);
}

async function boldState(page) {
  return page.evaluate(() => document.queryCommandState('bold'));
}

async function alignBold(page, want) {
  if (await boldState(page) !== want) await clickTool(page, TOOLS.bold);
}

async function focusEditor(page) {
  await editor(page).click();
  await page.keyboard.press('Control+End');
}

// 选区可能在自动保存、重载或输入法合成后丢失。每次施加格式前核对选区长度，
// 不一致就把整个块当作可重试失败，按语义断点撤销后重来。
async function selectionLength(page) {
  return page.evaluate(() => {
    const selection = document.getSelection();
    return selection && selection.rangeCount ? selection.toString().length : 0;
  });
}

async function selectBackwards(page, count) {
  for (let index = 0; index < count; index++) {
    await page.keyboard.press('Shift+ArrowLeft');
    if (await selectionLength(page) !== index + 1) throw new Error('选区在录入过程中丢失');
  }
}

class RetryableEntryError extends Error {}

async function enterRuns(page, runs, options) {
  for (const run of runs) {
    await alignBold(page, run.bold);
    await page.keyboard.insertText(run.text);
    if (!run.bold && !run.link) continue;
    const length = Array.from(run.text).length;
    await selectBackwards(page, length);
    if (await selectionLength(page) !== length) throw new RetryableEntryError('格式化选区长度不符');
    if (run.bold) await alignBold(page, true);
    if (run.link) await createLink(page, run.link, options);
    await page.keyboard.press('ArrowRight');
    await alignBold(page, false);
  }
}

async function createLink(page, target, options) {
  let answer = target;
  const prompt = options.linkPrompt ?? (async value => value);
  answer = await prompt(target, options);
  const dialogPromise = page.waitForEvent('dialog');
  const click = page.getByRole('button', { name: TOOLS.link }).click();
  const dialog = await dialogPromise;
  await dialog.accept(answer === false || answer == null ? '' : String(answer));
  await click;
  await sleep(20);
}

async function enterBlock(page, block, previousType, options) {
  if (previousType) {
    await page.keyboard.press('Enter');
    if (previousType === 'list') await page.keyboard.press('Enter');
  }
  if (isList(block)) {
    await clickTool(page, block.type === 'orderedList' ? TOOLS.orderedList : TOOLS.unorderedList);
    for (let index = 0; index < block.items.length; index++) {
      if (index > 0) await page.keyboard.press('Enter');
      await enterRuns(page, block.items[index].runs, options);
    }
    return 'list';
  }
  await enterRuns(page, block.runs, options);
  return 'text';
}

async function reloadEditor(page) {
  await page.getByRole('button', { name: '重新读取' }).click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已读取'), null, { timeout: 5000 })
    .catch(() => {});
  await sleep(40);
}

// 等编辑器内容稳定，避免在输入法合成尚未提交时回读。
async function waitForEditorStable(page, base, timeout = 3000) {
  const started = Date.now();
  let previous = null;
  let stable = 0;
  while (Date.now() - started < timeout) {
    const current = await readEditorSemantics(page, base);
    const signature = JSON.stringify(current.blocks);
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 2) return current;
    await sleep(80);
  }
  return readEditorSemantics(page, base);
}

// 撤销栈回退边界：按业务语义判断是否回到断点，不比较 HTML。
async function restoreTo(page, expectedBlocks, base) {
  for (let step = 0; step < 160; step++) {
    const current = await readEditorSemantics(page, base);
    if (sameBlocks(current.blocks, expectedBlocks)) return true;
    const behind = current.blocks.length < expectedBlocks.length
      && isPrefix(current.blocks, expectedBlocks);
    await page.keyboard.press(behind ? 'Control+Shift+z' : 'Control+z');
    await sleep(25);
  }
  return sameBlocks((await readEditorSemantics(page, base)).blocks, expectedBlocks);
}

async function waitForConflictOrSave(page, baselineRevision, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const notice = await readNotice(page);
    if (notice.includes('冲突')) return { conflict: true, notice, elapsed: Date.now() - started };
    const revision = await readRevision(page);
    if (notice === '草稿已保存' && revision !== null && revision > baselineRevision) {
      return { conflict: false, notice, revision, elapsed: Date.now() - started };
    }
    await sleep(80);
  }
  return { timeout: true, notice: await readNotice(page), elapsed: Date.now() - started };
}

// 冲突：先重新读取对方版本并判断对方是否写了本次来源之外的警告，
// 然后停下交人工；不自动合并，也不覆盖。
async function describeConflict(page, plan, base, notice) {
  await sleep(900);
  await reloadEditor(page);
  const remote = await readEditorSemantics(page, base);
  const remoteRevision = await readRevision(page);
  const expectedWarnings = warningSignatures(plan.supportedDocument);
  const foreignWarnings = warningSignatures(remote).filter(warning => !expectedWarnings.includes(warning));
  return {
    status: 'conflict',
    message: notice,
    conflict: {
      remoteRevision,
      foreignWarnings,
      remoteSemantics: remote,
      expectedSemantics: plan.supportedDocument,
      resolution: foreignWarnings.length
        ? '对方草稿含本次来源之外的警告，已保留对方版本；请人工合并后再录入。'
        : '草稿修订已被他人推进，已重新读取对方版本；请人工确认后再继续。'
    },
    draftRevision: remoteRevision,
    published: false
  };
}

/**
 * 把来源资料录入当前草稿，并按语义回读确认。
 * - 只处理连续的支持前缀；遇到不支持结构立即停止并交人工。
 * - 每个块是一个可重试边界：回读不符时撤销到该块之前的语义断点再重录。
 * - draftRevision 是草稿修订号；published/finalPublish 始终是人工步骤。
 */
export async function runTransfer(page, sourceDocument, options = {}) {
  const startedAt = Date.now();
  const plan = options.plan ?? planTransfer(sourceDocument);
  const target = plan.supportedDocument.blocks;
  const base = options.base ?? page.url();
  const maxAttempts = options.maxAttempts ?? 2;
  const stopAfter = options.stopAfter ?? null;
  const persist = options.persist !== false;

  await editor(page).waitFor({ state: 'visible' });
  const baselineRevision = options.baselineRevision ?? await readRevision(page);
  const initial = await readEditorSemantics(page, base);

  if (target.length === 0) {
    return {
      status: 'blocked',
      reason: '来源没有任何可由门户可见工具栏表达的块，未改动草稿',
      plan, draftRevision: baselineRevision, published: false,
      unsupported: plan.unsupported.map(entry => ({
        sourceIndex: entry.index, block: entry.block,
        description: describeBlock(entry.block), reason: entry.reason
      })),
      handoffRequired: plan.unsupported.length > 0
    };
  }

  if (!isPrefix(initial.blocks, target) && initial.blocks.length) {
    return {
      status: 'blocked',
      reason: '草稿中已有与来源不一致的人工内容，未做任何修改',
      existingSemantics: initial,
      plan, draftRevision: baselineRevision, published: false
    };
  }

  const boundaries = [];
  const exhausted = new Set();
  let operations = 0;

  while (operations++ < Math.max(8, target.length * (maxAttempts + 1))) {
    const actual = await waitForEditorStable(page, base);
    if (sameBlocks(actual.blocks, target)) break;

    if (!isPrefix(actual.blocks, target)) {
      return {
        status: 'mismatch',
        reason: '草稿语义与来源目标分叉，已停止录入',
        differences: summarizeDifferences(compareSemantics({ blocks: target }, actual).differences),
        boundaries, draftRevision: await readRevision(page), plan, published: false
      };
    }

    if (stopAfter !== null && boundaries.length >= stopAfter) {
      return {
        status: 'partial',
        reason: `按演示边界停在 ${boundaries.length} 个块之后，尚未等待保存`,
        boundaries, plan, draftRevision: await readRevision(page), published: false,
        partialSemantics: actual
      };
    }

    const targetIndex = actual.blocks.length;
    if (targetIndex >= target.length) break;
    if (exhausted.has(targetIndex)) {
      return {
        status: 'mismatch',
        reason: `第 ${targetIndex + 1} 块在重试后仍无法与来源一致，已停止交人工`,
        boundaries, draftRevision: await readRevision(page), plan, published: false,
        handoffRequired: true
      };
    }

    if (options.onBoundary && boundaries.length > 0) {
      const hook = await options.onBoundary({
        targetIndex, boundaries, baselineRevision, plan
      });
      if (hook?.reloaded) {
        // 沿用之前未保存时，重新读取会丢内容属于预期；这里按语义前缀补录。
        await reloadEditor(page);
        const recovered = await readEditorSemantics(page, base);
        boundaries.push({
          targetIndex, type: target[targetIndex].type,
          description: describeBlock(target[targetIndex]),
          event: 'reloaded',
          recoveredLength: recovered.blocks.length,
          note: '录入中途重新读取草稿；已回读语义前缀，缺失部分按同一路径补录'
        });
        if (recovered.blocks.length < actual.blocks.length) {
          // 未保存的块在重新读取后确实消失了，之前的边界记录只作历史，不再算当前有效边界。
          for (const boundary of boundaries) {
            if (boundary.event !== 'reloaded') boundary.supersededByReload = true;
          }
        }
        if (!isPrefix(recovered.blocks, target)) {
          return {
            status: 'mismatch',
            reason: '中途重新读取后草稿与来源目标分叉，已停止交人工',
            differences: summarizeDifferences(compareSemantics({ blocks: target }, recovered).differences),
            boundaries, draftRevision: await readRevision(page), plan, published: false,
            handoffRequired: true
          };
        }
        if (boundaries.filter(boundary => boundary.event === 'reloaded').length > 2) {
          return {
            status: 'blocked',
            reason: '重新读取后无法继续稳定录入，已停止交人工',
            boundaries, draftRevision: await readRevision(page), plan, published: false
          };
        }
        // 重新读取后页面内容已变，回到循环顶部重新判断语义前缀，不能沿用旧快照。
        continue;
      } else if (hook?.conflict) {
        return { ...(await describeConflict(page, plan, base, hook.notice ?? '草稿修订冲突')), boundaries, plan };
      }
    }

    const block = target[targetIndex];
    const before = actual.blocks;
    let attempt = 0;
    let differences = [];
    let restored = null;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        await focusEditor(page);
        await enterBlock(page, block, lastType(before), options);
        const after = await waitForEditorStable(page, base);
        const comparison = compareSemantics({ blocks: [...before, block] }, after);
        if (comparison.equal) { differences = []; break; }
        differences = comparison.differences;
      } catch (error) {
        if (!(error instanceof RetryableEntryError)) throw error;
        differences = [{ path: 'entry', kind: 'text', expected: '完成选区与输入', actual: error.message }];
      }
      await focusEditor(page);
      restored = await restoreTo(page, before, base);
      if (!restored) break;
    }

    boundaries.push({
      targetIndex,
      sourceIndex: plan.supported[targetIndex]?.index,
      type: block.type,
      description: describeBlock(block),
      attempts: attempt,
      restored,
      differences: differences.length ? summarizeDifferences(differences) : []
    });

    if (differences.length) {
      exhausted.add(targetIndex);
      if (attempt >= maxAttempts) {
        return {
          status: 'mismatch',
          reason: `第 ${targetIndex + 1} 块回读与来源不一致，已尝试撤回边界`,
          boundaries,
          differences: summarizeDifferences(differences),
          draftRevision: await readRevision(page),
          plan,
          published: false,
          handoffRequired: true
        };
      }
    }
  }

  const settled = await waitForEditorStable(page, base);
  if (!persist) {
    const complete = sameBlocks(settled.blocks, target);
    return {
      status: complete ? 'partial' : 'mismatch',
      reason: complete ? undefined : '录入结束时草稿语义仍与目标不一致',
      boundaries, plan,
      draftRevision: await readRevision(page),
      published: false,
      message: '已录入，尚未等待自动保存',
      differences: complete ? [] : summarizeDifferences(compareSemantics({ blocks: target }, settled).differences)
    };
  }

  const settledComparison = compareSemantics({ blocks: target }, settled);

  const saveBaseline = baselineRevision;
  let save = boundaries.length
    ? await waitForConflictOrSave(page, saveBaseline, options.saveTimeout ?? 20000)
    : { conflict: false, revision: await readRevision(page), elapsed: 0, skipped: true };
  if (save.conflict) {
    return { ...(await describeConflict(page, plan, base, save.notice)), boundaries, plan };
  }
  if (save.timeout) {
    return {
      status: 'save-timeout',
      reason: `等待草稿保存超时（${save.elapsed} 毫秒），最后提示：${save.notice}`,
      boundaries, plan, draftRevision: await readRevision(page), published: false
    };
  }

  // 以门户重新读取后的语义为准，而不是编辑页上的临时 DOM。
  await reloadEditor(page);
  let persisted = await waitForEditorStable(page, base);
  let comparison = compareSemantics({ blocks: target }, persisted);
  const verificationRounds = [];

  while (!comparison.equal && verificationRounds.length < 2) {
    verificationRounds.push(summarizeDifferences(comparison.differences));
    const resume = await runTransfer(page, sourceDocument, {
      ...options, plan, persist: false, baselineRevision: await readRevision(page)
    });
    if (resume.status !== 'partial') {
      return { ...resume, boundaries: [...boundaries, ...(resume.boundaries ?? [])], plan, verificationRounds };
    }
    save = await waitForConflictOrSave(page, saveBaseline, options.saveTimeout ?? 20000);
    if (save.conflict) {
      return { ...(await describeConflict(page, plan, base, save.notice)), boundaries, plan, verificationRounds };
    }
    await reloadEditor(page);
    persisted = await waitForEditorStable(page, base);
    comparison = compareSemantics({ blocks: target }, persisted);
  }

  const server = await readServerDocument(page);
  const unsupported = plan.unsupported.map(entry => ({
    sourceIndex: entry.index,
    block: entry.block,
    description: describeBlock(entry.block),
    reason: entry.reason
  }));

  return {
    status: comparison.equal ? 'completed' : 'mismatch',
    reason: comparison.equal ? undefined : '保存后重新读取的草稿与录入目标不一致',
    boundaries,
    plan,
    // 可重试的编辑边界、草稿修订号、最终发布是三个不同的概念。
    editBoundary: {
      blocks: new Set(boundaries
        .filter(boundary => boundary.event !== 'reloaded' && !boundary.supersededByReload)
        .map(boundary => boundary.targetIndex)).size,
      retried: boundaries.filter(boundary => (boundary.attempts ?? 1) > 1).length,
      reloaded: boundaries.filter(boundary => boundary.event === 'reloaded').length,
      note: '每个目标块是一个可重试边界；失败时按语义断点撤销，再由同一路径重录'
    },
    draftRevision: server.revision,
    published: !!server.published,
    finalPublish: {
      performed: false,
      note: '本次只确认草稿语义并保存草稿；最终发布仍需人工在门户确认'
    },
    verification: {
      equal: comparison.equal,
      method: '业务语义回读比较（忽略空白和段落包装，不忽略顺序与链接目标）',
      differences: summarizeDifferences(comparison.differences),
      rounds: verificationRounds
    },
    persistedSemantics: persisted,
    unsupported,
    handoffRequired: unsupported.length > 0,
    timings: {
      entryMs: Date.now() - startedAt,
      saveMs: save.elapsed,
      totalMs: Date.now() - startedAt
    }
  };
}

export { planTransfer, compareSemantics, describeBlock, summarizeDifferences, warningSignatures };
