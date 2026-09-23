import * as esbuild from 'esbuild';
import path from 'node:path';

/**
 * Bundles the Electron main and preload scripts and the server's desktop
 * entry (`server/desktopHost.ts`, run as a utility process) into
 * `dist-electron/`. Every dependency is inlined, so the packaged app needs no
 * node_modules; only `electron` (runtime-provided) and Node builtins such as
 * `node:sqlite` stay external.
 */

const alias = {
  '@core': path.resolve('core'),
  '@server': path.resolve('server'),
  '@models': path.resolve('server/models'),
  '@routes': path.resolve('server/routes'),
  '@utils': path.resolve('server/utils'),
  '@config': path.resolve('server/config')
};

const serverBuild: esbuild.BuildOptions = {
  entryPoints: ['server/desktopHost.ts'],
  // CJS, not ESM: Express's CJS dependency tree (e.g. `debug`) does dynamic
  // `require()`s of Node builtins that esbuild's ESM output can't satisfy.
  outfile: 'dist-electron/server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  alias
};

const mainBuild: esbuild.BuildOptions = {
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['electron']
};

const preloadBuild: esbuild.BuildOptions = {
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron']
};

const watch = process.argv.includes('--watch');
const builds = [serverBuild, mainBuild, preloadBuild];

if (watch) {
  const contexts = await Promise.all(builds.map((build) => esbuild.context(build)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Watching server + electron main/preload for changes...');
} else {
  await Promise.all(builds.map((build) => esbuild.build(build)));
  console.log('Bundled dist-electron/');
}
