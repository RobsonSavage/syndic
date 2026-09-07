import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { launchProcess, commandLine } from '../dist/process.js';

test('cmd arguments reject expansion and quote breakout', () => {
  for (const value of ['%PATH%', 'a"b', 'a\nb', '!PATH!']) {
    assert.throws(() => commandLine('node', [value]));
  }
  assert.match(commandLine('node', ['a & b']), /"a & b"/);
});

for (const ending of ['stop', 'disconnect', 'crash', 'exit', 'no-pathext']) {
test(`job owns grandchildren on ${ending}`, { skip: process.platform !== 'win32' }, async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-process-'));
  let managed;
  try {
    await writeFile(join(cwd, 'child.cjs'), 'require("node:fs").writeFileSync("child.pid",String(process.pid)); setInterval(()=>{},1000);');
    await writeFile(join(cwd, 'parent.cjs'), 'require("node:child_process").spawn(process.execPath,["child.cjs"],{stdio:"ignore"}); ' +
      (ending === 'exit' ? 'setTimeout(()=>process.exit(0),1000);' : 'setInterval(()=>{},1000);'));
    const originalPathExt = process.env.PATHEXT;
    try {
      if (ending === 'no-pathext') delete process.env.PATHEXT;
      managed = await launchProcess(ending === 'no-pathext' ? 'node' : process.execPath,
        ['parent.cjs'], cwd, process.env, join(cwd, 'launch.json'));
    } finally {
      if (originalPathExt !== undefined) process.env.PATHEXT = originalPathExt;
    }
    let stderr = '';
    managed.proc.stderr.on('data', chunk => { stderr += chunk; });
    const closed = once(managed.proc, 'close');
    let pid;
    for (let i = 0; i < 200; i++) {
      try { pid = Number(await readFile(join(cwd, 'child.pid'), 'utf8')); break; } catch { }
      if (managed.proc.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(pid, stderr);
    process.kill(pid, 0);
    if (ending === 'stop' || ending === 'no-pathext') managed.stop();
    if (ending === 'disconnect') managed.proc.stdin.end();
    if (ending === 'crash') managed.proc.kill();
    await closed;
    if (ending !== 'crash') assert.equal((await managed.receipt()).termination, 'stopped', stderr);
    // Kill-on-close may finish just after the supervisor handle signals exit.
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(pid, 0));
  } finally {
    managed?.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
}
