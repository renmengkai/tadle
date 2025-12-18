import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { platform } from 'os';

// 获取命令行参数
const osArg = process.argv[2] || '';

// 确保 dist 目录存在
const distDir = 'dist';
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// 获取当前 Node.js 可执行文件路径
const nodePath = process.execPath;

// 根据操作系统确定输出文件名
let outputFile, blobFile;
if (osArg.includes('windows') || platform() === 'win32') {
  outputFile = 'dist/tadle-win.exe';
  blobFile = 'dist/tadle.blob';
} else {
  outputFile = 'dist/tadle-linux';
  blobFile = 'dist/tadle.blob';
}

console.log(`Copying Node.js executable from ${nodePath} to ${outputFile}...`);
copyFileSync(nodePath, outputFile);

console.log('Injecting blob into executable...');
try {
  // 对于 Windows 使用默认的 PE 注入方式
  if (osArg.includes('windows') || platform() === 'win32') {
    execSync(
      `npx postject "${outputFile}" NODE_SEA_BLOB "${blobFile}" ` +
      '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      {
        stdio: 'inherit'
      }
    );
  } 
  // 对于 Linux/Mac 使用 Mach-O 参数 (通用参数也适用于 ELF)
  else {
    execSync(
      `npx postject "${outputFile}" NODE_SEA_BLOB "${blobFile}" ` +
      '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ' +
      '--macho-segment-name NODE_SEA',
      {
        stdio: 'inherit'
      }
    );
  }
  console.log(`Successfully created executable: ${outputFile}`);
} catch (error) {
  console.error('Failed to inject blob:', error.message);
  process.exit(1);
}