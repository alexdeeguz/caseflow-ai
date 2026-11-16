import { URL } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const output = new URL('../dist/', import.meta.url);
mkdirSync(output, { recursive: true });

await build({
  entryPoints: [new URL('../src/handler.ts', import.meta.url).pathname],
  outfile: new URL('index.mjs', output).pathname,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['pg-native'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

cpSync(
  new URL('../../document-processor/src/caseflow_processor/certs/supabase-ca.crt', import.meta.url),
  new URL('supabase-ca.crt', output),
);
