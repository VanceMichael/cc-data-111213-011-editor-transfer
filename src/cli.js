import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Archive } from './archive.js';
import { inspect, sample } from './domain.js';

const [command = 'demo', file, directory = '.local/archive'] = process.argv.slice(2);
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
  } else if (command === 'demo') {
    const temporary = await mkdtemp(join(tmpdir(), 'intake-'));
    try {
      const inventory = await inspect(resolve(sample));
      const archive = new Archive(temporary);
      const receipt = await archive.accept(await readFile(sample), { source: sample, inventory });
      console.log(JSON.stringify({ inventory, receipt, verified: (await archive.read(receipt.sha256)).length }, null, 2));
      const domain = await import('./domain.js');
      console.log(JSON.stringify(await domain.livePreview(), null, 2));
    } finally { await rm(temporary, { recursive: true, force: true }); }
    const { runDemo } = await import('./demo.js');
    const { folder, report } = await runDemo({ directory: '.local/demo' });
    console.log(JSON.stringify({ editorTransfer: report.summary, report: join(folder, 'report.html') }, null, 2));
  } else if (command === 'transfer') {
    const { runBrowserTransfer } = await import('./browser.js');
    const sourceIndex = process.argv.indexOf('--source');
    const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : file;
    console.log(JSON.stringify(await runBrowserTransfer({
      source: source ? resolve(source) : undefined,
      headed: process.argv.includes('--headed'),
      blankDraft: process.argv.includes('--blank-draft')
    }), null, 2));
  } else { throw new Error('支持 inspect、capture、list、demo、transfer'); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
