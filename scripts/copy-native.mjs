import { cp } from 'node:fs/promises';
await cp(new URL('../src/native', import.meta.url), new URL('../dist/native', import.meta.url), { recursive: true });
