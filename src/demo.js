// 本地演示：真实打开门户编辑页，用可见工具栏录入，然后展示回读、重载、保存延迟、
// 冲突和“不支持结构”的人工交接。演示只生成本地报告，不连接任何生产系统。

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startPortal } from './portal.js';
import { runTransfer, readEditorSemantics } from './transfer.js';
import { describeBlock, extractSemanticFromRoot, planTransfer, warningSignatures } from './semantic.js';
import { demoDocument, demoStartHtml } from './demo-data.js';

const resetDraft = async (portal, html = demoStartHtml, extra = {}) => {
  await fetch(`${portal.url}/api/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { revision: 1, html, published: false }, saveDelay: 0, ...extra })
  });
};

async function openPage(browser, portal) {
  const page = await browser.newPage();
  await page.goto(portal.url);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
  return page;
}

function brief(result) {
  return {
    status: result.status,
    reason: result.reason,
    message: result.message ?? result.reason,
    conflict: result.conflict,
    draftRevision: result.draftRevision,
    published: result.published,
    finalPublish: result.finalPublish,
    editBoundary: result.editBoundary,
    verification: result.verification ? {
      equal: result.verification.equal,
      method: result.verification.method,
      differences: result.verification.differences
    } : undefined,
    blocks: result.boundaries?.map(boundary => ({
      target: boundary.targetIndex,
      type: boundary.type,
      attempts: boundary.attempts,
      restored: boundary.restored,
      event: boundary.event,
      supersededByReload: boundary.supersededByReload,
      differences: boundary.differences
    })),
    unsupported: result.unsupported?.map(entry => ({
      sourceIndex: entry.sourceIndex,
      description: entry.description,
      reason: entry.reason
    })),
    handoffRequired: result.handoffRequired,
    timings: result.timings
  };
}

export async function runDemo({ directory = '.local/demo' } = {}) {
  const folder = resolve(directory);
  await mkdir(folder, { recursive: true });
  const portal = await startPortal();
  const browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    args: ['--no-sandbox']
  });
  const report = { title: demoDocument.title, documentId: demoDocument.documentId, scenarios: {} };
  try {
    // 1) 正常录入：只录连续支持前缀，遇到嵌套列表停止并交人工。
    await resetDraft(portal);
    {
      const page = await openPage(browser, portal);
      report.scenarios.full = brief(await runTransfer(page, demoDocument));
      await page.close();
    }

    // 2) 一条错误链接目标被回读发现，按语义断点撤销后重录成功。
    await resetDraft(portal);
    {
      const page = await openPage(browser, portal);
      let wrongOnce = false;
      const result = await runTransfer(page, demoDocument, {
        maxAttempts: 2,
        linkPrompt: async target => {
          if (!wrongOnce && target.includes('/manual/wiring')) {
            wrongOnce = true;
            return 'https://example.test/manual/WRONG';
          }
          return target;
        }
      });
      report.scenarios.retry = brief(result);
      await page.close();
    }

    // 3) 录入中途重新读取：未保存的内容会消失，按语义前缀补录。
    await resetDraft(portal);
    {
      const page = await openPage(browser, portal);
      let reloaded = false;
      const result = await runTransfer(page, demoDocument, {
        onBoundary: async () => {
          if (reloaded) return null;
          reloaded = true;
          await page.getByRole('button', { name: '重新读取' }).click();
          await page.waitForTimeout(80);
          return { reloaded: true };
        }
      });
      report.scenarios.reload = brief(result);
      await page.close();
    }

    // 4) 保存延迟：录入完成不等于已保存，草稿修订号要等保存回执。
    await resetDraft(portal, demoStartHtml, { saveDelay: 1200 });
    {
      const page = await openPage(browser, portal);
      report.scenarios['slow-save'] = brief(await runTransfer(page, demoDocument));
      await page.close();
    }

    // 5) 自动保存与人工同时修改：先说明冲突、保留对方警告，不覆盖。
    await resetDraft(portal);
    {
      const page = await openPage(browser, portal);
      let injected = false;
      const result = await runTransfer(page, demoDocument, {
        onBoundary: async () => {
          if (injected) return null;
          injected = true;
          await fetch(`${portal.url}/api/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              document: {
                revision: 7,
                html: '<p><b>警告：</b>现场负责人：未挂牌禁止合闸。</p>',
                published: false
              }
            })
          });
          return { conflict: true, notice: '草稿修订冲突' };
        }
      });
      const server = await page.evaluate(() => fetch('/api/document').then(response => response.json()));
      // 用独立的只读页面解析服务端草稿，确认对方的警告仍在。
      const reader = await browser.newPage();
      await reader.setContent(server.html);
      const remoteSemantics = await reader.evaluate(extractSemanticFromRoot, { base: portal.url });
      await reader.close();
      report.scenarios.conflict = {
        ...brief(result),
        preservedRemoteRevision: server.revision,
        preservedRemoteHtml: server.html,
        preservedWarnings: warningSignatures(remoteSemantics)
      };
      await page.close();
    }

    // 6) 嵌套列表单独展示：不录入、不删除，列出每一项交人工。
    {
      const plan = planTransfer(demoDocument);
      report.scenarios.unsupported = {
        entries: plan.unsupported.map(entry => ({
          sourceIndex: entry.index,
          type: entry.block.type,
          description: describeBlock(entry.block),
          reason: entry.reason,
          content: entry.block
        })),
        note: '这些块没有写入草稿；门户中的既有警告和人工内容保持不变。'
      };
    }

    report.summary = {
      status: report.scenarios.full.status,
      draftRevision: report.scenarios.full.draftRevision,
      published: report.scenarios.full.published,
      finalPublishPerformed: false,
      verificationMethod: report.scenarios.full.verification?.method,
      handoffRequired: report.scenarios.full.handoffRequired,
      note: '草稿修订号是本次保存的版本号；最终发布仍需人工确认，演示未执行发布。'
    };

    await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(folder, 'report.html'), renderReport(report));
    return { folder, report };
  } finally {
    await browser.close();
    await portal.close();
  }
}

const escape = value => String(value ?? '').replace(/[&<>"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[char]));

export function renderReport(report) {
  const scenarioTitles = {
    full: '完整录入（含一处不支持结构）',
    retry: '链接目标写错后按语义重试',
    reload: '录入中途重新读取',
    'slow-save': '保存延迟',
    conflict: '他人同时修改（冲突）',
    unsupported: '留给人处理的结构'
  };
  const sections = Object.entries(report.scenarios).map(([key, value]) => {
    if (key === 'unsupported') {
      return `<section><h2>${scenarioTitles[key]}</h2>
        <p>${escape(value.note)}</p>
        <ul>${value.entries.map(entry => `<li><strong>${escape(entry.description)}</strong>
          <span class="why">${escape(entry.reason)}</span></li>`).join('')}</ul></section>`;
    }
    const blocks = (value.blocks ?? []).map(block => `<li>第 ${block.target + 1} 块 · ${escape(block.type)}
      ${block.event === 'reloaded' ? '· 重新读取时的语义断点' : `· 尝试 ${block.attempts ?? 1} 次${block.restored ? ' · 已按语义撤回' : ''}`}
      ${block.supersededByReload ? '· 该次录入因重新读取丢失，已补录' : ''}</li>`).join('');
    const unsupported = (value.unsupported ?? []).map(entry =>
      `<li>${escape(entry.description)}<span class="why">${escape(entry.reason)}</span></li>`).join('');
    const conflict = value.conflict ? `<h3>冲突说明</h3><p>${escape(value.conflict.resolution)}</p>
      <p>对方警告：<code>${escape((value.conflict.foreignWarnings ?? []).join(' / '))}</code></p>
      <p>冲突后草稿修订号仍为 <strong>${escape(value.conflict.remoteRevision)}</strong>，未覆盖对方内容。</p>` : '';
    return `<section><h2>${scenarioTitles[key]}</h2>
      <p><span class="chip">${escape(value.status)}</span>
      草稿修订号 <strong>${escape(value.draftRevision)}</strong>
      · 发布：${value.published ? '是' : '否'}</p>
      ${value.reason ? `<p>${escape(value.reason)}</p>` : ''}
      ${value.editBoundary ? `<p>编辑边界 ${value.editBoundary.blocks} 个，重试 ${value.editBoundary.retried} 个，重载 ${value.editBoundary.reloaded} 个。</p>` : ''}
      ${blocks ? `<ol>${blocks}</ol>` : ''}
      ${value.verification ? `<p>语义回读：${value.verification.equal ? '一致' : '不一致'}
        <span class="why">${escape(value.verification.method ?? '')}</span></p>` : ''}
      ${unsupported ? `<h3>留给人处理</h3><ul>${unsupported}</ul>` : ''}
      ${conflict}
    </section>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>录入演示报告 · ${escape(report.title)}</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;margin:24px;color:#1c2430;background:#f6f7f9;max-width:960px}
 h1{font-size:20px} h2{font-size:16px;margin:0 0 8px} h3{font-size:14px;margin:12px 0 4px}
 section{background:#fff;border:1px solid #d7dde5;border-radius:8px;padding:14px 18px;margin:12px 0}
 .chip{font-size:12px;padding:1px 7px;border-radius:999px;background:#e7ecf3;margin-right:6px}
 .why{display:block;color:#7a4a00;font-size:13px}
 ul,ol{padding-left:20px} li{margin:3px 0} code{background:#eef1f5;padding:1px 4px;border-radius:4px}
</style>
<h1>安装说明录入演示 · ${escape(report.title)}</h1>
<p>来源 ${escape(report.documentId)}。全部为本地合成数据，未连接生产系统；本次演示没有执行最终发布。</p>
${sections}`;
}
