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

    await fs.writeFile('outputs/tokens.json', '[\n');
    await fs.writeFile('outputs/failed.txt', '');

    const numWorkers = Math.min(4, os.cpus().length);
    const batchSize = Math.ceil(wallets.length / numWorkers);

    for (let i = 0; i < numWorkers; i++) {
        const batch = wallets.slice(i * batchSize, (i + 1) * batchSize);
        if (batch.length === 0) continue;
        cluster.fork({
            WALLET_BATCH: JSON.stringify(batch),
            PROXIES: JSON.stringify(proxies),
            WORKER_ID: String(i),
            USE_PROXY: process.env.USE_PROXY || 'true',
            HEADLESS_MODE: process.env.HEADLESS_MODE || 'true',
            MAX_RETRIES: process.env.MAX_RETRIES || '3',
        });
    }

    let exited = 0;
    for (const id in cluster.workers) {
        cluster.workers[id].on('exit', async () => {
            exited++;
            if (exited === Object.keys(cluster.workers).length) {
                // 补全 JSON
                const content = await fs.readFile('outputs/tokens.json', 'utf8');
                if (content.trim().endsWith('[\n')) {
                    await fs.writeFile('outputs/tokens.json', '[\n]');
                } else {
                    await fs.appendFile('outputs/tokens.json', '\n]');
                }
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

    const { chromium } = await import('playwright');
    const { ethers } = await import('ethers');

    const PRIVY_INIT_URL = 'https://auth.privy.io/api/v1/siwe/init';
    const PRIVY_AUTH_URL = 'https://auth.privy.io/api/v1/siwe/authenticate';
    const TARGET_URL = 'https://claim.tadle.com';
    const PRIVY_APP_ID = 'cmi5tijs501zok10cgqzneakt';
    const PRIVY_CLIENT = 'react-auth:3.8.1';

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
            console.log(`[W${workerId}] Pure API mode requires YESCAPTCHA_CLIENT_KEY and TURNSTILE_SITEKEY`);
            return null;
        }
        
        const { ethers } = await import('ethers');
        const wallet = new ethers.Wallet(privateKey);
        const address = await wallet.getAddress();
        console.log(`[W${workerId}] [API] Wallet address: ${address}`);
        
        try {
            // 第一步：使用 yesCaptcha 获取 Turnstile token
            console.log(`[W${workerId}] [API] Requesting Turnstile token from yesCaptcha...`);
            
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
                console.log(`[W${workerId}] [API] Failed to create task: ${createTaskData.errorDescription}`);
                return null;
            }
            
            const taskId = createTaskData.taskId;
            console.log(`[W${workerId}] [API] Task created: ${taskId}`);
            
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
                    console.log(`[W${workerId}] [API] Got Turnstile token (length: ${turnstileToken.length})`);
                    break;
                } else if (resultData.status === 'processing') {
                    if (i % 5 === 0) {
                        console.log(`[W${workerId}] [API] yesCaptcha processing... (${i * 3}s)`);
                    }
                } else {
                    console.log(`[W${workerId}] [API] yesCaptcha error: ${JSON.stringify(resultData)}`);
                    break;
                }
            }
            
            if (!turnstileToken) {
                console.log(`[W${workerId}] [API] Failed to get Turnstile token`);
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
            
            console.log(`[W${workerId}] [API] Calling SIWE init...`);
            const initResp = await fetch(PRIVY_INIT_URL, {
                method: 'POST',
                headers: commonHeaders,
                body: JSON.stringify({ 
                    address,
                    token: turnstileToken
                })
            });
            
            const initData = await initResp.json();
            console.log(`[W${workerId}] [API] Init response status: ${initResp.status}`);
            
            if (!initData.nonce) {
                console.log(`[W${workerId}] [API] Failed to get nonce: ${JSON.stringify(initData)}`);
                return null;
            }
            
            const nonce = initData.nonce;
            const issuedAt = new Date().toISOString();
            console.log(`[W${workerId}] [API] Got nonce: ${nonce.substring(0, 16)}...`);
            
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
            console.log(`[W${workerId}] [API] SIWE message signed`);
            
            // 第四步：调用 Privy authenticate API
            console.log(`[W${workerId}] [API] Calling authenticate...`);
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
            console.log(`[W${workerId}] [API] Auth response status: ${authResp.status}`);
            
            if (authData.token) {
                console.log(`[W${workerId}] [API] Got token successfully!`);
                return authData.token;
            } else {
                console.log(`[W${workerId}] [API] Auth failed: ${JSON.stringify(authData)}`);
                return null;
            }
            
        } catch (err) {
            console.error(`[W${workerId}] [API] Error:`, err.message);
            await new Promise(r => setTimeout(r, 2000));
            return getTokenPureAPI(privateKey, retries + 1);
        }
    }

    async function getToken(privateKey, retries = 0) {
        if (retries >= maxRetries) return null;

        const proxy = getNextProxy();
        console.log(`[W${workerId}] Launching browser in ${headlessMode ? 'headless' : 'headed'} mode`);
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
            console.log(`[W${workerId}] Navigating to ${TARGET_URL} with proxy:`, (useProxy && proxy?.server) || 'no proxy');
                    
            // 在有头模式下增加更多日志
            if (!headlessMode) {
                console.log(`[W${workerId}] Browser window should now be visible`);
            }
                    
            console.log(`[W${workerId}] Starting navigation to ${TARGET_URL}`);
                    
            // 使用domcontentloaded事件，这是最快的等待选项
            const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log(`[W${workerId}] DOM loaded with status: ${response?.status()}`);
                    
            // 检查页面是否真的加载了
            try {
                const title = await page.title();
                console.log(`[W${workerId}] Page title: ${title}`);
                        
                const url = page.url();
                console.log(`[W${workerId}] Current URL: ${url}`);
            } catch (checkErr) {
                console.log(`[W${workerId}] Error checking page state: ${checkErr.message}`);
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
                        console.log(`[W${workerId}] Detected Cloudflare challenge request: ${request.url()}`);
                    }
                };
                        
                // 添加请求监听器
                page.on('request', requestListener);
                        
                // 等待一段时间让请求被处理
                await page.waitForTimeout(1000);
                        
                // 移除监听器
                page.off('request', requestListener);
                        
                if (hasChallengeIframe || hasChallengeRequest) {
                    console.log(`[W${workerId}] Detected Cloudflare challenge, waiting for user to solve it`);
                            
                    // 获取当前页面的URL
                    const currentUrl = await page.url();
                    console.log(`[W${workerId}] Current page URL: ${currentUrl}`);
                            
                    // 等待 Cloudflare 挑战被解决（轮询检测）
                    console.log(`[W${workerId}] Please solve the Cloudflare challenge manually in the browser window.`);
                    console.log(`[W${workerId}] Waiting for challenge to be solved...`);
                    
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
                            console.log(`[W${workerId}] Cloudflare challenge solved! Continuing...`);
                            challengeSolved = true;
                            break;
                        }
                        
                        console.log(`[W${workerId}] Still waiting for challenge to be solved... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
                    }
                    
                    if (!challengeSolved) {
                        console.log(`[W${workerId}] Timeout waiting for Cloudflare challenge to be solved`);
                        await browser.close();
                        return getToken(privateKey, retries + 1);
                    }
                    
                    // 等待页面完全加载
                    await page.waitForTimeout(2000);
                }
            } catch (challengeErr) {
                console.log(`[W${workerId}] Could not check for Cloudflare challenge: ${challengeErr.message}`);
            }
                    
            // 等待一小段时间确保关键元素加载
            await page.waitForTimeout(3000);
            console.log(`[W${workerId}] Additional wait completed`);

            // 等待页面完全加载（包括 JS 执行完毕）
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
                console.log(`[W${workerId}] Network idle reached`);
            } catch (e) {
                console.log(`[W${workerId}] Network idle timeout, continuing anyway`);
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
            
            console.log(`[W${workerId}] Turnstile debug info:`);
            console.log(`[W${workerId}]   - hasTurnstile: ${turnstileDebug.hasTurnstile}`);
            console.log(`[W${workerId}]   - hasGetResponse: ${turnstileDebug.hasGetResponse}`);
            console.log(`[W${workerId}]   - webdriver: ${turnstileDebug.webdriver}`);
            console.log(`[W${workerId}]   - turnstileMethods: ${turnstileDebug.turnstileMethods.join(', ')}`);
            console.log(`[W${workerId}]   - hasTurnstileIframe: ${turnstileDebug.hasTurnstileIframe}`);
            console.log(`[W${workerId}]   - turnstileWidgets: ${turnstileDebug.turnstileWidgets}`);
            console.log(`[W${workerId}]   - allIframes: ${JSON.stringify(turnstileDebug.allIframes)}`);

            // 等待 Turnstile token
            console.log(`[W${workerId}] Waiting for Turnstile token...`);
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
                console.log(`[W${workerId}] SiteKey from page: ${JSON.stringify(siteKeyInfo)}`);
            } else {
                console.log(`[W${workerId}] Using sitekey from env: ${siteKey}`);
            }
            
            // 如果有 sitekey 和 yesCaptcha API Key，使用 yesCaptcha 解决验证码
            const YESCAPTCHA_CLIENT_KEY = process.env.YESCAPTCHA_CLIENT_KEY;
            
            if (siteKey && YESCAPTCHA_CLIENT_KEY) {
                console.log(`[W${workerId}] Using yesCaptcha to solve Turnstile...`);
                
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
                    console.log(`[W${workerId}] Create task response: ${JSON.stringify(createTaskData)}`);
                    
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
                                console.log(`[W${workerId}] Got Turnstile token from yesCaptcha (length: ${turnstileToken.length})`);
                                break;
                            } else if (resultData.status === 'processing') {
                                if (i % 5 === 0) {
                                    console.log(`[W${workerId}] yesCaptcha still processing... (${i * 3}s)`);
                                }
                            } else {
                                console.log(`[W${workerId}] yesCaptcha error: ${JSON.stringify(resultData)}`);
                                break;
                            }
                        }
                    } else {
                        console.log(`[W${workerId}] Failed to create yesCaptcha task: ${createTaskData.errorDescription}`);
                    }
                } catch (e) {
                    console.log(`[W${workerId}] yesCaptcha error: ${e.message}`);
                }
            } else if (!YESCAPTCHA_CLIENT_KEY) {
                console.log(`[W${workerId}] YESCAPTCHA_CLIENT_KEY not set, trying manual approach...`);
                
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
                    
                    console.log(`[W${workerId}] Manual render result: ${JSON.stringify(renderResult)}`);
                    
                    // 等待 token
                    for (let i = 0; i < 30; i++) {
                        await page.waitForTimeout(1000);
                        
                        const token = await page.evaluate(() => {
                            return window.__turnstileToken || window.turnstile?.getResponse() || null;
                        });
                        
                        if (token) {
                            turnstileToken = token;
                            console.log(`[W${workerId}] Got Turnstile token manually (length: ${token.length})`);
                            break;
                        }
                        
                        if (i % 10 === 0) {
                            console.log(`[W${workerId}] Waiting for manual token... (${i}s)`);
                        }
                    }
                }
            }
            
            if (!turnstileToken) {
                console.log(`[W${workerId}] Failed to get Turnstile token`);
                
                // 最终调试信息
                const finalDebug = await page.evaluate(() => {
                    return {
                        hasTurnstile: !!window.turnstile,
                        turnstileKeys: window.turnstile ? Object.keys(window.turnstile) : [],
                        documentReady: document.readyState,
                    };
                });
                console.log(`[W${workerId}] Final debug: ${JSON.stringify(finalDebug)}`);
                
                await browser.close();
                return null;
            }

            // 从浏览器上下文获取所有cookie
            const cookies = await context.cookies();
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            console.log(`[W${workerId}] Extracted ${cookies.length} cookies`);
            
            // 打印 cookie 名称便于调试
            console.log(`[W${workerId}] Cookie names: ${cookies.map(c => c.name).join(', ')}`);

            // 从页面中提取privy-ca-id
            let privyCaId = null;
            try {
                privyCaId = await page.evaluate(() => {
                    return localStorage.getItem('privy:ca_id') || null;
                });
            } catch (e) {
                console.log(`[W${workerId}] Could not get privy-ca-id from localStorage`);
            }

            if (!privyCaId) {
                privyCaId = crypto.randomUUID();
                console.log(`[W${workerId}] Generated new privy-ca-id: ${privyCaId}`);
            } else {
                console.log(`[W${workerId}] Got privy-ca-id from localStorage: ${privyCaId}`);
            }

            // 在Node.js端使用ethers签名SIWE消息
            const wallet = new ethers.Wallet(privateKey);
            const address = await wallet.getAddress();
            console.log(`[W${workerId}] Wallet address: ${address}`);

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
            console.log(`[W${workerId}] Calling SIWE init to get nonce...`);
            const initResp = await fetch(PRIVY_INIT_URL, {
                method: 'POST',
                headers: commonHeaders,
                body: JSON.stringify({ 
                    address,
                    token: turnstileToken  // 添加 Turnstile token
                })
            });

            const initData = await initResp.json();
            console.log(`[W${workerId}] Init response status: ${initResp.status}`);
            
            if (!initData.nonce) {
                console.log(`[W${workerId}] Failed to get nonce: ${JSON.stringify(initData)}`);
                await browser.close();
                return null;
            }

            const nonce = initData.nonce;
            const issuedAt = new Date().toISOString();
            console.log(`[W${workerId}] Got nonce: ${nonce.substring(0, 16)}...`);

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
            console.log(`[W${workerId}] SIWE message signed for address: ${address}`);

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
            console.log(`[W${workerId}] Auth API response status: ${resp.status}`);
            
            const token = data.token || null;
            if (token) {
                console.log(`[W${workerId}] Got token successfully!`);
            } else if (data.error) {
                console.log(`[W${workerId}] Auth error: ${JSON.stringify(data.error)}`);
            } else {
                console.log(`[W${workerId}] Unexpected response: ${JSON.stringify(data)}`);
            }

            await browser.close();
            return token;

        } catch (err) {
            console.error(`[W${workerId}] Error:`, err.message);
            console.error(`[W${workerId}] Proxy used:`, proxy?.server || 'no proxy');
            
            // 检查页面是否至少部分加载
            try {
                const url = page.url();
                console.log(`[W${workerId}] Current page URL:`, url);
                
                const title = await page.title();
                console.log(`[W${workerId}] Page title:`, title);
            } catch (pageErr) {
                console.log(`[W${workerId}] Could not get page info:`, pageErr.message);
            }
            
            // 即使goto失败，也检查页面上是否有内容
            try {
                const content = await page.content();
                console.log(`[W${workerId}] Page has content: ${content.length} chars`);
                
                // n看是否能找到一些关键元素
                const privyElements = await page.$$('.privy');
                console.log(`[W${workerId}] Found ${privyElements.length} privy elements`);
            } catch (contentErr) {
                console.log(`[W${workerId}] Could not get page content:`, contentErr.message);
            }
            
            // 在有头模式下，遇到错误时不关闭浏览器，方便查看页面状态
            if (!headlessMode) {
                console.log(`[W${workerId}] Keeping browser open for debugging. Press Ctrl+C to exit.`);
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
    
    if (usePureAPIMode) {
        console.log(`[W${workerId}] Using Pure API mode (no browser)`);
    } else {
        console.log(`[W${workerId}] Using Browser mode`);
    }

    for (const pk of wallets) {
        console.log(`[W${workerId}] Processing wallet ${pk.substring(0, 8)}...`);
        
        // 根据配置选择使用哪种模式
        const token = usePureAPIMode 
            ? await getTokenPureAPI(pk)
            : await getToken(pk);
        
        if (token) {
            await fs.appendFile('outputs/tokens.json', JSON.stringify(token) + ',\n');
            console.log(`[W${workerId}] Token saved for wallet ${pk.substring(0, 8)}`);
        } else {
            console.log(`[W${workerId}] Failed to get token for wallet ${pk.substring(0, 8)}...`);
            await fs.appendFile('outputs/failed.txt', pk + '\n');
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    process.exit(0);
}