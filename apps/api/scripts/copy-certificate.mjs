import { URL } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../dist/lambda/certs/', import.meta.url), { recursive: true });
cpSync(
  new URL('../src/certs/supabase-ca.crt', import.meta.url),
  new URL('../dist/lambda/certs/supabase-ca.crt', import.meta.url),
);
