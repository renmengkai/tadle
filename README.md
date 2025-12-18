# Tadle Airdrop Claim

自动化领取 Tadle 空投的工具。

## 功能

- 自动获取 Privy 认证 Token
- 批量领取空投 Boxes
- 支持多钱包并发处理
- 支持代理
- 详细日志记录

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并填写配置：

```bash
cp .env.example .env
```

### 必填配置

| 配置项 | 说明 |
|--------|------|
| `YESCAPTCHA_CLIENT_KEY` | yesCaptcha API Key，用于解决 Turnstile 验证码 |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile sitekey （tadle 无需修改）|

### 可选配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `USE_PROXY` | true | 是否使用代理 |
| `MAX_RETRIES` | 3 | 失败重试次数 |
| `LOG_LEVEL` | info | 日志级别 (error/warn/info/debug) |
| `CONCURRENCY` | 50 | Worker 进程数 |
| `BATCH_CONCURRENCY` | 2 | 每个 Worker 内部并发数 |

## 文件准备

### wallets.txt

每行一个私钥：

```
0x1234...
0x5678...
```

### proxies.txt

每行一个代理地址（支持认证）：

```
http://user:pass@ip:port
http://ip:port
```

## 运行

```bash
npm start
```

## 输出文件

程序运行后在 `outputs/` 目录生成：

- `result_YYYYMMDDHHMM.csv` - 领取结果
- `tadle_YYYYMMDDHHMM.log` - 运行日志

### CSV 字段说明

| 字段 | 说明 |
|------|------|
| wallet | 钱包地址 |
| status | 状态 (SUCCESS/NO_UNOPENED_BOXES/PARTIAL/FAILED) |
| allOpened | 是否全部已开启 |
| totalBoxes | Boxes 总数 |
| totalAmount | Amount 总和 |
| totalTtAmount | TT Amount 总和 |
| totalTfeAmount | TFE Amount 总和 |
| openedCount | 已开启数量 |
| error | 错误信息 |
| timestamp | 时间戳 |

## 日志格式

日志包含钱包后8位标识，方便定位：

```
[W0][917FDb91] Processing wallet...
[W0][917FDb91] Boxes: 5 total, 2 unopened, Amount: 2090000.00
[W0][917FDb91] ✅ Completed
```

## 注意事项

1. 需要配置有效的 yesCaptcha API Key
2. 建议使用代理避免 IP 限制
3. 并发数过高可能触发频率限制

## 打包成可执行文件

### 使用 Node.js 22+ 的 SEA (Single Executable Applications)

本项目现在支持使用 Node.js 22+ 的官方 SEA 功能来创建可执行文件。

#### 构建可执行文件

确保你正在使用 Node.js 22+ 版本：

```bash
node --version  # 应该显示 v22.x.x
```

执行构建命令：

```bash
npm run build
```

构建完成后会在 `dist/` 目录下生成可执行文件：
- `tadle` - Linux/macOS 可执行文件
- `tadle.exe` - Windows 可执行文件（在 Windows 系统上构建）

#### 使用打包后的程序

将以下文件放在 exe 同一目录下：

```
tadle 或 tadle.exe
.env                 # 配置文件
wallets.txt          # 钱包私钥
proxies.txt          # 代理列表
outputs/             # 输出目录（自动创建）
```

直接双击运行或命令行执行：

```bash
# Linux/macOS
./tadle

# Windows
tadle.exe
```

### GitHub Actions 自动构建

项目已配置 GitHub Actions，在推送带有 `v` 前缀的标签时会自动构建可执行文件并创建 Release。

### 注意事项

1. `.env` 文件必须与可执行文件放在同一目录
2. 程序会从当前工作目录读取配置文件
3. 打包需要 Node.js 22+ 环境
4. SEA 是 Node.js 官方支持的方式，比第三方工具更稳定可靠