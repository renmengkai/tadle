import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { platform } from 'os';

// 确保 dist 目录存在
const distDir = 'dist';
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// 获取当前 Node.js 可执行文件路径
const nodePath = process.execPath;

// 确定输出文件名
let outputFile;
if (platform() === 'win32') {
  outputFile = 'dist/tadle.exe';
} else {
  outputFile = 'dist/tadle';
}

console.log(`Copying Node.js executable from ${nodePath} to ${outputFile}...`);
copyFileSync(nodePath, outputFile);

console.log('Injecting blob into executable...');
try {
  let postjectCmd = `npx postject ${outputFile} NODE_SEA_BLOB dist/tadle.blob ` +
    '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
    
  // 添加 macOS 特定参数
  if (platform() !== 'darwin') {
    postjectCmd += ' --macho-segment-name NODE_SEA';
  }
  
  execSync(postjectCmd, {
    stdio: 'inherit'
  });
  console.log(`Successfully created executable: ${outputFile}`);
} catch (error) {
  console.error('Failed to inject blob:', error.message);
  process.exit(1);
}