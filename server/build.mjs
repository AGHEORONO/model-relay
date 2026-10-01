// Bundle the server and its one dependency into a single file, so the plugin
// runs straight from a git clone with no `npm install` step.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.js'],
  outfile: 'dist/server.mjs',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
});
