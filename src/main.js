// src/main.js
import cluster from 'cluster';
import os from 'os';
import fs from 'fs/promises';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

// 简单的.env文件解析函数
async function loadEnvFile() {
    try {
        const envContent = await fs.readFile('.env', 'utf8');
        const lines = envContent.split(/\r?\n/);
        
        lines.forEach(line => {
            // 忽略注释和空行
            if (line.trim() === '' || line.startsWith('#')) return;
            
            const [key, value] = line.split('=');
            if (key && value !== undefined) {
                process.env[key.trim()] = value.trim();
            }
        });
        
        console.log('Environment variables loaded from .env file');
    } catch (err) {
        console.log('No .env file found, using default environment variables');
    }
}

// 检查是否需要初始化
async function checkAndInitialize() {
    try {
        // 检查必要的文件是否存在
        await fs.access('wallets.txt');
        await fs.access('proxies.txt');
        await fs.access('.env');
        // 如果都存在，不需要初始化
        return false;
    } catch (err) {
        // 至少有一个文件不存在，需要询问用户是否初始化
        return true;
    }
}

// 初始化项目文件
async function initializeProject() {
    console.log('检测到这是首次运行，需要初始化配置文件。');
    console.log('');
    console.log('本程序需要以下配置文件才能正常运行：');
    console.log('1. wallets.txt - 存放待处理的钱包私钥，每行一个');
    console.log('2. proxies.txt - 存放代理服务器信息，每行一个');
    console.log('3. .env - 环境变量配置文件，包括API密钥等配置');
    console.log('');
    
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const question = (query) => new Promise(resolve => rl.question(query, resolve));
    
    try {
        const answer = await question('是否在当前目录初始化配置文件？(y/N): ');
        rl.close();
        
        if (answer.toLowerCase() !== 'y') {
            console.log('用户取消初始化，程序退出。');
            process.exit(0);
        }

        // 创建 wallets.txt 文件
        try {
            await fs.access('wallets.txt');
            console.log('wallets.txt 文件已存在，跳过创建');
        } catch (err) {
            const walletContent = `# Wallets 文件
# 请在此文件中每行放置一个钱包私钥
# 示例格式：
# 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
# 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890

`;
            await fs.writeFile('wallets.txt', walletContent);
            console.log('已创建 wallets.txt 文件');
        }

        // 创建 proxies.txt 文件
        try {
            await fs.access('proxies.txt');
            console.log('proxies.txt 文件已存在，跳过创建');
        } catch (err) {
            const proxyContent = `# Proxies 文件
# 请在此文件中每行放置一个代理地址
# 示例格式：
# http://username:password@ip:port
# socks5://username:password@ip:port
# http://ip:port （无认证信息的代理）

`;
            await fs.writeFile('proxies.txt', proxyContent);
            console.log('已创建 proxies.txt 文件');
        }

        // 创建 .env 文件
        try {
            await fs.access('.env');
            console.log('.env 文件已存在，跳过创建');
        } catch (err) {
            const envContent = `# 代理设置 (true/false)
USE_PROXY=true

# 重试次数
MAX_RETRIES=3

# ====== 日志配置 ======
# 日志级别: error, warn, info, debug
# error - 只输出错误
# warn  - 错误 + 警告
# info  - 错误 + 警告 + 关键信息（默认）
# debug - 所有日志（包含调试信息）
LOG_LEVEL=info

# ====== 并发配置 ======
# Worker数量（多进程），默认等于代理数量，最大建议50
CONCURRENCY=50

# 每个Worker内部并发数
# 建议1-3，太高可能触发频率限制
BATCH_CONCURRENCY=1

# ====== 验证码服务配置（必填，无需修改） ======
# Cloudflare Turnstile sitekey
TURNSTILE_SITEKEY=0x4AAAAAAAM8ceq5KhP1uJBt

# yesCaptcha API Key (用于解决 Turnstile 验证码)
# 获取地址: https://yescaptcha.com
YESCAPTCHA_CLIENT_KEY=your_yescaptcha_client_key_here

`;
            await fs.writeFile('.env', envContent);
            console.log('已创建 .env 文件');
        }

        console.log('');
        console.log('初始化完成！请按以下步骤配置：');
        console.log('1. 编辑 wallets.txt 文件，添加您的钱包私钥（每行一个）');
        console.log('2. 编辑 proxies.txt 文件，添加您的代理服务器信息（每行一个）');
        console.log('3. 编辑 .env 文件，配置 API 密钥等相关参数');
        console.log('');
        console.log('配置完成后，再次运行程序即可开始执行任务。');
        console.log('');

        process.exit(0);
    } catch (err) {
        rl.close();
        console.error('初始化过程中发生错误:', err.message);
        process.exit(1);
    }
}

// 将主逻辑包装在异步函数中以避免顶层 await 问题
async function main() {
  // 检查是否需要初始化
  if (await checkAndInitialize()) {
      await initializeProject();
  }
  
  if (cluster.isMaster || cluster.isPrimary) {
      // ====== 主进程 ======
      // 加载.env文件
      await loadEnvFile();
      
      const wallets = (await fs.readFile('wallets.txt', 'utf8')).trim().split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
      let proxyLines = [];
      try {
          proxyLines = (await fs.readFile('proxies.txt', 'utf8')).trim().split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
      } catch (err) {
          console.log('No proxies.txt file found or empty, running without proxies');
      }

      // 添加环境变量控制是否使用代理
      const useProxy = process.env.USE_PROXY !== 'false';

      // 解析代理行：http://user:pass@ip:port -> { server, username, password }
      let proxies = [];
      if (useProxy) {
          proxies = proxyLines
              .map(line => line.trim()) // 去除前后空格
              .filter(line => line.length > 0 && !line.startsWith('#')) // 过滤掉空行和注释行
              .map(line => {
                  const url = new URL(line);
                  return {
                      server: `${url.protocol}//${url.hostname}:${url.port}`,
                      username: url.username,
                      password: url.password,
                  };
              });
      } else {
          console.log('Proxy disabled by environment variable');
      }

      console.log(`Loaded ${wallets.length} wallets, ${proxies.length} proxies`);

      // 确保 outputs 目录存在
      try {
          await fs.mkdir('outputs', { recursive: true });
      } catch (err) {
          // 目录可能已存在
      }

      // 生成日志文件名（带时间戳）
      const now = new Date();
      const timeStr = now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0') +
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0');
      const logFilePath = `outputs/tadle_${timeStr}.log`;
      const resultFilePath = `outputs/result_${timeStr}.csv`;
      
      // 初始化日志文件
      await fs.writeFile(logFilePath, `=== Tadle Log Started at ${now.toISOString()} ===\n`);
      
      // 确保结果文件和临时文件都不存在
      await fs.unlink(resultFilePath).catch(() => {});
      await fs.unlink(resultFilePath + '.tmp').catch(() => {});
      
      console.log(`日志文件: ${logFilePath}`);
      console.log(`结果文件: ${resultFilePath}`);

      // ====== 并发优化配置 ======
      // 从环境变量读取并发数，默认根据代理数量设置
      const defaultWorkers = proxies.length > 0 ? Math.min(proxies.length, 50) : Math.min(4, os.cpus().length);
      const numWorkers = parseInt(process.env.CONCURRENCY) || defaultWorkers;
      
      // 每个worker内部的并发数（用于纯API模式）
      const batchConcurrency = parseInt(process.env.BATCH_CONCURRENCY) || 1;
      
      console.log(`\n====== 并发配置 ======`);
      console.log(`Worker数量: ${numWorkers}`);
      console.log(`每个Worker内部并发: ${batchConcurrency}`);
      console.log(`理论最大并发: ${numWorkers * batchConcurrency}`);
      console.log(`预估处理时间: 约${Math.ceil(wallets.length / (numWorkers * batchConcurrency) * 30 / 60)}分钟 (假设每个账号约30秒)`);
      console.log(`========================\n`);
      
      const batchSize = Math.ceil(wallets.length / numWorkers);

      for (let i = 0; i < numWorkers; i++) {
          const batch = wallets.slice(i * batchSize, (i + 1) * batchSize);
          if (batch.length === 0) continue;
          
          // 为每个worker分配一个或多个代理（循环分配）
          const workerProxies = proxies.length > 0 
              ? [proxies[i % proxies.length]]  // 每个worker分配一个固定代理
              : [];
          
          cluster.fork({
              WALLET_BATCH: JSON.stringify(batch),
              PROXIES: JSON.stringify(workerProxies),
              WORKER_ID: String(i),
              USE_PROXY: process.env.USE_PROXY || 'true',
              MAX_RETRIES: process.env.MAX_RETRIES || '3',
              BATCH_CONCURRENCY: String(batchConcurrency),
              YESCAPTCHA_CLIENT_KEY: process.env.YESCAPTCHA_CLIENT_KEY || '',
              TURNSTILE_SITEKEY: process.env.TURNSTILE_SITEKEY || '',
              LOG_LEVEL: process.env.LOG_LEVEL || 'info',
              LOG_FILE_PATH: logFilePath,
              RESULT_FILE_PATH: resultFilePath,
          });
      }

      let exited = 0;
      let workCompleted = 0;
      let finalizeDone = false;
      const workerCount = Object.keys(cluster.workers).length;

      // 监听来自worker的消息
      for (const id in cluster.workers) {
          cluster.workers[id].on('message', (msg) => {
              if (msg.type === 'workCompleted') {
                  workCompleted++;
                  // 检查是否所有工作都已完成
                  if (workCompleted === workerCount) {
                      finalizeCSVFiles();
                  }
              }
          });

          cluster.workers[id].on('exit', async () => {
              exited++;
              // 检查是否所有worker都已退出
              if (exited === workerCount) {
                  finalizeCSVFiles();
              }
          });
      }

      // 整理CSV文件的函数
      async function finalizeCSVFiles() {
          // 避免重复执行
          if (finalizeDone) return;
          finalizeDone = true;

          // 所有子进程结束后，整理CSV文件
          console.log('✅ All workers done. Finalizing CSV file...');
          
          // 简化版本的finalizeCSV在主进程中执行
          try {
              const tempFilePath = resultFilePath + '.tmp';
              // 检查临时文件是否存在
              try {
                  await fs.access(tempFilePath);

                  // 读取所有临时数据
                  const tempContent = await fs.readFile(tempFilePath, 'utf8');
                  const lines = tempContent.trim().split('\n').filter(line => line.trim());

                  if (lines.length > 0) {
                      // 解析所有结果数据
                      const allResults = lines.map(line => {
                          try {
                              return JSON.parse(line);
                          } catch (e) {
                              console.error(`Error parsing line: ${line}`, e);
                              return null;
                          }
                      }).filter(r => r !== null);

                      // 获取所有唯一的资产类型
                      const allAssetTypes = new Set();
                      allResults.forEach(r => {
                          if (r.summary && r.summary.assetStats) {
                              Object.keys(r.summary.assetStats).forEach(assetType => {
                                  allAssetTypes.add(assetType);
                              });
                          }
                      });

                      // 生成表头
                      const headerFields = ['wallet', 'status', 'allOpened', 'totalBoxes'];

                      // 为每种资产类型添加三列，列名包含资产类型
                      [...allAssetTypes].sort().forEach(assetType => {
                          headerFields.push(
                              `totalAmount(${assetType})`,
                              `totalTtAmount(${assetType})`,
                              `totalTfeAmount(${assetType})`
                          );
                      });

                      headerFields.push('openedCount', 'error', 'timestamp');

                      // 生成数据行
                      const rows = allResults.map(r => {
                          const fields = [
                              r.wallet || '',
                              r.status || '',
                              r.allOpened !== undefined ? r.allOpened : '',
                              r.totalBoxes !== undefined ? r.totalBoxes : ''
                          ];

                          // 添加每种资产类型的统计数据
                          [...allAssetTypes].sort().forEach(assetType => {
                              const assetStat = (r.summary && r.summary.assetStats && r.summary.assetStats[assetType]) || {};
                              fields.push(
                                  assetStat.totalAmount !== undefined ? assetStat.totalAmount.toFixed(4) : '0.0000',
                                  assetStat.totalTtAmount !== undefined ? assetStat.totalTtAmount.toFixed(4) : '0.0000',
                                  assetStat.totalTfeAmount !== undefined ? assetStat.totalTfeAmount.toFixed(4) : '0.0000'
                              );
                          });

                          fields.push(
                              r.openedCount !== undefined ? r.openedCount : '',
                              (r.error || '').replace(/,/g, ';').replace(/\n/g, ' '),
                              r.timestamp || ''
                          );

                          return fields.join(',');
                      });

                      // 写入最终的CSV文件
                      await fs.writeFile(resultFilePath, headerFields.join(',') + '\n' + rows.join('\n') + '\n');
                      console.log(`✅ Finalized CSV file with ${allResults.length} records`);
                  } else {
                      // 如果没有数据，创建一个空的CSV文件
                      await fs.writeFile(resultFilePath, 'wallet,status,allOpened,totalBoxes,openedCount,error,timestamp\n');
                  }

                  // 删除临时文件
                  await fs.unlink(tempFilePath).catch(() => {});
              } catch (err) {
                  // 临时文件不存在，创建一个空的CSV文件
                  await fs.writeFile(resultFilePath, 'wallet,status,allOpened,totalBoxes,openedCount,error,timestamp\n');
              }
          } catch (err) {
              console.error(`Error finalizing CSV file: ${err.message}`);
              console.error(err.stack);
          }

          console.log('✅ All done.');
      }
  } else {
      // ====== 子进程 ======
      const wallets = JSON.parse(process.env.WALLET_BATCH);
      const proxies = JSON.parse(process.env.PROXIES);
      const workerId = process.env.WORKER_ID;
      const useProxy = process.env.USE_PROXY !== 'false';
      const maxRetries = parseInt(process.env.MAX_RETRIES) || 3;
      
      // ====== 日志级别控制 ======
      // LOG_LEVEL: error=0, warn=1, info=2, debug=3
      const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
      const logLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;
      const logFilePath = process.env.LOG_FILE_PATH;
      
      // 写入日志文件的函数
      const writeToLogFile = async (level, walletId, ...args) => {
          if (!logFilePath) return;
          const timestamp = new Date().toISOString();
          const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
          const walletTag = walletId ? `[${walletId}]` : '';
          const line = `[${timestamp}] [${level.toUpperCase()}] [W${workerId}]${walletTag} ${message}\n`;
          try {
              await fs.appendFile(logFilePath, line);
          } catch (err) {
              // 忽略写入错误
          }
      };
      
      // 基础日志对象（不带钱包标识）
      const log = {
          error: (...args) => {
              if (logLevel >= LOG_LEVELS.error) console.error(`[W${workerId}]`, ...args);
              writeToLogFile('error', null, ...args);
          },
          warn: (...args) => {
              if (logLevel >= LOG_LEVELS.warn) console.warn(`[W${workerId}]`, ...args);
              writeToLogFile('warn', null, ...args);
          },
          info: (...args) => {
              if (logLevel >= LOG_LEVELS.info) console.log(`[W${workerId}]`, ...args);
              writeToLogFile('info', null, ...args);
          },
          debug: (...args) => {
              if (logLevel >= LOG_LEVELS.debug) console.log(`[W${workerId}] [DEBUG]`, ...args);
              writeToLogFile('debug', null, ...args);
          },
          // 创建带钱包标识的日志对象
          withWallet: (walletAddress) => {
              const walletId = walletAddress.slice(-8); // 取后8位
              return {
                  error: (...args) => {
                      if (logLevel >= LOG_LEVELS.error) console.error(`[W${workerId}][${walletId}]`, ...args);
                      writeToLogFile('error', walletId, ...args);
                  },
                  warn: (...args) => {
                      if (logLevel >= LOG_LEVELS.warn) console.warn(`[W${workerId}][${walletId}]`, ...args);
                      writeToLogFile('warn', walletId, ...args);
                  },
                  info: (...args) => {
                      if (logLevel >= LOG_LEVELS.info) console.log(`[W${workerId}][${walletId}]`, ...args);
                      writeToLogFile('info', walletId, ...args);
                  },
                  debug: (...args) => {
                      if (logLevel >= LOG_LEVELS.debug) console.log(`[W${workerId}][${walletId}] [DEBUG]`, ...args);
                      writeToLogFile('debug', walletId, ...args);
                  },
              };
          },
      };

      const { ethers } = await import('ethers');
      
      // 导入undici用于代理支持
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      
      // 创建代理agent
      let proxyAgent = null;
      if (useProxy && proxies.length > 0) {
          const proxy = proxies[0]; // 使用第一个代理
          const proxyUrl = proxy.username && proxy.password 
              ? `${proxy.server.replace('http://', 'http://' + proxy.username + ':' + proxy.password + '@')}`
              : proxy.server;
          log.info(`Using proxy for API requests: ${proxy.server}`);
          proxyAgent = new ProxyAgent(proxyUrl);
      }
      
      // 封装支持代理的fetch函数
      const proxyFetch = async (url, options = {}) => {
          if (proxyAgent) {
              return undiciFetch(url, { ...options, dispatcher: proxyAgent });
          }
          return fetch(url, options);
      };

      const PRIVY_INIT_URL = 'https://auth.privy.io/api/v1/siwe/init';
      const PRIVY_AUTH_URL = 'https://auth.privy.io/api/v1/siwe/authenticate';
      const TARGET_URL = 'https://claim.tadle.com';
      const PRIVY_APP_ID = 'cmi5tijs501zok10cgqzneakt';
      const PRIVY_CLIENT = 'react-auth:3.8.1';
      
      // Tadle API URLs
      const TADLE_AIRDROP_URL = 'https://sb-api.tadle.com/tle/airdrop';
      const TADLE_CLAIM_URL = 'https://sb-api.tadle.com/tle/claim';
      
      // 公共请求头
      const getCommonHeaders = (token) => ({
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,en-US;q=0.7,en;q=0.3',
          'Accept-Encoding': 'gzip, deflate, br',  // 移除zstd，undici不支持自动解压
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0',
          'Referer': 'https://claim.tadle.com/',
          'Origin': 'https://claim.tadle.com',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
          'Authorization': `Bearer ${token}`,
          'DNT': '1',
          'Sec-GPC': '1',
      });
      
      // 获取airdrop信息，返回is_opened为0的boxes（按weeks升序排序）
      async function getAirdropInfo(walletAddress, token, wlog, retries = 0) {
          const url = `${TADLE_AIRDROP_URL}?wallet=${walletAddress}`;
          wlog.info(`Fetching airdrop info${retries > 0 ? ` (retry ${retries}/${maxRetries})` : ''}`);
          wlog.debug(`Request URL: ${url}`);
          
          const headers = getCommonHeaders(token);
          wlog.debug(`Authorization: Bearer ${token.substring(0, 30)}...`);
          
          try {
              const resp = await proxyFetch(url, {
                  method: 'GET',
                  headers: headers
              });
              
              wlog.debug(`Response status: ${resp.status}`);
              
              // 先获取原始文本，然后尝试解析JSON
              const rawText = await resp.text();
              wlog.debug(`Response body (first 200 chars): ${rawText.substring(0, 200)}`);
              
              let data;
              try {
                  data = JSON.parse(rawText);
              } catch (parseErr) {
                  wlog.error(`JSON parse error: ${parseErr.message}`);
                  if (retries < maxRetries) {
                      wlog.warn(`Retrying getAirdropInfo after parse error...`);
                      await new Promise(r => setTimeout(r, 2000));
                      return getAirdropInfo(walletAddress, token, wlog, retries + 1);
                  }
                  return { boxes: [], allOpened: false, error: 'JSON parse error: ' + parseErr.message };
              }
              
              // 检查是否是"Not eligible"响应
              if (!data.status && data.message === "Not eligible") {
                  wlog.info(`Wallet is not eligible for airdrop`);
                  return { 
                      boxes: [], 
                      allOpened: true, 
                      notEligible: true,
                      error: 'Not eligible'
                  };
              }
              
              if (!data.status || !data.data || !data.data.boxes) {
                  wlog.warn(`Invalid airdrop response: ${JSON.stringify(data)}`);
                  if (retries < maxRetries) {
                      wlog.warn(`Retrying getAirdropInfo...`);
                      await new Promise(r => setTimeout(r, 2000));
                      return getAirdropInfo(walletAddress, token, wlog, retries + 1);
                  }
                  return { boxes: [], allOpened: true, error: 'Invalid response' };
              }
              
              const allBoxes = data.data.boxes;
              
              // 过滤出is_opened为0的boxes，并按weeks升序排序
              const unopenedBoxes = allBoxes
                  .filter(box => box.is_opened === 0)
                  .sort((a, b) => a.weeks - b.weeks);
              
              // 按资产类型分别统计
              const assetStats = {};
              allBoxes.forEach(box => {
                  const asset = box.asset;
                  if (!assetStats[asset]) {
                      assetStats[asset] = {
                          totalAmount: 0,
                          totalTtAmount: 0,
                          totalTfeAmount: 0,
                          totalCount: 0,
                          openedCount: 0
                      };
                  }

                  assetStats[asset].totalAmount += parseFloat(box.amount || 0);
                  assetStats[asset].totalTtAmount += parseFloat(box.tt_amount || 0);
                  assetStats[asset].totalTfeAmount += parseFloat(box.tfe_amount || 0);
                  assetStats[asset].totalCount++;

                  if (box.is_opened === 1) {
                      assetStats[asset].openedCount++;
                  }
              });

              // 计算总体统计
              const totalBoxes = allBoxes.length;
              let totalAmount = 0;
              let totalTtAmount = 0;
              let totalTfeAmount = 0;
              let openedCount = 0;
              
              Object.values(assetStats).forEach(asset => {
                  totalAmount += asset.totalAmount;
                  totalTtAmount += asset.totalTtAmount;
                  totalTfeAmount += asset.totalTfeAmount;
                  openedCount += asset.openedCount;
              });

              wlog.info(`Boxes: ${totalBoxes} total, ${unopenedBoxes.length} unopened, Total Amount: ${totalAmount.toFixed(2)}`);
              
              // 检查是否所有boxes都已打开
              const allOpened = allBoxes.length > 0 && unopenedBoxes.length === 0;
              
              return { 
                  boxes: unopenedBoxes, 
                  allBoxes,
                  allOpened,
                  notEligible: false,
                  // 汇总信息
                  summary: {
                      totalBoxes,
                      totalAmount,
                      totalTtAmount,
                      totalTfeAmount,
                      openedCount,
                      unopenedCount: unopenedBoxes.length,
                      assetStats // 添加按资产类型统计的信息
                  },
                  baseDate: data.data.base_date,
                  currentDate: data.data.current_date,
                  nextOpenTime: data.data.next_open_time
              };
          } catch (err) {
              wlog.error(`Error fetching airdrop info: ${err.message}`);
              wlog.debug(`Error stack: ${err.stack}`);
              if (retries < maxRetries) {
                  wlog.warn(`Retrying getAirdropInfo after error...`);
                  await new Promise(r => setTimeout(r, 2000));
                  return getAirdropInfo(walletAddress, token, wlog, retries + 1);
              }
              return { boxes: [], allOpened: false, error: err.message };
          }
      }
      
      // Claim一个box（带重试机制）
      async function claimBox(walletAddress, boxId, token, wlog, retries = 0) {
          wlog.info(`Claiming box: ${boxId.substring(0, 8)}...${retries > 0 ? ` (retry ${retries}/${maxRetries})` : ''}`);
          
          try {
              const resp = await proxyFetch(TADLE_CLAIM_URL, {
                  method: 'POST',
                  headers: getCommonHeaders(token),
                  body: JSON.stringify({
                      wallet: walletAddress,
                      box_id: boxId
                  })
              });
              
              const data = await resp.json();
              wlog.debug(`Claim response status: ${resp.status}`);
              
              if (data.status && data.data) {
                  wlog.info(`✅ Box claimed: ${boxId.substring(0, 8)}...`);
                  return { success: true, data: data.data };
              } else {
                  wlog.warn(`Claim failed: ${JSON.stringify(data)}`);
                  if (retries < maxRetries) {
                      wlog.warn(`Retrying claimBox...`);
                      await new Promise(r => setTimeout(r, 2000));
                      return claimBox(walletAddress, boxId, token, wlog, retries + 1);
                  }
                  return { success: false, error: data };
              }
          } catch (err) {
              wlog.error(`Error claiming box: ${err.message}`);
              if (retries < maxRetries) {
                  wlog.warn(`Retrying claimBox after error...`);
                  await new Promise(r => setTimeout(r, 2000));
                  return claimBox(walletAddress, boxId, token, wlog, retries + 1);
              }
              return { success: false, error: err.message };
          }
      }
      
      // 处理钱包的完整业务流程
      async function processWalletBusiness(walletAddress, token, wlog) {
          const results = [];
          
          // 步骤1: 获取airdrop信息
          let airdropInfo = await getAirdropInfo(walletAddress, token, wlog);
          
          // 检查是否为"Not eligible"情况
          if (airdropInfo.notEligible) {
              wlog.info(`Wallet is not eligible for airdrop`);
              results.push({
                  wallet: walletAddress,
                  status: 'NOT_ELIGIBLE',
                  allOpened: true,
                  totalBoxes: 0,
                  totalAmount: 0,
                  totalTtAmount: 0,
                  totalTfeAmount: 0,
                  openedCount: 0,
                  timestamp: new Date().toISOString()
              });
              return results;
          }
          
          // 检查是否获取失败
          if (airdropInfo.error && !airdropInfo.notEligible) {
              wlog.error(`Failed to get airdrop info: ${airdropInfo.error}`);
              results.push({
                  wallet: walletAddress,
                  status: 'FAILED',
                  error: airdropInfo.error,
                  timestamp: new Date().toISOString()
              });
              return results;
          }
          
          // 获取汇总信息
          const summary = airdropInfo.summary;
          
          if (airdropInfo.boxes.length === 0) {
              wlog.info(`No unopened boxes. Total: ${summary.totalBoxes}, Opened: ${summary.openedCount}, Amount: ${summary.totalAmount.toFixed(2)}`);
              results.push({
                  wallet: walletAddress,
                  status: 'NO_UNOPENED_BOXES',
                  allOpened: airdropInfo.allOpened,
                  totalBoxes: summary.totalBoxes,
                  totalAmount: summary.totalAmount.toFixed(4),
                  totalTtAmount: summary.totalTtAmount.toFixed(4),
                  totalTfeAmount: summary.totalTfeAmount.toFixed(4),
                  openedCount: summary.openedCount,
                  summary: summary, // 包含assetStats信息
                  timestamp: new Date().toISOString()
              });
              return results;
          }
          
          // 步骤2: 逐个claim未打开的boxes
          let claimedCount = 0;
          let failedCount = 0;
          for (const box of airdropInfo.boxes) {
              wlog.debug(`Processing box: ${box.uuid}, weeks: ${box.weeks}, amount: ${box.amount}`);
              
              const claimResult = await claimBox(walletAddress, box.uuid, token, wlog);
              
              if (claimResult.success) {
                  claimedCount++;
              } else {
                  failedCount++;
                  wlog.warn(`Claim failed for box ${box.uuid.substring(0, 8)}...`);
              }
              
              await new Promise(r => setTimeout(r, 1000));
          }
          
          wlog.info(`Claimed ${claimedCount}/${airdropInfo.boxes.length} boxes`);
          
          // 步骤3: 重新获取airdrop信息，验证并汇总
          wlog.debug(`Verifying all boxes are opened...`);
          const verifyInfo = await getAirdropInfo(walletAddress, token, wlog);
          const verifySummary = verifyInfo.summary || summary;
          
          if (verifyInfo.allOpened) {
              wlog.info(`✅ Verified: All ${verifySummary.totalBoxes} boxes opened, Total: ${verifySummary.totalAmount.toFixed(2)}`);
          } else {
              wlog.warn(`⚠️ Still ${verifyInfo.boxes.length} boxes unopened`);
          }
          
          // 添加验证结果（包含汇总信息）
          const finalStatus = verifyInfo.allOpened ? 'SUCCESS' : (failedCount > 0 ? 'PARTIAL' : 'SUCCESS');
          results.push({
              wallet: walletAddress,
              status: finalStatus,
              allOpened: verifyInfo.allOpened,
              totalBoxes: verifySummary.totalBoxes,
              totalAmount: verifySummary.totalAmount.toFixed(4),
              totalTtAmount: verifySummary.totalTtAmount.toFixed(4),
              totalTfeAmount: verifySummary.totalTfeAmount.toFixed(4),
              openedCount: verifySummary.openedCount,
              summary: verifySummary, // 包含assetStats信息
              timestamp: new Date().toISOString()
          });
          
          return results;
      }
      
      // 将结果保存到CSV文件 (临时版本，仅追加数据)
      const resultFilePath = process.env.RESULT_FILE_PATH;
      async function saveResultsToCSV(results) {
          if (results.length === 0 || !resultFilePath) return;
          
          // 使用文件锁机制避免并发写入冲突
          const tempData = results.map(r => JSON.stringify(r)).join('\n') + '\n';
          const tempFilePath = resultFilePath + '.tmp';
          
          // 循环重试写入，避免并发冲突
          for (let i = 0; i < 5; i++) {
              try {
                  // 使用追加模式写入文件
                  await fs.appendFile(tempFilePath, tempData, { flag: 'a' });
                  log.debug(`Saved ${results.length} records to temp file`);
                  break;
              } catch (err) {
                  if (i === 4) {
                      log.error(`Failed to save results to temp file after 5 attempts: ${err.message}`);
                  } else {
                      // 等待一段时间后重试
                      await new Promise(r => setTimeout(r, 100 * (i + 1)));
                  }
              }
          }
      }

      // ====== 纯API模式获取Token ======
      const randomPick = arr => arr[Math.floor(Math.random() * arr.length)];
      const USER_AGENTS = [
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.138 Safari/537.36',
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.138 Safari/537.36',
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.138 Safari/537.36',
      ];
      
      async function getToken(privateKey, retries = 0) {
          // 使用环境变量中的最大重试次数
          const maxRetries = parseInt(process.env.MAX_RETRIES) || 3;

          if (retries >= maxRetries) {
              log.error(`[API] Max retries reached for getting token`);
              return null;
          }
          
          const YESCAPTCHA_CLIENT_KEY = process.env.YESCAPTCHA_CLIENT_KEY;
          const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY;
          
          if (!YESCAPTCHA_CLIENT_KEY || !TURNSTILE_SITEKEY) {
              log.warn(`Pure API mode requires YESCAPTCHA_CLIENT_KEY and TURNSTILE_SITEKEY`);
              return null;
          }
          
          const { ethers } = await import('ethers');
          const wallet = new ethers.Wallet(privateKey);
          const address = await wallet.getAddress();
          log.debug(`[API] Wallet address: ${address}`);
          
          try {
              // 第一步：使用 yesCaptcha 获取 Turnstile token
              log.info(`[API] Requesting Turnstile token... (attempt ${retries + 1}/${maxRetries})`);
              
              const createTaskResp = await fetch('https://api.yescaptcha.com/createTask', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      clientKey: YESCAPTCHA_CLIENT_KEY,
                      task: {
                          type: 'TurnstileTaskProxylessM1',
                          websiteURL: TARGET_URL,
                          websiteKey: TURNSTILE_SITEKEY,
                      }
                  })
              });
              
              const createTaskData = await createTaskResp.json();
              
              if (createTaskData.errorId !== 0 || !createTaskData.taskId) {
                  log.error(`[API] Failed to create task: ${createTaskData.errorDescription}`);

                  // 不再对errorId === 1立即放弃重试，而是遵循最大重试次数配置
                  // 只有在达到最大重试次数时才放弃
                  if (retries < maxRetries) {
                      log.warn(`[API] Retrying to create task... (attempt ${retries + 2}/${maxRetries})`);
                      await new Promise(r => setTimeout(r, 2000));
                      return getToken(privateKey, retries + 1);
                  } else {
                      log.error(`[API] Max retries reached for creating task`);
                      return null;
                  }
              }
              
              const taskId = createTaskData.taskId;
              log.debug(`[API] Task created: ${taskId}`);
              
              // 轮询等待结果
              let turnstileToken = null;
              for (let i = 0; i < 60; i++) {
                  await new Promise(r => setTimeout(r, 3000));
                  
                  const getResultResp = await fetch('https://api.yescaptcha.com/getTaskResult', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          clientKey: YESCAPTCHA_CLIENT_KEY,
                          taskId: taskId
                      })
                  });
                  
                  const resultData = await getResultResp.json();
                  
                  if (resultData.status === 'ready' && resultData.solution) {
                      turnstileToken = resultData.solution.token;
                      log.info(`[API] Got Turnstile token (length: ${turnstileToken.length})`);
                      break;
                  } else if (resultData.status === 'processing') {
                      if (i % 5 === 0) {
                          log.debug(`[API] yesCaptcha processing... (${i * 3}s)`);
                      }
                  } else {
                      log.error(`[API] yesCaptcha error: ${JSON.stringify(resultData)}`);

                      // 不再对errorId === 1立即放弃重试，而是遵循最大重试次数配置
                      // 只有在达到最大重试次数时才放弃
                      if (retries < maxRetries) {
                          log.warn(`[API] Retrying to get captcha result... (attempt ${retries + 2}/${maxRetries})`);
                          await new Promise(r => setTimeout(r, 2000));
                          return getToken(privateKey, retries + 1);
                      } else {
                          log.error(`[API] Max retries reached for getting captcha result`);
                          return null;
                      }
                  }
              }
              
              if (!turnstileToken) {
                  log.error(`[API] Failed to get Turnstile token`);
                  // 增加重试机制
                  if (retries < maxRetries) {
                      log.warn(`[API] Retrying to get token... (attempt ${retries + 2}/${maxRetries})`);
                      await new Promise(r => setTimeout(r, 2000));
                      return getToken(privateKey, retries + 1);
                  } else {
                      log.error(`[API] Max retries reached for getting Turnstile token`);
                      return null;
                  }
              }
              
              // 第二步：调用 Privy init API 获取 nonce
              const privyCaId = randomUUID();
              const userAgent = randomPick(USER_AGENTS);
              
              const domain = 'claim.tadle.com';
              const origin = 'https://claim.tadle.com';
              const statement = 'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.';
              
              const commonHeaders = {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'privy-app-id': PRIVY_APP_ID,
                  'privy-ca-id': privyCaId,
                  'privy-client': PRIVY_CLIENT,
                  'Origin': origin,
                  'Referer': origin + '/',
                  'User-Agent': userAgent,
              };
              
              log.debug(`[API] Calling SIWE init...`);
              const initResp = await proxyFetch(PRIVY_INIT_URL, {
                  method: 'POST',
                  headers: commonHeaders,
                  body: JSON.stringify({ 
                      address,
                      token: turnstileToken
                  })
              });
              
              const initData = await initResp.json();
              log.debug(`[API] Init response status: ${initResp.status}`);
              
              if (!initData.nonce) {
                  log.error(`[API] Failed to get nonce: ${JSON.stringify(initData)}`);
                  // 增加重试机制
                  if (retries < maxRetries) {
                      log.warn(`[API] Retrying to get nonce... (attempt ${retries + 2}/${maxRetries})`);
                      await new Promise(r => setTimeout(r, 2000));
                      return getToken(privateKey, retries + 1);
                  } else {
                      log.error(`[API] Max retries reached for getting nonce`);
                      return null;
                  }
              }
              
              const nonce = initData.nonce;
              const issuedAt = new Date().toISOString();
              log.debug(`[API] Got nonce: ${nonce.substring(0, 16)}...`);
              
              // 第三步：签名 SIWE 消息
              const message = `${domain} wants you to sign in with your Ethereum account:
${address}

${statement}

URI: ${origin}
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${issuedAt}
Resources:
- https://privy.io`;
              
              const signature = await wallet.signMessage(message);
              log.debug(`[API] SIWE message signed`);
              
              // 第四步：调用 Privy authenticate API
              log.debug(`[API] Calling authenticate...`);
              const authResp = await proxyFetch(PRIVY_AUTH_URL, {
                  method: 'POST',
                  headers: commonHeaders,
                  body: JSON.stringify({
                      message,
                      signature,
                      chainId: 'eip155:1',
                      walletClientType: 'metamask',
                      connectorType: 'injected',
                      mode: 'login-or-sign-up'
                  })
              });
              
              const authData = await authResp.json();
              log.debug(`[API] Auth response status: ${authResp.status}`);
              
              if (authData.token) {
                  log.info(`[API] Got token successfully!`);
                  return authData.token;
              } else {
                  log.error(`[API] Auth failed: ${JSON.stringify(authData)}`);
                  // 增加重试机制
                  if (retries < maxRetries) {
                      log.warn(`[API] Retrying authentication... (attempt ${retries + 2}/${maxRetries})`);
                      await new Promise(r => setTimeout(r, 2000));
                      return getToken(privateKey, retries + 1);
                  } else {
                      log.error(`[API] Max retries reached for authentication`);
                      return null;
                  }
              }
              
          } catch (err) {
              log.error(`[API] Error: ${err.message}`);
              // 增加重试机制
              if (retries < maxRetries) {
                  log.warn(`[API] Retrying after error... (attempt ${retries + 2}/${maxRetries})`);
                  await new Promise(r => setTimeout(r, 2000));
                  return getToken(privateKey, retries + 1);
              } else {
                  log.error(`[API] Max retries reached after error`);
                  return null;
              }
          }
      }

      // 并发配置
      const batchConcurrency = parseInt(process.env.BATCH_CONCURRENCY) || 1;
      log.info(`Batch concurrency: ${batchConcurrency}, Total wallets: ${wallets.length}`);

      // 处理单个钱包的完整流程
      async function processOneWallet(pk) {
          // 获取钱包地址
          const wallet = new ethers.Wallet(pk);
          const walletAddress = await wallet.getAddress();
          
          // 创建带钱包标识的日志对象
          const wlog = log.withWallet(walletAddress);
          
          try {
              wlog.info(`Processing wallet...`);
              
              // 获取token
              const token = await getToken(pk);
              
              if (token) {
                  // 执行业务流程: 获取airdrop -> claim -> 验证 -> 保存结果
                  wlog.debug(`Starting business process...`);
                  const businessResults = await processWalletBusiness(walletAddress, token, wlog);
                  
                  // 保存结果到临时文件
                  await saveResultsToCSV(businessResults);
                  wlog.info(`✅ Completed`);
                  return { success: true, wallet: walletAddress };
                  
              } else {
                  wlog.error(`Failed to get token`);
                  // 即使获取token失败也要记录到临时文件
                  const failResults = [{
                      wallet: walletAddress,
                      status: 'FAILED_TOKEN',
                      error: 'Failed to get authentication token',
                      timestamp: new Date().toISOString()
                  }];
                  await saveResultsToCSV(failResults);
                  return { success: false, wallet: walletAddress };
              }
          } catch (err) {
              wlog.error(`Error: ${err.message}`);
              // 发生异常时也记录到临时文件
              const errorResults = [{
                  wallet: walletAddress,
                  status: 'ERROR',
                  error: err.message,
                  timestamp: new Date().toISOString()
              }];
              await saveResultsToCSV(errorResults);
              return { success: false, wallet: walletAddress, error: err.message };
          }
      }

      // 并发处理钱包（按批次）
      if (batchConcurrency > 1) {
          // 纯API模式可以并发处理
          log.info(`Starting concurrent processing with batch size ${batchConcurrency}`);
          
          for (let i = 0; i < wallets.length; i += batchConcurrency) {
              const batch = wallets.slice(i, i + batchConcurrency);
              log.info(`Batch ${Math.floor(i / batchConcurrency) + 1}/${Math.ceil(wallets.length / batchConcurrency)} (${batch.length} wallets)`);
              
              // 并发处理这一批
              const results = await Promise.allSettled(batch.map(pk => processOneWallet(pk)));
              
              const succeeded = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
              const failed = results.length - succeeded;
              log.info(`Batch done: ${succeeded} ok, ${failed} failed`);
              
              // 批次之间短暂延迟
              await new Promise(r => setTimeout(r, 1000));
          }
      } else {
          // 浏览器模式或单并发，串行处理
          for (const pk of wallets) {
              await processOneWallet(pk);
              await new Promise(r => setTimeout(r, 2000));
          }
      }

      // 通知主进程进行文件整理工作
      if (process.send) {
          process.send({ type: 'workCompleted' });
      }

      process.exit(0);
  }
}

// 运行主函数
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});