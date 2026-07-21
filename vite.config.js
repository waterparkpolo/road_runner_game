import { defineConfig } from 'vite';

// GitHub Pages project sites serve from /<repo-name>/, not the domain root --
// without this, built asset URLs resolve to the wrong path and 404. Scoped to
// the 'build' command only so local dev (and LAN/phone testing against the
// dev server) still serves from root instead of also needing the subpath.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/road_runner_game/' : '/',
}));
