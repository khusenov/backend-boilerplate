import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/instrumentation.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  dts: false,
});
