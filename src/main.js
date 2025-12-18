// src/farm.js
import cluster from 'cluster';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';

if (cluster.isMaster) {
    // ====== 主进程 ======
    const wallets = (await fs.readFile('wallets.txt', 'utf8')).trim().split(/\r?\n/).filter(x => x);
    const proxyLines = (await fs.readFile('proxies.txt', 'utf8')).trim().split(/\r?\n/).filter(x => x);

    // 解析代理行：http://user:pass@ip:port -> { server, username, password }
    const proxies = proxyLines.map(line => {
        const url = new URL(line);
        return {
            server: `${url.protocol}//${url.hostname}:${url.port}`,
            username: url.username,
            password: url.password,
        };
    });

    console.log(`Loaded ${wallets.length} wallets, ${proxies.length} proxies`);

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
        });
    }

    let exited = 0;
    for (const id in cluster.workers) {
        cluster.workers[id].on('exit', () => {
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

    const { chromium } = await import('playwright');
    const { ethers } = await import('ethers');

    const PRIVY_AUTH_URL = 'https://auth.privy.io/api/v1/siwe/authenticate';
    const TARGET_URL = 'https://claim.tadle.com';

    // 轮询代理
    let proxyIndex = 0;
    const getNextProxy = () => {
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

    async function getToken(privateKey, retries = 0) {
        if (retries >= 3) return null;

        const proxy = getNextProxy();
        const browser = await chromium.launch({
            headless: true,
            proxy, // ✅ 直接传入 { server, username, password }
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        const context = await browser.newContext({
            viewport: randomPick(VIEWPORTS),
            userAgent: randomPick(USER_AGENTS),
            locale: randomPick(LANGUAGES).split(',')[0],
            timezoneId: randomPick(TIMEZONES),
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        const page = await context.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': randomPick(LANGUAGES) });

        try {
            await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });

            const token = await page.evaluate(async (authUrl, pk) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.ethers.io/lib/ethers-5.7.umd.min.js';
                document.head.appendChild(script);
                await new Promise(r => script.onload = r);

                const { ethers } = window;
                const wallet = new ethers.Wallet(pk);
                const address = await wallet.getAddress();

                const domain = 'claim.tadle.com';
                const origin = 'https://claim.tadle.com';
                const statement = 'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.';
                const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
                const issuedAt = new Date().toISOString();

                const message = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${origin}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}\nResources:\n- https://privy.io`;
                const signature = await wallet.signMessage(message);

                const resp = await fetch(authUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'privy-app-id': 'cmi5tijs501zok10cgqzneakt',
                        'privy-ca-id': '9b15c99e-01f6-4388-a953-9135e379ecda',
                        'privy-client': 'react-auth:3.8.1',
                        'Origin': origin,
                        'Referer': origin + '/',
                    },
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
                return data.token || null;
            }, PRIVY_AUTH_URL, privateKey);

            await browser.close();
            return token;

        } catch (err) {
            console.error(`[W${workerId}] Error:`, err.message);
            await browser.close();
            await new Promise(r => setTimeout(r, 2000));
            return getToken(privateKey, retries + 1);
        }
    }

    for (const pk of wallets) {
        console.log(`[W${workerId}] Processing wallet ${pk.substring(0, 8)}...`);
        const token = await getToken(pk);
        if (token) {
            await fs.appendFile('outputs/tokens.json', JSON.stringify(token) + ',\n');
        } else {
            await fs.appendFile('outputs/failed.txt', pk + '\n');
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    process.exit(0);
}