import { defineConfig } from 'tsup';

// @gantt-flow/core は TS ソースのまま配布される（main = src/index.ts）。Node 単体で
// 動く dist を作るためバンドルへ取り込む（noExternal）。SDK / zod は実 npm 依存として外部化し、
// 隣の node_modules から解決させる。banner で shebang を付け bin として実行可能にする。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  noExternal: ['@gantt-flow/core'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  sourcemap: true,
  dts: false,
});
