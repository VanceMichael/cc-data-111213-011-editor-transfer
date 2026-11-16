// 命令行入口：启动本地合成门户与 Chromium 后执行录入。
// 草稿里已有人工内容时默认拒绝改动；--blank-draft 只重置本地合成门户的草稿，
// 它不代替门户的保存接口，也不会被用在其后录入过程里。

import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPortal } from './portal.js';
import { runTransfer } from './transfer.js';
import { describeBlock, planTransfer } from './semantic.js';
import { demoDocument, demoStartHtml } from './demo-data.js';

export async function runBrowserTransfer({ source, headed = false, blankDraft = false } = {}) {
  let document = source ? JSON.parse(await readFile(source, 'utf8')) : demoDocument;
  if (document.document && Array.isArray(document.document.blocks)) document = { ...document, ...document.document };
  const plan = planTransfer(document);
  const portal = await startPortal();
  const browser = await chromium.launch({ headless: !headed, args: ['--no-sandbox'] });
  try {
    if (blankDraft) {
      // 本地合成门户的场景准备，不是编辑器的写入通道。
      await fetch(`${portal.url}/api/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document: { revision: 1, html: demoStartHtml, published: false }, saveDelay: 0 })
      });
    }
    const page = await browser.newPage();
    await page.goto(portal.url);
    await page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
    const result = await runTransfer(page, document, { plan });
    const unsupported = plan.unsupported.map(entry => ({
      sourceIndex: entry.index,
      type: entry.block.type,
      description: describeBlock(entry.block),
      reason: entry.reason
    }));
    return {
      portal: portal.url,
      source: source ?? '内置演示资料',
      status: result.status,
      reason: result.reason ?? (result.status === 'blocked'
        ? '草稿不是空的。确认里没有人工内容后，可用 --blank-draft 重置本地合成门户的草稿'
        : undefined),
      draftRevision: result.draftRevision,
      published: result.published,
      finalPublish: result.finalPublish ?? { performed: false, note: '最终发布始终是门户里的人工步骤' },
      editBoundary: result.editBoundary,
      verification: result.verification ? {
        equal: result.verification.equal,
        method: result.verification.method,
        differences: result.verification.differences
      } : undefined,
      unsupported,
      handoffRequired: unsupported.length > 0,
      note: '命令行只保存草稿；最终发布始终是门户里的人工步骤。'
    };
  } finally {
    await browser.close();
    await portal.close();
  }
}
