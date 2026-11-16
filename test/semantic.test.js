import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSemantics, describeBlock, isSupportedBlock, normalizeSourceDocument,
  planTransfer, summarizeDifferences, warningSignatures
} from '../src/semantic.js';

const paragraph = (...runs) => ({ type: 'paragraph', runs: runs.map(run =>
  typeof run === 'string' ? { text: run } : run) });

const doc = (...blocks) => ({ blocks });

test('来源段落和列表被规范化为语义模型', () => {
  const normalized = normalizeSourceDocument(doc(
    paragraph('  安装前  请断电。 '),
    { type: 'orderedList', items: [{ text: '步骤一' }, { runs: [{ text: '步骤二', bold: true }] }] }
  ));
  assert.equal(normalized.blocks.length, 2);
  assert.equal(normalized.blocks[0].runs[0].text, '安装前 请断电。');
  assert.equal(normalized.blocks[1].items.length, 2);
  assert.equal(normalized.blocks[1].items[1].runs[0].bold, true);
});

test('空白归一化不改变业务语义', () => {
  const expected = doc(paragraph({ text: '接线前阅读' }, { text: '安全须知', bold: true }));
  const actual = doc({
    type: 'paragraph',
    runs: [{ text: ' 接线前阅读 \n' }, { text: '安全须知', bold: true }, { text: '  ' }]
  });
  assert.equal(compareSemantics(expected, actual).equal, true);
});

test('步骤顺序变化会被判为不一致', () => {
  const expected = doc({ type: 'orderedList', items: [{ runs: [{ text: '先断电' }] }, { runs: [{ text: '再接线' }] }] });
  const reordered = doc({ type: 'orderedList', items: [{ runs: [{ text: '再接线' }] }, { runs: [{ text: '先断电' }] }] });
  const result = compareSemantics(expected, reordered);
  assert.equal(result.equal, false);
  assert.ok(result.differences.some(diff => diff.kind === 'text'));
});

test('链接目标变化会被判为不一致', () => {
  const expected = doc(paragraph({ text: '接线图', link: 'https://example.test/a' }));
  const actual = doc(paragraph({ text: '接线图', link: 'https://example.test/b' }));
  const result = compareSemantics(expected, actual);
  assert.equal(result.equal, false);
  assert.ok(result.differences.some(diff => diff.kind === 'link' && diff.expected.endsWith('/a')));
});

test('强调丢失会被判为不一致', () => {
  const expected = doc(paragraph({ text: '警告：', bold: true }));
  const actual = doc(paragraph({ text: '警告：' }));
  const result = compareSemantics(expected, actual);
  assert.equal(result.equal, false);
  assert.ok(result.differences.some(diff => diff.kind === 'bold'));
});

test('有序列表与要点列表不能互相替代', () => {
  const items = [{ runs: [{ text: '一项' }] }];
  assert.equal(compareSemantics(doc({ type: 'orderedList', items }), doc({ type: 'unorderedList', items })).equal, false);
});

test('嵌套列表被识别为不支持，且不会越过它继续录入', () => {
  const nested = {
    type: 'orderedList',
    items: [{ runs: [{ text: '安装护罩。' }], children: [{ type: 'unorderedList', items: [{ runs: [{ text: '内侧螺栓' }] }] }] }]
  };
  assert.equal(isSupportedBlock(nested), false);
  const plan = planTransfer(doc(paragraph('前言。'), nested, paragraph('警告后的段落。')));
  assert.equal(plan.supported.length, 1);
  assert.deepEqual(plan.unsupported.map(entry => entry.index), [1, 2]);
  assert.match(plan.unsupported[0].reason, /嵌套列表/);
  assert.match(plan.unsupported[1].reason, /保持步骤顺序/);
});

test('未知结构保留原文预览并交人工', () => {
  const plan = planTransfer(doc({ type: 'table', title: '校验表' }, paragraph('之后。')));
  assert.equal(plan.supported.length, 0);
  assert.equal(plan.unsupported.length, 2);
  assert.match(describeBlock(plan.unsupported[0].block), /table/);
  assert.match(plan.unsupported[0].reason, /无法表达/);
});

test('警告块缺失加粗标签会被规范化补上', () => {
  const normalized = normalizeSourceDocument(doc({ type: 'warning', runs: [{ text: '未接地严禁上电。' }] }));
  assert.equal(normalized.blocks[0].runs[0].text, '警告：');
  assert.equal(normalized.blocks[0].runs[0].bold, true);
  assert.deepEqual(warningSignatures(normalized), ['警告：未接地严禁上电。']);
});

test('差异说明指出来源与回读的具体位置', () => {
  const result = compareSemantics(
    doc({ type: 'orderedList', items: [{ runs: [{ text: '步骤一' }] }, { runs: [{ text: '步骤二' }] }] }),
    doc({ type: 'orderedList', items: [{ runs: [{ text: '步骤一' }] }] })
  );
  const summary = summarizeDifferences(result.differences);
  assert.ok(summary.some(line => line.includes('第 1 块') && line.includes('条目数')));
});
