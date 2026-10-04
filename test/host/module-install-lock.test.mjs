import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-install-lock-')
const storage = new URL('../../src/host/module-storage.ts', import.meta.url).href
const writer = new URL('../../src/host/write-preset.ts', import.meta.url).href
const packageApi = new URL('../../src/host/module-package.ts', import.meta.url).href
const { ensureModuleSlices, readRulesDir, withModuleLock } = await import('../../src/host/module-storage.ts')
const definition = (id, text) => ({ id, name: id, modules: [], rules: [{ id: 'body', then: [{ id: 'inject', kind: 'inject-text', config: { text } }] }] })
function fixture(id, text) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify(definition(id, text)))
  return dir
}

test('安装最终目录交换与保存共享锁；独立进程不能跨过目标复核或交换窗口', async () => {
  for (const method of ['package', 'writer']) {
    const id = 'target-' + method
    const target = fixture(id, 'OLD')
    const source = fixture('source-' + method, 'INSTALLED')
    ensureModuleSlices(target)
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      import fs from 'node:fs';
      import { join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { writeModule } from ${JSON.stringify(writer)};
      import { installModulePackage, moduleImportPreview } from ${JSON.stringify(packageApi)};
      const [root, id, source, method] = process.argv.slice(1);
      const target = join(root, id), rename = fs.renameSync;
      let held = false;
      fs.renameSync = (from, to) => {
        if (!held && from === target) {
          held = true;
          fs.writeSync(1, 'swap-ready\\n');
          fs.readSync(0, Buffer.alloc(1), 0, 1, null);
          const result = rename(from, to);
          fs.writeSync(1, 'target-missing\\n');
          fs.readSync(0, Buffer.alloc(1), 0, 1, null);
          return result;
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      if (method === 'writer') writeModule('', { modulesRoot: root, moduleId: id, targetModuleId: id, sourceDir: source });
      else {
        const files = [{ path: 'module.yml', content: fs.readFileSync(join(source, 'module.yml'), 'utf8') }];
        const request = { targetId: id, overwrite: true };
        const preview = moduleImportPreview(root, files, request);
        await installModulePackage(root, files, { ...request, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision });
      }
    `, moduleRoot, id, source, method], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    const exit = once(child, 'exit')
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
    try {
      const [signal] = await once(child.stdout, 'data')
      assert.equal(signal.toString(), 'swap-ready\n')
      assert.equal(ensureModuleSlices(target).rules[0].then[0].config.text, 'OLD', '交换持锁期间读取旧已验证快照')
      const contender = spawn(process.execPath, ['--input-type=module', '--eval', `
        import fs from 'node:fs';
        import { join } from 'node:path';
        import { loadModuleDefinition, commitModuleDefinition } from ${JSON.stringify(storage)};
        import { writeModule } from ${JSON.stringify(writer)};
        import { installModulePackage, moduleImportPreview } from ${JSON.stringify(packageApi)};
        const [root, id, source] = process.argv.slice(1);
        let rejected = 0;
        const snapshot = loadModuleDefinition(join(root, id));
        snapshot.doc.set('unknown', 'CONTENDER');
        try { commitModuleDefinition(snapshot, snapshot.doc); } catch (error) { if (error.status === 409) rejected++; }
        try { writeModule('', { modulesRoot: root, moduleId: id, targetModuleId: id, sourceDir: source }); } catch (error) { if (error.status === 409) rejected++; }
        const files = [{ path: 'module.yml', content: fs.readFileSync(join(source, 'module.yml'), 'utf8') }];
        const request = { targetId: id, overwrite: true };
        const preview = moduleImportPreview(root, files, request);
        try { await installModulePackage(root, files, { ...request, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision }); }
        catch (error) { if (error.status === 409) rejected++; }
        try { writeModule('STALE ASSET', { modulesRoot: root, moduleId: id }); } catch (error) { if (error.status === 409) rejected++; }
        process.exit(rejected === 4 ? 0 : 1);
      `, moduleRoot, id, source], { cwd: tmpdir(), stdio: 'ignore' })
      assert.equal((await once(contender, 'exit'))[0], 0, '保存、直接安装、包安装和同目录资产写入都拒绝目标活锁')
      assert.equal(readFileSync(join(target, 'module.yml'), 'utf8').includes('CONTENDER'), false)
      const missing = once(child.stdout, 'data')
      child.stdin.write('x')
      assert.equal((await missing)[0].toString(), 'target-missing\n')
      assert.equal(existsSync(target), false)
      assert.equal(ensureModuleSlices(target).rules[0].then[0].config.text, 'OLD', '目录已移入备份的窗口仍可读取已验证旧快照')
      child.stdin.end('x')
      assert.equal((await exit)[0], 0, stderr)
    } finally { child.stdin.destroy(); if (child.exitCode === null) { child.kill(); await exit } }
    assert.equal(ensureModuleSlices(target).rules[0].then[0].config.text, 'INSTALLED')
    assert.equal(readRulesDir(target).contents[0].then[0].config.text, 'INSTALLED')
    assert.equal(readdirSync(moduleRoot).some(file => file.startsWith('.')), false, '临时根与锁目录成功后不残留')
  }
  withModuleLock(moduleRoot, 'new-target', () => {
    assert.equal(existsSync(join(moduleRoot, 'new-target')), false, '新建目标无需预先造目录即可持锁')
    assert.throws(() => withModuleLock(moduleRoot, 'new-target', () => {}), error => error.status === 409)
  })
  assert.equal(readdirSync(moduleRoot).some(file => file.startsWith('.')), false)
})
