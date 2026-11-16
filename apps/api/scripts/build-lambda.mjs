import { URL } from 'node:url';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const output = new URL('../dist-lambda/', import.meta.url);
rmSync(output, { recursive: true, force: true });
mkdirSync(new URL('certs/', output), { recursive: true });

await build({
  entryPoints: [new URL('../src/lambda/handler.ts', import.meta.url).pathname],
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
  new URL('../src/certs/supabase-ca.crt', import.meta.url),
  new URL('certs/supabase-ca.crt', output),
);
