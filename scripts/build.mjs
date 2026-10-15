import { build } from 'esbuild';

// 只生成 Pages 部署文件，保留根目录可直接编辑的中文源码。
await build({
  entryPoints: ['index.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: '// 由 index.js 构建。修改配置请编辑项目根目录的 index.js。' },
  outfile: 'dist/_worker.js',
});
