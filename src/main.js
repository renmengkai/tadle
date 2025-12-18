// src/main.js
import cluster from 'cluster';
import os from 'os';
import fs from 'fs/promises';

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

if (cluster.isMaster) {
    // ====== 主进程 ======
    // 加载.env文件
    await loadEnvFile();
    
    const wallets = (await fs.readFile('wallets.txt', 'utf8')).trim().split(/\r?\n/).filter(x => x);
    let proxyLines = [];
    try {
        proxyLines = (await fs.readFile('proxies.txt', 'utf8')).trim().split(/\r?\n/).filter(x => x);
    } catch (err) {
        console.log('No proxies.txt file found or empty, running without proxies');
    }

    // 添加环境变量控制是否使用代理
    const useProxy = process.env.USE_PROXY !== 'false';

    // 解析代理行：http://user:pass@ip:port -> { server, username, password }
    let proxies = [];
    if (useProxy) {
        proxies = proxyLines.map(line => {
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
    
    // 初始化结果CSV文件（写入表头）
    const csvHeaders = 'wallet,status,allOpened,totalBoxes,totalAmount,totalTtAmount,totalTfeAmount,openedCount,timestamp\n';
    await fs.writeFile(resultFilePath, csvHeaders);
    
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
            HEADLESS_MODE: process.env.HEADLESS_MODE || 'true',
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
    for (const id in cluster.workers) {
        cluster.workers[id].on('exit', async () => {
            exited++;
            if (exited === Object.keys(cluster.workers).length) {
                console.log('✅ All done.');
            }
        });
    }
} else {
    // ====== 子进程 ======
    const wallets = JSON.parse(process.env.WALLET_BATCH);
    const proxies = JSON.parse(process.env.PROXIES);
    const workerId = process.env.WORKER_ID;
    const useProxy = process.env.USE_PROXY !== 'false';
    const headlessMode = process.env.HEADLESS_MODE !== 'false'; // 默认无头模式
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

    const { chromium } = await import('playwright');
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
            
            // 汇总统计信息
            const totalBoxes = allBoxes.length;
            const totalAmount = allBoxes.reduce((sum, box) => sum + parseFloat(box.amount || 0), 0);
            const totalTtAmount = allBoxes.reduce((sum, box) => sum + parseFloat(box.tt_amount || 0), 0);
            const totalTfeAmount = allBoxes.reduce((sum, box) => sum + parseFloat(box.tfe_amount || 0), 0);
            
            wlog.info(`Boxes: ${totalBoxes} total, ${unopenedBoxes.length} unopened, Amount: ${totalAmount.toFixed(2)}`);
            
            // 检查是否所有boxes都已打开
            const allOpened = allBoxes.length > 0 && unopenedBoxes.length === 0;
            
            return { 
                boxes: unopenedBoxes, 
                allBoxes,
                allOpened,
                // 汇总信息
                summary: {
                    totalBoxes,
                    totalAmount,
                    totalTtAmount,
                    totalTfeAmount,
                    openedCount: allBoxes.filter(b => b.is_opened === 1).length,
                    unopenedCount: unopenedBoxes.length
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
        
        // 获取汇总信息
        const summary = airdropInfo.summary || {
            totalBoxes: 0,
            totalAmount: 0,
            totalTtAmount: 0,
            totalTfeAmount: 0,
            openedCount: 0,
            unopenedCount: 0
        };
        
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
            timestamp: new Date().toISOString()
        });
        
        return results;
    }
    
    // 将结果保存到CSV文件
    const resultFilePath = process.env.RESULT_FILE_PATH;
    async function saveResultsToCSV(results) {
        if (results.length === 0 || !resultFilePath) return;
        
        // 构建CSV行
        const rows = results.map(r => {
            return [
                r.wallet || '',
                r.status || '',
                r.allOpened !== undefined ? r.allOpened : '',
                r.totalBoxes !== undefined ? r.totalBoxes : '',
                r.totalAmount !== undefined ? r.totalAmount : '',
                r.totalTtAmount !== undefined ? r.totalTtAmount : '',
                r.totalTfeAmount !== undefined ? r.totalTfeAmount : '',
                r.openedCount !== undefined ? r.openedCount : '',
                r.timestamp || ''
            ].join(',');
        }).join('\n');
        
        await fs.appendFile(resultFilePath, rows + '\n');
        log.debug(`Saved ${results.length} records to result file`);
    }

    // 轮询代理
    let proxyIndex = 0;
    const getNextProxy = () => {
        // 如果没有代理，则返回undefined，让playwright使用系统默认网络
        if (proxies.length === 0) {
            return undefined;
        }
        return proxies[proxyIndex++ % proxies.length];
    };

    // 指纹池
    const USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.138 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.138 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.138 Safari/537.36',
    ];
    const VIEWPORTS = [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }];
    const LANGUAGES = ['en-US,en;q=0.9', 'zh-CN,zh;q=0.9'];
    const TIMEZONES = ['America/New_York', 'Asia/Shanghai'];
    const randomPick = arr => arr[Math.floor(Math.random() * arr.length)];
    
    // 获取固定的用户代理（用于调试）
    const getFixedOrRandom = (arr, fixed = false) => fixed ? arr[0] : randomPick(arr);

    // ====== 纯 API 模式（不使用浏览器） ======
    async function getTokenPureAPI(privateKey, retries = 0) {
        if (retries >= maxRetries) return null;
        
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
            log.info(`[API] Requesting Turnstile token...`);
            
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
                return null;
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
                    break;
                }
            }
            
            if (!turnstileToken) {
                log.error(`[API] Failed to get Turnstile token`);
                return null;
            }
            
            // 第二步：调用 Privy init API 获取 nonce
            const privyCaId = crypto.randomUUID();
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
            const initResp = await fetch(PRIVY_INIT_URL, {
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
                return null;
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
            const authResp = await fetch(PRIVY_AUTH_URL, {
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
                return null;
            }
            
        } catch (err) {
            log.error(`[API] Error: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000));
            return getTokenPureAPI(privateKey, retries + 1);
        }
    }

    async function getToken(privateKey, retries = 0) {
        if (retries >= maxRetries) return null;

        const proxy = getNextProxy();
        log.debug(`Launching browser in ${headlessMode ? 'headless' : 'headed'} mode`);
        const launchOptions = {
            headless: headlessMode, // 使用环境变量控制
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        
        // 只有当代理存在时才设置代理
        if (proxy) {
            launchOptions.proxy = proxy;
        }
        
        const browser = await chromium.launch(launchOptions);

        // 检查是否在.env中设置了固定值
        const fixedValues = process.env.FIXED_BROWSER_VALUES === 'true';
            
        const context = await browser.newContext({
            viewport: getFixedOrRandom(VIEWPORTS, fixedValues),
            userAgent: getFixedOrRandom(USER_AGENTS, fixedValues),
            locale: getFixedOrRandom(LANGUAGES, fixedValues).split(',')[0],
            timezoneId: getFixedOrRandom(TIMEZONES, fixedValues),
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        const page = await context.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': randomPick(LANGUAGES) });

        try {
            log.debug(`Navigating to ${TARGET_URL} with proxy: ${(useProxy && proxy?.server) || 'no proxy'}`);
                    
            // 在有头模式下增加更多日志
            if (!headlessMode) {
                log.debug(`Browser window should now be visible`);
            }
                    
            log.debug(`Starting navigation to ${TARGET_URL}`);
                    
            // 使用domcontentloaded事件，这是最快的等待选项
            const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            log.debug(`DOM loaded with status: ${response?.status()}`);
                    
            // 检查页面是否真的加载了
            try {
                const title = await page.title();
                log.debug(`Page title: ${title}`);
                            
                const url = page.url();
                log.debug(`Current URL: ${url}`);
            } catch (checkErr) {
                log.debug(`Error checking page state: ${checkErr.message}`);
            }
                    
            // 检查是否有Cloudflare挑战
            try {
                // 检查页面中是否有Cloudflare的iframe
                const hasChallengeIframe = await page.$('iframe[src*="cloudflare"]') || await page.$('iframe[src*="challenge"]');
                        
                // 监听网络请求来检测Cloudflare挑战
                let hasChallengeRequest = false;
                const requestListener = (request) => {
                    if (request.url().includes('challenges.cloudflare.com')) {
                        hasChallengeRequest = true;
                        log.debug(`Detected Cloudflare challenge request: ${request.url()}`);
                    }
                };
                        
                // 添加请求监听器
                page.on('request', requestListener);
                        
                // 等待一段时间让请求被处理
                await page.waitForTimeout(1000);
                        
                // 移除监听器
                page.off('request', requestListener);
                        
                if (hasChallengeIframe || hasChallengeRequest) {
                    log.info(`Detected Cloudflare challenge, waiting for user to solve it`);
                            
                    // 获取当前页面的URL
                    const currentUrl = await page.url();
                    log.debug(`Current page URL: ${currentUrl}`);
                            
                    // 等待 Cloudflare 挑战被解决（轮询检测）
                    log.info(`Please solve the Cloudflare challenge manually in the browser window.`);
                    log.info(`Waiting for challenge to be solved...`);
                    
                    // 轮询等待挑战被解决（最多等待 5 分钟）
                    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
                    const startTime = Date.now();
                    let challengeSolved = false;
                    
                    while (Date.now() - startTime < maxWaitTime) {
                        await page.waitForTimeout(2000);
                        
                        // 检查挑战是否消失
                        const stillHasChallenge = await page.$('iframe[src*="cloudflare"]') || await page.$('iframe[src*="challenge"]');
                        
                        // 检查页面是否有登录按钮或其他正常页面元素
                        const hasNormalContent = await page.evaluate(() => {
                            // 检查是否有 connect wallet 按钮或其他表明页面正常加载的元素
                            return document.body.innerText.includes('Connect') || 
                                   document.body.innerText.includes('Wallet') ||
                                   document.body.innerText.includes('Claim') ||
                                   document.querySelector('button') !== null;
                        });
                        
                        if (!stillHasChallenge && hasNormalContent) {
                            log.info(`Cloudflare challenge solved! Continuing...`);
                            challengeSolved = true;
                            break;
                        }
                        
                        log.debug(`Still waiting for challenge... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
                    }
                    
                    if (!challengeSolved) {
                        log.warn(`Timeout waiting for Cloudflare challenge to be solved`);
                        await browser.close();
                        return getToken(privateKey, retries + 1);
                    }
                    
                    // 等待页面完全加载
                    await page.waitForTimeout(2000);
                }
            } catch (challengeErr) {
                log.debug(`Could not check for Cloudflare challenge: ${challengeErr.message}`);
            }
                    
            // 等待一小段时间确保关键元素加载
            await page.waitForTimeout(3000);
            log.debug(`Additional wait completed`);

            // 等待页面完全加载（包括 JS 执行完毕）
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
                log.debug(`Network idle reached`);
            } catch (e) {
                log.debug(`Network idle timeout, continuing anyway`);
            }

            // 调试：检查 Turnstile 环境
            const turnstileDebug = await page.evaluate(() => {
                const debug = {
                    hasTurnstile: !!window.turnstile,
                    turnstileType: typeof window.turnstile,
                    hasGetResponse: !!(window.turnstile && window.turnstile.getResponse),
                    webdriver: navigator.webdriver,
                    userAgent: navigator.userAgent,
                    // 检查 turnstile 对象的方法
                    turnstileMethods: window.turnstile ? Object.keys(window.turnstile) : [],
                    // 检查是否有 turnstile iframe
                    hasTurnstileIframe: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
                    // 检查是否有 turnstile widget 容器
                    turnstileWidgets: document.querySelectorAll('[data-turnstile-widget-id]').length,
                    // 检查所有 iframe
                    allIframes: Array.from(document.querySelectorAll('iframe')).map(f => f.src.substring(0, 100)),
                };
                return debug;
            });
            
            log.debug(`Turnstile debug: hasTurnstile=${turnstileDebug.hasTurnstile}, hasGetResponse=${turnstileDebug.hasGetResponse}`);
            log.debug(`allIframes: ${JSON.stringify(turnstileDebug.allIframes)}`);

            // 等待 Turnstile token
            log.debug(`Waiting for Turnstile token...`);
            let turnstileToken = null;
            
            // 优先使用环境变量中的 sitekey
            let siteKey = process.env.TURNSTILE_SITEKEY || null;
            
            // 如果没有配置，尝试从页面中查找
            if (!siteKey) {
                const siteKeyInfo = await page.evaluate(() => {
                    const info = { siteKey: null, sources: [] };
                    
                    // 方式1: 从元素属性获取
                    const existingWidget = document.querySelector('[data-sitekey]');
                    if (existingWidget) {
                        info.siteKey = existingWidget.getAttribute('data-sitekey');
                        info.sources.push('element attribute');
                    }
                    
                    // 方式2: 从 iframe src 中提取
                    if (!info.siteKey) {
                        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                        if (iframe) {
                            const src = iframe.src;
                            // URL 格式: .../0x4AAAAAAAM8ceq5KhP1uJBt/...
                            const match = src.match(/\/(0x[0-9a-zA-Z_-]+)\//i);
                            if (match) {
                                info.siteKey = match[1];
                                info.sources.push('iframe src');
                            }
                        }
                    }
                    
                    // 方式3: 从 script 内容中查找
                    if (!info.siteKey) {
                        const scripts = document.querySelectorAll('script');
                        for (const script of scripts) {
                            const content = script.textContent || '';
                            const patterns = [
                                /sitekey["']?\s*[:=]\s*["'](0x[0-9a-zA-Z_-]+)["']/i,
                                /data-sitekey["']?\s*[:=]\s*["'](0x[0-9a-zA-Z_-]+)["']/i,
                            ];
                            for (const pattern of patterns) {
                                const match = content.match(pattern);
                                if (match) {
                                    info.siteKey = match[1];
                                    info.sources.push('script content');
                                    break;
                                }
                            }
                            if (info.siteKey) break;
                        }
                    }
                    
                    return info;
                });
                
                siteKey = siteKeyInfo.siteKey;
                log.debug(`SiteKey from page: ${JSON.stringify(siteKeyInfo)}`);
            } else {
                log.debug(`Using sitekey from env: ${siteKey}`);
            }
            
            // 如果有 sitekey 和 yesCaptcha API Key，使用 yesCaptcha 解决验证码
            const YESCAPTCHA_CLIENT_KEY = process.env.YESCAPTCHA_CLIENT_KEY;
            
            if (siteKey && YESCAPTCHA_CLIENT_KEY) {
                log.info(`Using yesCaptcha to solve Turnstile...`);
                
                try {
                    // 创建任务
                    const createTaskResp = await fetch('https://api.yescaptcha.com/createTask', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            clientKey: YESCAPTCHA_CLIENT_KEY,
                            task: {
                                type: 'TurnstileTaskProxylessM1',
                                websiteURL: TARGET_URL,
                                websiteKey: siteKey,
                            }
                        })
                    });
                    
                    const createTaskData = await createTaskResp.json();
                    log.debug(`Create task response: ${JSON.stringify(createTaskData)}`);
                    
                    if (createTaskData.errorId === 0 && createTaskData.taskId) {
                        // 轮询等待结果
                        const taskId = createTaskData.taskId;
                        
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
                                log.info(`Got Turnstile token from yesCaptcha (length: ${turnstileToken.length})`);
                                break;
                            } else if (resultData.status === 'processing') {
                                if (i % 5 === 0) {
                                    log.debug(`yesCaptcha still processing... (${i * 3}s)`);
                                }
                            } else {
                                log.error(`yesCaptcha error: ${JSON.stringify(resultData)}`);
                                break;
                            }
                        }
                    } else {
                        log.error(`Failed to create yesCaptcha task: ${createTaskData.errorDescription}`);
                    }
                } catch (e) {
                    log.error(`yesCaptcha error: ${e.message}`);
                }
            } else if (!YESCAPTCHA_CLIENT_KEY) {
                log.warn(`YESCAPTCHA_CLIENT_KEY not set, trying manual approach...`);
                
                // 尝试手动渲染 widget
                if (siteKey) {
                    const renderResult = await page.evaluate((siteKey) => {
                        const result = { success: false, error: null, widgetId: null };
                        
                        try {
                            let container = document.getElementById('turnstile-container');
                            if (!container) {
                                container = document.createElement('div');
                                container.id = 'turnstile-container';
                                container.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:9999;';
                                document.body.appendChild(container);
                            }
                            
                            result.widgetId = window.turnstile.render(container, {
                                sitekey: siteKey,
                                callback: (token) => {
                                    window.__turnstileToken = token;
                                },
                            });
                            result.success = true;
                        } catch (e) {
                            result.error = e.message;
                        }
                        
                        return result;
                    }, siteKey);
                    
                    log.debug(`Manual render result: ${JSON.stringify(renderResult)}`);
                    
                    // 等待 token
                    for (let i = 0; i < 30; i++) {
                        await page.waitForTimeout(1000);
                        
                        const token = await page.evaluate(() => {
                            return window.__turnstileToken || window.turnstile?.getResponse() || null;
                        });
                        
                        if (token) {
                            turnstileToken = token;
                            log.info(`Got Turnstile token manually (length: ${token.length})`);
                            break;
                        }
                        
                        if (i % 10 === 0) {
                            log.debug(`Waiting for manual token... (${i}s)`);
                        }
                    }
                }
            }
            
            if (!turnstileToken) {
                log.error(`Failed to get Turnstile token`);
                
                // 最终调试信息
                const finalDebug = await page.evaluate(() => {
                    return {
                        hasTurnstile: !!window.turnstile,
                        turnstileKeys: window.turnstile ? Object.keys(window.turnstile) : [],
                        documentReady: document.readyState,
                    };
                });
                log.debug(`Final debug: ${JSON.stringify(finalDebug)}`);
                
                await browser.close();
                return null;
            }

            // 从浏览器上下文获取所有cookie
            const cookies = await context.cookies();
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            log.debug(`Extracted ${cookies.length} cookies`);
            
            // 打印 cookie 名称便于调试
            log.debug(`Cookie names: ${cookies.map(c => c.name).join(', ')}`);

            // 从页面中提取privy-ca-id
            let privyCaId = null;
            try {
                privyCaId = await page.evaluate(() => {
                    return localStorage.getItem('privy:ca_id') || null;
                });
            } catch (e) {
                log.debug(`Could not get privy-ca-id from localStorage`);
            }

            if (!privyCaId) {
                privyCaId = crypto.randomUUID();
                log.debug(`Generated new privy-ca-id: ${privyCaId}`);
            } else {
                log.debug(`Got privy-ca-id from localStorage: ${privyCaId}`);
            }

            // 在Node.js端使用ethers签名SIWE消息
            const wallet = new ethers.Wallet(privateKey);
            const address = await wallet.getAddress();
            log.debug(`Wallet address: ${address}`);

            const domain = 'claim.tadle.com';
            const origin = 'https://claim.tadle.com';
            const statement = 'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.';

            // 构建公共请求头
            const commonHeaders = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'privy-app-id': PRIVY_APP_ID,
                'privy-ca-id': privyCaId,
                'privy-client': PRIVY_CLIENT,
                'Origin': origin,
                'Referer': origin + '/',
                'Cookie': cookieHeader,
                'User-Agent': context._options.userAgent || randomPick(USER_AGENTS),
            };

            // 第一步：调用init接口获取服务器颁发的nonce，包含 Turnstile token
            log.debug(`Calling SIWE init to get nonce...`);
            const initResp = await fetch(PRIVY_INIT_URL, {
                method: 'POST',
                headers: commonHeaders,
                body: JSON.stringify({ 
                    address,
                    token: turnstileToken  // 添加 Turnstile token
                })
            });

            const initData = await initResp.json();
            log.debug(`Init response status: ${initResp.status}`);
            
            if (!initData.nonce) {
                log.error(`Failed to get nonce: ${JSON.stringify(initData)}`);
                await browser.close();
                return null;
            }

            const nonce = initData.nonce;
            const issuedAt = new Date().toISOString();
            log.debug(`Got nonce: ${nonce.substring(0, 16)}...`);

            // SIWE消息格式必须严格遵循标准
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
            log.debug(`SIWE message signed for address: ${address}`);

            // 第二步：使用提取的cookie直接调用Privy认证API
            const resp = await fetch(PRIVY_AUTH_URL, {
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

            const data = await resp.json();
            log.debug(`Auth API response status: ${resp.status}`);
            
            const token = data.token || null;
            if (token) {
                log.info(`Got token successfully!`);
            } else if (data.error) {
                log.error(`Auth error: ${JSON.stringify(data.error)}`);
            } else {
                log.error(`Unexpected response: ${JSON.stringify(data)}`);
            }

            await browser.close();
            return token;

        } catch (err) {
            log.error(`Error: ${err.message}`);
            log.debug(`Proxy used: ${proxy?.server || 'no proxy'}`);
            
            // 检查页面是否至少部分加载
            try {
                const url = page.url();
                log.debug(`Current page URL: ${url}`);
                
                const title = await page.title();
                log.debug(`Page title: ${title}`);
            } catch (pageErr) {
                log.debug(`Could not get page info: ${pageErr.message}`);
            }
            
            // 即使goto失败，也检查页面上是否有内容
            try {
                const content = await page.content();
                log.debug(`Page has content: ${content.length} chars`);
                
                // n看是否能找到一些关键元素
                const privyElements = await page.$$('.privy');
                log.debug(`Found ${privyElements.length} privy elements`);
            } catch (contentErr) {
                log.debug(`Could not get page content: ${contentErr.message}`);
            }
            
            // 在有头模式下，遇到错误时不关闭浏览器，方便查看页面状态
            if (!headlessMode) {
                log.info(`Keeping browser open for debugging. Press Ctrl+C to exit.`);
                // 等待用户中断
                await new Promise(() => {});
            }
            
            await browser.close();
            await new Promise(r => setTimeout(r, 2000));
            return getToken(privateKey, retries + 1);
        }
    }

    // 根据配置选择模式
    const usePureAPIMode = process.env.YESCAPTCHA_CLIENT_KEY && process.env.TURNSTILE_SITEKEY;
    const batchConcurrency = parseInt(process.env.BATCH_CONCURRENCY) || 1;
    
    if (usePureAPIMode) {
        log.info(`Using Pure API mode (no browser)`);
    } else {
        log.info(`Using Browser mode`);
    }
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
            
            // 根据配置选择使用哪种模式获取token
            const token = usePureAPIMode 
                ? await getTokenPureAPI(pk)
                : await getToken(pk);
            
            if (token) {
                // 执行业务流程: 获取airdrop -> claim -> 验证 -> 保存结果
                wlog.debug(`Starting business process...`);
                const businessResults = await processWalletBusiness(walletAddress, token, wlog);
                
                // 保存结果到CSV
                await saveResultsToCSV(businessResults);
                wlog.info(`✅ Completed`);
                return { success: true, wallet: walletAddress };
                
            } else {
                wlog.error(`Failed to get token`);
                return { success: false, wallet: walletAddress };
            }
        } catch (err) {
            wlog.error(`Error: ${err.message}`);
            return { success: false, wallet: walletAddress, error: err.message };
        }
    }

    // 并发处理钱包（按批次）
    if (batchConcurrency > 1 && usePureAPIMode) {
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

    process.exit(0);
}