import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareSemantics, planDocument } from '../src/semantics.js';
import { readPortalDocument } from '../src/readback.js';

const source = JSON.parse(await readFile('fixtures/source/installation.json', 'utf8'));

test('计划保留源顺序，并在第一个不受支持的结构前停下', () => {
  const plan = planDocument(source);
  assert.deepEqual(plan.blocks.map(block => block.id),
    ['intro', 'checks-intro', 'checks', 'power-warning', 'steps-intro', 'steps', 'sign-off']);
  assert.equal(plan.gate.limit, 6);
  assert.deepEqual(plan.gate.unsupported.map(item => item.id), ['torque-table']);
  assert.deepEqual(plan.gate.pending.map(block => block.id), ['sign-off']);
  assert.match(plan.gate.unsupported[0].reason, /表格/);
  assert.equal(plan.gate.unsupported[0].source.rows.length, 3);
});

test('计划拒绝工具栏无法稳定表达的有序/无序混合嵌套', () => {
  const plan = planDocument({
    blocks: [{
      type: 'list', ordered: true,
      items: [{ runs: [{ text: '甲' }], childOrdered: false, children: [{ runs: [{ text: '乙' }] }] }]
    }]
  });
  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.gate.limit, 0);
  assert.match(plan.gate.unsupported[0].reason, /混合嵌套/);
});

test('语义比较忽略空白与 run 边界，但不忽略文字、步骤顺序、链接目标和强调', () => {
  const expected = {
    blocks: [
      { type: 'paragraph', runs: [{ text: '安装前请' }, { text: '断电', emphasis: true }, { text: '。' }] },
      { type: 'list', ordered: true, items: [{ runs: [{ text: '第一步' }], children: [] }, { runs: [{ text: '第二步' }], children: [] }] }
    ]
  };

  const formattingOnly = {
    blocks: [
      { type: 'paragraph', runs: [{ text: '安装前请', emphasis: false }, { text: '断电', emphasis: true }, { text: '。', emphasis: false }] },
      { type: 'list', ordered: true, items: [{ runs: [{ text: '第一 步 ' }], children: [] }, { runs: [{ text: '\n第二步' }], children: [] }] }
    ]
  };
  assert.equal(compareSemantics(expected, formattingOnly).equal, true);

  const emphasisLost = {
    blocks: [
      { type: 'paragraph', runs: [{ text: '安装前请断电。', emphasis: false }] },
      { type: 'list', ordered: true, items: [{ runs: [{ text: '第一步' }], children: [] }, { runs: [{ text: '第二步' }], children: [] }] }
    ]
  };
  assert.match(compareSemantics(expected, emphasisLost).differences[0], /强调/);

  const reordered = {
    blocks: [
      { type: 'paragraph', runs: [{ text: '安装前请' }, { text: '断电', emphasis: true }, { text: '。' }] },
      { type: 'list', ordered: true, items: [{ runs: [{ text: '第二步' }], children: [] }, { runs: [{ text: '第一步' }], children: [] }] }
    ]
  };
  assert.equal(compareSemantics(expected, reordered).equal, false);

  const listTypeChanged = {
    blocks: [
      expected.blocks[0],
      { type: 'list', ordered: false, items: expected.blocks[1].items }
    ]
  };
  assert.match(compareSemantics(expected, listTypeChanged).differences[0], /列表类型/);

  const nestedLost = {
    blocks: [
      expected.blocks[0],
      { type: 'list', ordered: true, items: [
        { runs: [{ text: '第一步' }], children: [{ runs: [{ text: '补充' }] }], childrenOrdered: true },
        { runs: [{ text: '第二步' }], children: [] }
      ] }
    ]
  };
  assert.equal(compareSemantics(expected, nestedLost).equal, false);
});

test('链接目标变化会报告为差异', () => {
  const expected = { blocks: [{ type: 'paragraph', runs: [{ text: '手册', link: 'https://a.example/manual' }] }] };
  const actual = { blocks: [{ type: 'paragraph', runs: [{ text: '手册', link: 'https://b.example/manual' }] }] };
  const result = compareSemantics(expected, actual);
  assert.equal(result.equal, false);
  assert.match(result.differences[0], /链接目标不一致/);
});

test('回读器把工具栏结构读成语义模型并标记无法表达的内容', () => {
  const text = value => ({ nodeType: 3, nodeValue: value });
  const element = (nodeName, childNodes = [], attributes = {}) => ({
    nodeType: 1, nodeName, childNodes,
    getAttribute: name => attributes[name] ?? null
  });
  const root = element('ARTICLE', [
    element('P', [
      text('本说明 '),
      element('B', [text('重要')]),
      text('，见 '),
      element('A', [text('附录')], { href: 'https://x.example/a' })
    ]),
    element('OL', [
      element('LI', [text('一')]),
      element('OL', [element('LI', [text('一甲')])])
    ]),
    element('BLOCKQUOTE', [text('警告')]),
    element('TABLE', [])
  ]);
  const model = readPortalDocument(root);
  assert.deepEqual(model.blocks.map(block => block.type), ['paragraph', 'list', 'warning', 'other']);
  assert.equal(model.blocks[0].runs[1].emphasis, true);
  assert.equal(model.blocks[0].runs[3].link, 'https://x.example/a');
  assert.equal(model.blocks[1].ordered, true);
  assert.equal(model.blocks[1].items.length, 1);
  assert.equal(model.blocks[1].items[0].children[0].runs[0].text, '一甲');
  assert.equal(model.blocks[1].items[0].childrenOrdered, true);
  assert.match(model.problems.join(' '), /TABLE/);
});

test('回读器把浏览器实际产生的块结构还原为源顺序', () => {
  const text = value => ({ nodeType: 3, nodeValue: value });
  const element = (nodeName, childNodes = []) => ({ nodeType: 1, nodeName, childNodes, getAttribute: () => null });
  const root = element('ARTICLE', [
    element('P', [text('第一段')]),
    element('P', []),
    element('UL', [
      element('LI', [text('甲')]),
      element('LI', [text('乙')]),
      element('UL', [element('LI', [text('乙一')])])
    ]),
    element('BLOCKQUOTE', [text('警告内容')]),
    element('P', [text('第三段')])
  ]);
  const model = readPortalDocument(root);
  assert.deepEqual(model.blocks.map(block => block.type), ['paragraph', 'list', 'warning', 'paragraph']);
  assert.equal(model.blocks[1].items[1].children[0].runs[0].text, '乙一');
});
