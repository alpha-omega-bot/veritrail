// Generates consistent package.json + tsconfig.json for each governance module.
// Idempotent: only writes a file if it does not already exist.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
  ['audit', 'Audit & integrity: query, verify, and export the tamper-evident ledger.'],
  ['permissions', 'Permissions: a deny-by-default policy engine that gates agent actions.'],
  ['spend-guard', 'Spend Guard: budget tracking and hard-stop enforcement over cost events.'],
  ['rollback', 'Rollback: build and execute compensating plans to reverse recorded actions.'],
  ['forensics', 'Incident Forensics: reconstruct timelines and causal chains from the ledger.'],
  ['evidence', 'Evidence Tracing: a content-addressed provenance graph for decisions.'],
  ['decision-memory', 'Decision Memory: record and recall agent decisions and their rationale.'],
  ['vendor-risk', 'Vendor Risk: inventory third parties and score time-decayed risk signals.'],
];

const tsconfig = {
  extends: '../../../tsconfig.base.json',
  compilerOptions: { outDir: 'dist', rootDir: 'src', types: ['node'] },
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts', 'test/**', 'dist', 'node_modules'],
};

const write = (path, obj) => {
  if (existsSync(path)) {
    console.log(`skip   ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  console.log(`create ${path}`);
};

for (const [name, description] of MODULES) {
  const dir = join(root, 'packages', 'modules', name);
  write(join(dir, 'package.json'), {
    name: `@veritrail/${name}`,
    version: '0.1.0',
    description,
    license: 'Apache-2.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    files: ['dist', 'README.md'],
    sideEffects: false,
    scripts: { build: 'tsc -p tsconfig.json', clean: 'rm -rf dist *.tsbuildinfo' },
    dependencies: { '@veritrail/core': 'workspace:*', zod: '^3.24.1' },
    engines: { node: '>=20.11.0' },
    publishConfig: { access: 'public' },
  });
  write(join(dir, 'tsconfig.json'), tsconfig);
}
