import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
const excluded = new Set(['node_modules', '.git', 'artifacts', 'dist', 'data', 'generated']);
const extensions = new Set(['.java', '.kt', '.sol', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.c', '.h', '.cpp']);
const totals = {
  original: { files: 0, physicalLines: 0, nonblankLines: 0 },
  upstream: { files: 0, physicalLines: 0, nonblankLines: 0 }
};
function walk(dir: string) {
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(file.name) || file.isSymbolicLink()) continue;
    const path = join(dir, file.name);
    if (file.isDirectory()) { walk(path); continue; }
    if (!extensions.has(extname(file.name))) continue;
    const text = readFileSync(path, 'utf8');
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const category = path.split(/[\\/]/).includes('upstream') ? 'upstream' : 'original';
    totals[category].files++;
    totals[category].physicalLines += text.length ? lines.length : 0;
    totals[category].nonblankLines += lines.filter(l => l.trim()).length;
  }
}
walk('.');
const report = {
  method: 'Physical and nonblank source lines, including source comments and tests. Excludes dependency installs, lockfiles, JSON, docs, binaries, build output, generated files and databases.',
  ...totals,
  totalNonblankSourceLines: totals.original.nonblankLines + totals.upstream.nonblankLines,
  upstreamProject: 'Besu 26.10.1; not original ClearLedger code'
};
writeFileSync('docs/source-count.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.totalNonblankSourceLines <= 100000) process.exitCode = 1;

