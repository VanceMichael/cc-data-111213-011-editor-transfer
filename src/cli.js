import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Archive } from './archive.js';
import { inspect, sample } from './domain.js';
import { enterWithPortal } from './enter.js';
import { planDocument } from './semantics.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(value => value.startsWith('--')));
const positional = args.filter(value => !value.startsWith('--'));
const [command = 'demo', file, directory = '.local/archive'] = positional;
const flagValue = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

async function loadSource(path) {
  if (!path) throw new Error('需要带结构的资料 JSON 路径');
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function entryCommand({ sourcePath, output, saveDelay, replace, demonstration }) {
  const source = await loadSource(sourcePath);
  const plan = planDocument(source);
  console.log(JSON.stringify({
    willEnter: plan.gate.limit,
    stopsBeforeUnsupported: plan.gate.unsupported.map(item => ({ index: item.sourceIndex, reason: item.reason })),
    pendingAfterGate: plan.gate.pending.map(block => block.id)
  }, null, 2));
  const result = await enterWithPortal({
    source,
    saveDelay,
    replaceExisting: replace,
    hooks: demonstration ? {
      async afterCheckpoint(engine, boundary) {
        if (boundary.blockIndex === 1) {
          await engine.page.reload();
          await engine.page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
          engine.revision = await engine.visibleRevision();
        }
      }
    } : {},
    options: {}
  });
  const report = {
    draftRevision: result.draftRevision,
    published: result.published,
    publication: result.publication,
    boundaries: result.boundaries,
    editableBoundaries: result.editableBoundaries,
    unsupported: result.unsupported,
    pendingAfterGate: result.pendingAfterGate,
    verification: { equal: result.verification.equal, differences: result.verification.differences },
    readbackProblems: result.verification.actual.problems
  };
  if (output) {
    await writeFile(resolve(output), JSON.stringify(report, null, 2), 'utf8');
    console.log(`报告已写入 ${resolve(output)}`);
  }
  console.log(JSON.stringify(report, null, 2));
  return result;
}

async function run() {
  if (command === 'inspect') {
    if (!file) throw new Error('需要资料路径');
    console.log(JSON.stringify(await inspect(resolve(file)), null, 2));
  } else if (command === 'capture') {
    if (!file) throw new Error('需要资料路径');
    const inventory = await inspect(resolve(file));
    const receipt = await new Archive(directory).accept(await readFile(file),
      { source: resolve(file), inventory });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(await new Archive(file || directory).receipts(), null, 2));
  } else if (command === 'enter') {
    await entryCommand({
      sourcePath: file,
      output: process.env.ENTRY_REPORT ?? flagValue('report'),
      saveDelay: Number(flagValue('save-delay') ?? 0),
      replace: flags.has('--replace')
    });
  } else if (command === 'demo') {
    const temporary = await mkdtemp(join(tmpdir(), 'intake-'));
    try {
      const inventory = await inspect(resolve(sample));
      const archive = new Archive(temporary);
      const receipt = await archive.accept(await readFile(sample), { source: sample, inventory });
      console.log(JSON.stringify({ inventory, receipt, verified: (await archive.read(receipt.sha256)).length }, null, 2));
      const domain = await import('./domain.js');
      console.log(JSON.stringify(await domain.livePreview(), null, 2));
      console.log('—— 浏览器录入演示（中途重新加载、保存延迟、一处不受支持的结构）——');
      console.log('演示会显式替换草稿内容；正式调用不会在未声明时清空已有草稿。');
      await entryCommand({
        sourcePath: 'fixtures/source/installation.json',
        saveDelay: 600,
        replace: true,
        demonstration: true
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } else { throw new Error('支持 inspect、capture、list、enter、demo'); }
}
run().catch(error => {
  console.error(error.message);
  if (error.conflict) console.error(JSON.stringify(error.conflict, null, 2));
  if (error.verification) console.error(JSON.stringify(error.verification, null, 2));
  process.exitCode = 1;
});
