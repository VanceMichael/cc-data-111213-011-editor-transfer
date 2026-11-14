import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPortal } from '../src/portal.js';
import {
  DraftEntry,
  EntryConflictError,
  ExistingContentError,
  enterAgainstPortal
} from '../src/enter.js';
import { planDocument } from '../src/semantics.js';

const mini = JSON.parse(await readFile('fixtures/source/mini.json', 'utf8'));
const full = JSON.parse(await readFile('fixtures/source/installation.json', 'utf8'));

async function withBrowser(callback) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try { return await callback(browser); } finally { await browser.close(); }
}

async function openEntry(browser, portal, source, options = {}, hooks = {}) {
  const page = await browser.newPage();
  const plan = planDocument(source);
  const entry = new DraftEntry({ page, plan, options: { portalUrl: portal.url, saveDelay: 0, ...options }, hooks });
  await entry.initialize();
  return { page, entry, plan };
}

// 另一位编辑者：用同一门户的可见工具栏追加一条警告并保存。
async function humanAppendsWarning(browser, portal, warning) {
  const page = await browser.newPage();
  try {
    await page.goto(portal.url);
    await page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
    await page.getByRole('textbox', { name: '说明正文' }).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '警告块', exact: true }).click();
    await page.keyboard.insertText(warning);
    const revisionBefore = portal.state.document.revision;
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForFunction(
      value => document.querySelector('#revision').textContent.includes(`修订 ${value}`),
      revisionBefore + 1, { timeout: 8000 }
    );
    return portal.state.document.revision;
  } finally {
    await page.close();
  }
}

async function newEntry(page, portal, source, options = {}) {
  const plan = planDocument(source);
  const entry = new DraftEntry({ page, plan, options: { portalUrl: portal.url, saveDelay: 0, ...options } });
  await entry.initialize();
  return entry;
}

test('可见工具栏逐块录入后，回读的业务语义与来源一致', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const { page, entry } = await openEntry(browser, portal, mini);
    try {
      const result = await enterAgainstPortal({
        page, source: mini, replaceExisting: true,
        options: { portalUrl: portal.url, saveDelay: 0 }
      });
      assert.equal(result.verification.equal, true, result.verification.differences.join(' '));
      assert.deepEqual(result.boundaries.map(boundary => boundary.blockId), ['intro', 'checks', 'power-warning']);
      assert.equal(result.published, false);
      assert.match(result.publication, /未发布/);
      assert.equal(result.draftRevision, portal.state.document.revision);
      assert.ok(result.boundaries.every(boundary => boundary.verifiedBeforeSave && boundary.verifiedAfterReload));

      // 持久化的正文确实含有嵌套列表、警告块、强调和链接，而不是一段纯文本。
      const html = portal.state.document.html;
      assert.match(html, /<blockquote>/);
      assert.match(html, /<ul>/);
      assert.match(html, /<b>SYN-100 机柜<\/b>/);
      assert.match(html, /href="https:\/\/partner\.example\.com\/manual\/syn-100#wiring"/);
      assert.match(html, /记录序列号/);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('草稿已有内容时拒绝清空；显式替换才写入', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const page = await browser.newPage();
    try {
      const entry = await newEntry(page, portal, mini);
      await assert.rejects(
        enterAgainstPortal({ page, source: mini, options: { portalUrl: portal.url } }),
        ExistingContentError
      );
      assert.equal(portal.state.document.revision, 1);
      assert.equal(portal.state.document.html, '<p>安装前请断电。</p>');
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('保存延迟与中途重新读取后，按回读前缀继续且不重复写入', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal({ saveDelay: 250 });
    const { page, entry } = await openEntry(browser, portal, mini, { saveDelay: 250 });
    try {
      await entry.prepareReplacement();
      const first = await entry.checkpoint(0);
      const second = await entry.checkpoint(1);
      assert.ok(second.draftRevision > first.draftRevision);
      assert.ok(first.saveElapsedMs >= 250, `保存耗时 ${first.saveElapsedMs}`);

      // 模拟人工在编辑器里点“重新读取”（页面级重载也走同一可见入口）。
      await entry.page.reload();
      await entry.page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
      entry.revision = await entry.visibleRevision();

      const resumed = await entry.resume();
      assert.equal(resumed.resumedFromPrefix, 2);
      assert.deepEqual(resumed.verification.differences, []);
      assert.equal(resumed.boundaries.length, 1);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('他人已修改草稿时停止写入并说明冲突，不覆盖警告', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const { page, entry } = await openEntry(browser, portal, mini);
    try {
      await entry.prepareReplacement();
      await entry.checkpoint(0);

      // 另一位编辑者通过同一门户的可见工具栏追加警告并保存。
      const remoteRevision = await humanAppendsWarning(browser, portal, '人工警告：必须两人复核。');
      assert.match(portal.state.document.html, /人工警告：必须两人复核。/);

      await assert.rejects(entry.checkpoint(1), EntryConflictError);
      assert.equal(portal.state.document.revision, remoteRevision);
      assert.match(portal.state.document.html, /人工警告：必须两人复核。/);

      const description = await entry.describeConflict(new EntryConflictError({ notice: '冲突' }));
      assert.equal(description.remoteRevision, remoteRevision);
      assert.equal(description.localEditsPreserved, false);
      assert.match(description.guidance, /人工/);
      assert.match(portal.state.document.html, /人工警告/);

      // 冲突后继续写入仍会被拒绝。
      await assert.rejects(entry.resume(), EntryConflictError);
      assert.match(portal.state.document.html, /人工警告：必须两人复核。/);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('保存等待期间出现他人保存时以 409 停止，并保留他人警告', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal({ saveDelay: 300 });
    let injected = false;
    const hooks = {
      async afterAutosaveSettled() {
        if (injected) return;
        injected = true;
        // 另一位编辑者抢先保存；录入侧应收到门户的 409 并停止。
        await humanAppendsWarning(browser, portal, '人工警告：等待保存时追加。');
      }
    };
    const { page, entry } = await openEntry(browser, portal, mini, { saveDelay: 300 }, hooks);
    try {
      await entry.prepareReplacement();
      await assert.rejects(entry.checkpoint(0), EntryConflictError);
      assert.match(portal.state.document.html, /人工警告：等待保存时追加。/);
      const remoteRevision = portal.state.document.revision;
      await page.waitForTimeout(500);
      assert.equal(portal.state.document.revision, remoteRevision);
      assert.match(portal.state.document.html, /人工警告：等待保存时追加。/);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('选区丢失会重新定位并重选，而不是用 HTML 字符串判定成功', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const { page, entry } = await openEntry(browser, portal, mini, { disturbSelection: 2 });
    try {
      await entry.prepareReplacement();
      for (let index = 0; index < mini.blocks.length; index += 1) await entry.checkpoint(index);
      await entry.reloadVisible();
      const result = await entry.verifyPrefix(mini.blocks.length);
      assert.equal(result.equal, true, result.differences.join(' '));
      assert.match(portal.state.document.html, /<b>SYN-100 机柜<\/b>/);
      assert.match(portal.state.document.html, /<a href="https:\/\/partner\.example\.com\/manual\/syn-100#wiring">/);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('完整来源在第一个不受支持的结构前停下并交还人工内容', { timeout: 180000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const { page, entry } = await openEntry(browser, portal, full);
    try {
      await entry.prepareReplacement();
      const result = await entry.run();
      assert.equal(result.verification.equal, true, result.verification.differences.join(' '));
      assert.equal(result.draftRevision, portal.state.document.revision);
      assert.equal(result.enteredBlockCount, 6);
      assert.deepEqual(result.unsupported.map(item => item.id), ['torque-table']);
      assert.deepEqual(result.pendingAfterGate.map(item => item.id), ['sign-off']);
      assert.deepEqual(result.verification.actual.problems, []);
      // 表格既没有被伪造，也没有被删除后宣布成功。
      assert.doesNotMatch(portal.state.document.html, /扭矩|M6/);
      assert.match(portal.state.document.html, /<blockquote>/);
      assert.match(portal.state.document.html, /<ol>/);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});

test('新会话按已持久化的来源前缀继续，不重复录入', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const firstPage = await browser.newPage();
    try {
      const first = await newEntry(firstPage, portal, mini);
      await first.prepareReplacement();
      await first.checkpoint(0);
      await first.checkpoint(1);
      const persistedRevision = await first.visibleRevision();
      await firstPage.close();

      const secondPage = await browser.newPage();
      const second = await newEntry(secondPage, portal, mini, { saveDelay: 0 });
      assert.equal(second.revision, persistedRevision);
      const resumed = await second.resume();
      assert.equal(resumed.resumedFromPrefix, 2);
      assert.equal(resumed.boundaries.length, 1);
      assert.deepEqual(resumed.verification.differences, []);
      assert.equal(resumed.draftRevision, portal.state.document.revision);
      assert.match(portal.state.document.html, /<blockquote>警告：接线前必须断开总电源。<\/blockquote>/);
      await secondPage.close();
    } finally {
      await portal.close();
    }
  });
});

test('编辑器中有未保存的人工内容时，边界先说明冲突而不是重新读取覆盖', { timeout: 120000 }, async () => {
  await withBrowser(async browser => {
    const portal = await startPortal();
    const page = await browser.newPage();
    try {
      const entry = await newEntry(page, portal, mini);
      await entry.prepareReplacement();
      await entry.checkpoint(0);
      // 模拟人工在编辑器里加了一段不在来源中的警告，尚未保存。
      await page.evaluate(() => {
        const editor = document.querySelector('#editor');
        const warning = document.createElement('blockquote');
        warning.textContent = '人工粘贴的警告';
        editor.appendChild(warning);
      });
      const before = await page.locator('#editor').innerHTML();
      const revisionBefore = portal.state.document.revision;

      await assert.rejects(entry.checkpoint(1), EntryConflictError);
      const htmlAfter = await page.locator('#editor').innerHTML();
      assert.match(htmlAfter, /人工粘贴的警告/);
      assert.equal(htmlAfter, before);
      assert.equal(portal.state.document.revision, revisionBefore);
      // 门户未被写入：服务端草稿里没有这段未保存内容。
      assert.doesNotMatch(portal.state.document.html, /人工粘贴的警告/);

      const detail = await entry.describeConflict(new EntryConflictError({
        kind: '编辑器含未保存内容'
      }));
      assert.match(detail.guidance, /人工/);
    } finally {
      await page.close();
      await portal.close();
    }
  });
});
