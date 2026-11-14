import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { readPortalDocument } from '../src/readback.js';
import { compareSemantics } from '../src/semantics.js';

const mini = JSON.parse(await readFile('fixtures/source/mini.json', 'utf8'));

test('回读器在真实 contenteditable DOM 上保留结构，不依赖 HTML 字符串', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // 这里直接构造“浏览器保存下来”的 DOM 形状；与编辑器交互无关，只验证回读规则。
    await page.setContent(`
      <article contenteditable="true" id="editor">
        <p>本说明适用于 <b>SYN-100 机柜</b>，完整接线定义见
          <a href="https://partner.example.com/manual/syn-100#wiring">安装手册第 4 章</a>。</p>
        <p></p>
        <ul><li>确认包装完好。</li><li>检查外壳无划伤。</li>
          <ul><li>记录序列号 <b>SYN-100-0421</b></li></ul></ul>
        <blockquote>警告：接线前必须断开总电源。</blockquote>
        <p><br></p>
      </article>`);
    const model = await page.evaluate(source => {
      const factory = eval(`(${source})`);
      return factory(document.querySelector('#editor'));
    }, readPortalDocument.toString());
    const expected = { blocks: mini.blocks };
    const result = compareSemantics(expected, model);
    assert.equal(result.equal, true, result.differences.join(' '));
    assert.deepEqual(model.problems, []);
  } finally {
    await browser.close();
  }
});
