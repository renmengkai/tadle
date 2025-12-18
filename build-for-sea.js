import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// 确保 dist 目录存在
const distDir = 'dist';
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// 读取原始 main.js
const originalCode = readFileSync('src/main.js', 'utf-8');

// 移除 shebang 如果有的话（虽然在这个项目中可能没有）
let code = originalCode;
if (code.startsWith('#!')) {
  code = code.substring(code.indexOf('\n') + 1);
}

// 写入临时文件用于构建
const tempFile = 'dist/temp-main.cjs';
writeFileSync(tempFile, code);

// 使用 esbuild 打包为单个 CommonJS 文件
console.log('Bundling code with esbuild...');
build({
  entryPoints: ['dist/temp-main.cjs'],
  outfile: 'dist/bundle.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['worker_threads', 'cluster'], // 排除原生模块
  minify: false,
  sourcemap: false,
}).then(() => {
  console.log('Bundle created successfully.');
  
  // 更新 sea-config.json 指向打包后的文件
  const seaConfig = {
    "main": "dist/bundle.cjs",
    "output": "dist/tadle.blob",
    "disableExperimentalSEAWarning": true
  };
  
  writeFileSync('sea-config.json', JSON.stringify(seaConfig, null, 2));
  console.log('Updated sea-config.json to use bundled file.');
}).catch(error => {
  console.error('Build failed:', error);
  process.exit(1);
});