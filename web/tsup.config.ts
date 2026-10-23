import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', sw: 'src/sw/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'es2019',
  },
  {
    // A classic script, which every browser's Service Workers can load
    entry: { 'range-source-sw': 'src/sw/script.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.js' }),
    target: 'es2019',
    minify: true,
  },
]);
