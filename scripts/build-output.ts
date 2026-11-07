import { createHash } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

type Manifest = { version: 1; outDir: string; files: Record<string, string> };
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

function inside(base: string, name: string): string {
  const file = path.resolve(base, name);
  const rel = path.relative(base, file);
  if (!rel || path.isAbsolute(name) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe build output path: ${name}`);
  }
  return file;
}

// Never follow a symlink while pruning a file recorded by an earlier build.
async function regularFile(root: string, file: string): Promise<boolean> {
  const parts = path.relative(root, file).split(path.sep);
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return false;
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  return true;
}

/** Keep the output directory in place on mounted filesystems. Only prune old
 * generated files after every file from this build can be read back correctly.
 * This is a completeness check, not an atomic deployment or a filesystem fix.
 */
export default function gameBuildOutput(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'game-build-output',
    apply: 'build',
    enforce: 'post',
    // Set this before Vite derives its per-environment build configuration.
    // Mutating resolved.build alone is too late in Vite 7.
    config() {
      return { build: { emptyOutDir: false } };
    },
    configResolved(resolved) {
      config = resolved;
    },
    async writeBundle(options, bundle) {
      const outDir = path.resolve(config.root, options.dir ?? config.build.outDir);
      const files: Record<string, string> = {};
      for (const output of Object.values(bundle)) {
        inside(outDir, output.fileName);
        files[output.fileName] = digest(output.type === 'chunk' ? output.code : output.source);
      }
      if (!files['index.html']) throw new Error('GAME BUILD: no index.html was emitted');

      // A success banner alone is insufficient on the runtime mount. Compare
      // contents too: a readable file may still be from the previous build.
      const deadline = Date.now() + 5000;
      let pending: string[];
      do {
        pending = [];
        for (const [name, hash] of Object.entries(files)) {
          const actual = await readFile(inside(outDir, name)).catch(() => null);
          if (!actual || digest(actual) !== hash) pending.push(name);
        }
        if (!pending.length) break;
        if (Date.now() >= deadline) {
          throw new Error(`GAME BUILD: output missing or stale in ${outDir}: ${pending.join(', ')}. ` +
            'Old files were not cleaned. Check mount write visibility; do not repeatedly delete/rebuild dist.');
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (true);

      const relativeOutDir = path.relative(config.root, outDir);
      // External --outDir builds can be checked, but must not change the
      // project's cleanup history (e.g. a one-off build under /tmp).
      if (relativeOutDir.startsWith('..') || path.isAbsolute(relativeOutDir) || !relativeOutDir) return;
      const manifestPath = path.join(config.root, '.game-build-files.json');
      let previous: Manifest | undefined;
      try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* first build */ }
      const migration = previous?.outDir === 'dist' && relativeOutDir === 'dist/public';
      if (previous?.version === 1 && previous.files &&
          (previous.outDir === relativeOutDir || migration)) {
        const previousDir = inside(config.root, previous.outDir);
        for (const [name, hash] of Object.entries(previous.files)) {
          let stale: string;
          try { stale = inside(previousDir, name); } catch { continue; }
          if (Object.keys(files).some(current => inside(outDir, current) === stale)) continue;
          // Public files and user modifications are not ours to delete.
          if (config.publicDir && await regularFile(config.publicDir, inside(config.publicDir, name))) continue;
          if (!await regularFile(config.root, stale)) continue;
          const actual = await readFile(stale).catch(() => null);
          if (actual && digest(actual) === hash) await unlink(stale);
        }
      }
      await writeFile(manifestPath, JSON.stringify({ version: 1, outDir: relativeOutDir, files }, null, 2) + '\n');
      console.log(`GAME BUILD: verified ${Object.keys(files).length} output files in ${outDir}`);
    },
  };
}
