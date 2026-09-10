import { build } from 'esbuild';
await build({
  entryPoints: ['app/client.ts'],
  outfile: 'public/scripts/service.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  legalComments: 'none',
});
