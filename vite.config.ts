import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    // The bundle is mostly Three.js, which must load up front to render the
    // game; ~157 kB gzipped is fine. Raise Vite's 500 kB raw-size advisory so
    // it stops flagging the expected bundle size in build logs.
    chunkSizeWarningLimit: 700,
  },
  test: {
    // Pure game-logic unit tests run in plain Node (no WebGL/DOM needed).
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
