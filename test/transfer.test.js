import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPortal } from '../src/portal.js';
import { runTransfer, readEditorSemantics, readRevision } from '../src/transfer.js';
import { planTransfer } from '../src/semantic.js';

const paragraph = (...runs) => ({ type: 'paragraph', runs: runs.map(run => typeof run === 'string' ? { text: run } : run) });

const document = (...blocks) => ({ blocks });

const sample = document(
  paragraph('安装前请断电。'),
  paragraph({ text: '阅读 ' }, { text: '安全须知', bold: true }, { text: ' 与 ' }, { text: '接线图', link: 'https://example.test/wiring' }, { text: '。' }),
  {
    type: 'orderedList',
    items: [
      { runs: [{ text: '拆包核对 ' }, { text: '铭牌', bold: true }, { text: '。' }] },
      { runs: [{ text: '按 ' }, { text: '接线图', link: 'https://example.test/wiring' }, { text: ' 接地。' }] }
    ]
  },
  { type: 'warning', runs: [{ text: '警告：', bold: true }, { text: '未接地严禁上电。' }] }
);

async function withPortal(callback) {
  const portal = await startPortal();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let page;
  const reset = async (html = '<p><br></p>', extra = {}) => {
    await fetch(`${portal.url}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: { revision: 1, html, published: false }, saveDelay: 0, ...extra })
    });
    await page.goto(portal.url);
    await page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
  };
  try {
    page = await browser.newPage();
    await page.goto(portal.url);
    await page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
    return await callback({ portal, page, reset });
  } finally {
    await browser.close();
    await portal.close();
  }
}

test('结构化录入经真实工具栏完成并按语义回读', { timeout: 90000 }, async () => {
  await withPortal(async ({ portal, page, reset }) => {
    await reset();
    const result = await runTransfer(page, sample);
    assert.equal(result.status, 'completed', JSON.stringify(result.verification));
    assert.equal(result.draftRevision, 2);
    assert.equal(result.published, false);
    assert.equal(result.finalPublish.performed, false);
    assert.equal(result.verification.equal, true);
    assert.equal(result.plan.unsupported.length, 0);

    // 保存后的草稿由门户重新读取，仍保留列表、强调、链接和警告。
    const persisted = await readEditorSemantics(page, portal.url);
    assert.equal(persisted.blocks.length, 4);
    assert.equal(persisted.blocks[2].type, 'orderedList');
    assert.equal(persisted.blocks[2].items.length, 2);
    assert.equal(persisted.blocks[3].type, 'warning');
    assert.equal(persisted.blocks[1].runs.find(run => run.text === '接线图').link, 'https://example.test/wiring');
  });
});

test('已有不一致的人工草稿不会被覆盖', { timeout: 30000 }, async () => {
  await withPortal(async ({ portal, page, reset }) => {
    await reset('<p>人工写的开头。</p>');
    const result = await runTransfer(page, sample);
    assert.equal(result.status, 'blocked');
    assert.match(result.reason, /未做任何修改/);
    const server = await page.evaluate(() => fetch('/api/document').then(response => response.json()));
    assert.equal(server.revision, 1);
    assert.equal(server.html, '<p>人工写的开头。</p>');
  });
});

test('链接目标写错会在回读时发现并按语义断点重试', { timeout: 60000 }, async () => {
  await withPortal(async ({ page, reset }) => {
    await reset();
    let wrongOnce = false;
    const result = await runTransfer(page, sample, {
      maxAttempts: 2,
      linkPrompt: async target => {
        if (!wrongOnce && target.includes('/wiring')) { wrongOnce = true; return 'https://example.test/WRONG'; }
        return target;
      }
    });
    assert.equal(result.status, 'completed', JSON.stringify(result.verification));
    assert.equal(result.editBoundary.retried, 1);
    assert.equal(result.boundaries.find(boundary => boundary.attempts === 2).restored, true);
    const html = await page.evaluate(() => fetch('/api/document').then(response => response.json()).then(data => data.html));
    assert.doesNotMatch(html, /WRONG/);
    assert.match(html, /https:\/\/example\.test\/wiring/);
  });
});

test('录入中途重新读取会按语义前缀补录', { timeout: 60000 }, async () => {
  await withPortal(async ({ page, reset }) => {
    await reset();
    let reloaded = false;
    const result = await runTransfer(page, sample, {
      onBoundary: async () => {
        if (reloaded) return null;
        reloaded = true;
        await page.getByRole('button', { name: '重新读取' }).click();
        await page.waitForTimeout(80);
        return { reloaded: true };
      }
    });
    assert.equal(result.status, 'completed', JSON.stringify(result.verification));
    assert.equal(result.editBoundary.reloaded, 1);
    assert.equal(result.verification.equal, true);
  });
});

test('保存延迟时草稿修订号以保存回执为准', { timeout: 60000 }, async () => {
  await withPortal(async ({ page, reset }) => {
    await reset('<p><br></p>', { saveDelay: 1000 });
    const result = await runTransfer(page, sample);
    assert.equal(result.status, 'completed');
    assert.equal(result.draftRevision, 2);
    assert.ok(result.timings.saveMs >= 900, `saveMs=${result.timings.saveMs}`);
  });
});

test('自动保存遇到他人修改时先报冲突并保留对方警告', { timeout: 60000 }, async () => {
  await withPortal(async ({ portal, page, reset }) => {
    await reset();
    let injected = false;
    const foreign = '<p><b>警告：</b>现场负责人：未挂牌禁止合闸。</p>';
    const result = await runTransfer(page, sample, {
      onBoundary: async () => {
        if (injected) return null;
        injected = true;
        await fetch(`${portal.url}/api/control`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ document: { revision: 7, html: foreign, published: false } })
        });
        return { conflict: true, notice: '草稿修订冲突' };
      }
    });
    assert.equal(result.status, 'conflict');
    assert.equal(result.conflict.remoteRevision, 7);
    assert.deepEqual(result.conflict.foreignWarnings, ['警告：现场负责人：未挂牌禁止合闸。']);
    assert.match(result.conflict.resolution, /保留对方版本/);
    const server = await page.evaluate(() => fetch('/api/document').then(response => response.json()));
    assert.equal(server.html, foreign);
    assert.equal(server.revision, 7);
  });
});

test('不支持结构留给人处理且不越过它继续录入', { timeout: 60000 }, async () => {
  await withPortal(async ({ page, reset }) => {
    await reset();
    const nested = document(
      paragraph('支持的前言。'),
      {
        type: 'orderedList',
        items: [
          { runs: [{ text: '固定柜体。' }] },
          { runs: [{ text: '安装护罩。' }], children: [{ type: 'unorderedList', items: [{ runs: [{ text: '内侧螺栓' }] }] }] }
        ]
      },
      { type: 'warning', runs: [{ text: '警告：', bold: true }, { text: '护罩未固定不得上电。' }] }
    );
    const result = await runTransfer(page, nested);
    assert.equal(result.status, 'completed');
    assert.equal(result.handoffRequired, true);
    assert.equal(result.boundaries.length, 1);
    assert.deepEqual(result.unsupported.map(entry => entry.sourceIndex), [1, 2]);
    assert.match(result.unsupported[0].reason, /嵌套列表/);
    const html = await page.evaluate(() => fetch('/api/document').then(response => response.json()).then(data => data.html));
    assert.match(html, /支持的前言/);
    assert.doesNotMatch(html, /安装护罩|护罩未固定/);
  });
});

test('门户工具栏没有缩进控件，嵌套列表确实无法表达', { timeout: 30000 }, async () => {
  await withPortal(async ({ page, reset }) => {
    await reset('<ol><li>甲</li><li>乙</li></ol>');
    const editor = page.getByRole('textbox', { name: '说明正文' });
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Tab');
    const html = await editor.evaluate(element => element.innerHTML);
    assert.equal((html.match(/<ol/g) ?? []).length, 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'save');
    // 工具栏按钮只有强调、有序步骤、要点和链接。
    const tools = await page.getByRole('navigation').getByRole('button').allTextContents();
    assert.deepEqual(tools, ['强调', '有序步骤', '要点', '链接']);
  });
});

test('录制计划只接受连续支持前缀', () => {
  const plan = planTransfer(document(
    paragraph('前言'),
    { type: 'table', title: '表' },
    { type: 'orderedList', items: [{ runs: [{ text: '步骤' }] }] }
  ));
  assert.equal(plan.supported.length, 1);
  assert.deepEqual(plan.unsupported.map(entry => entry.index), [1, 2]);
});
