# Tadle Airdrop Claimer

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22+-brightgreen" alt="Node.js Version">
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License">
</p>

<p align="center">
  自动化领取 Tadle 空投的工具 - https://claim.tadle.com/
  <br>
  批量查询并开启空投盲盒
</p>

## 🌟 功能特性

- 🔐 自动获取 Privy 认证 Token
- 🎁 批量领取空投盲盒 (Boxes)
- 🚀 多钱包并发处理，提高效率
- 🌐 全面支持代理，避免频率限制
- 📝 详细的日志记录和结果报告
- 💻 支持打包为独立可执行文件

## 📋 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [配置说明](#配置说明)
- [文件准备](#文件准备)
- [运行程序](#运行程序)
- [输出文件](#输出文件)
- [日志说明](#日志说明)
- [注意事项](#注意事项)
- [打包为可执行文件](#打包为可执行文件)

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 复制并编辑配置文件
cp .env.example .env
# 编辑 .env 文件，填写 yesCaptcha API Key 等配置

# 准备钱包和代理文件
# 编辑 wallets.txt 和 proxies.txt

# 运行程序
npm start
```

## 🛠 安装

确保您的系统已安装 Node.js 22+ 版本：

```bash
node --version  # 应该显示 v22.x.x 或更高版本
```

安装项目依赖：

```bash
npm install
```

## ⚙️ 配置说明

### 复制配置文件

```bash
cp .env.example .env
```

### 必填配置项

| 配置项 | 说明 |
|--------|------|
| `YESCAPTCHA_CLIENT_KEY` | [yesCaptcha](https://yescaptcha.com) API Key，用于解决 Turnstile 验证码 |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile sitekey（Tadle 默认值，无需修改）|

### 可选配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `USE_PROXY` | true | 是否使用代理 |
| `MAX_RETRIES` | 3 | 失败重试次数 |
| `LOG_LEVEL` | info | 日志级别 (error/warn/info/debug) |
| `CONCURRENCY` | 50 | Worker 进程数 |
| `BATCH_CONCURRENCY` | 2 | 每个 Worker 内部并发数 |

## 📁 文件准备

### wallets.txt - 钱包私钥文件

每行放置一个钱包私钥：

```txt
0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

### proxies.txt - 代理配置文件

每行放置一个代理地址（支持多种格式）：

```txt
# 带用户名密码认证的代理
http://username:password@proxy-ip:port

# 不需要认证的代理
http://proxy-ip:port

# SOCKS5 代理
socks5://username:password@proxy-ip:port
```

## ▶️ 运行程序

开发模式运行：

```bash
npm start
```

或者直接使用 Node.js 运行：

```bash
node src/main.js
```

## 📊 输出文件

程序运行后将在 `outputs/` 目录生成以下文件：

- `result_YYYYMMDDHHMM.csv` - 领取结果统计
- `tadle_YYYYMMDDHHMM.log` - 详细运行日志

### CSV 结果字段说明

| 字段 | 说明 |
|------|------|
| `wallet` | 钱包地址 |
| `status` | 状态 (SUCCESS/NO_UNOPENED_BOXES/PARTIAL/FAILED/NOT_ELIGIBLE/TOKEN_FAILED/ERROR) |
| `allOpened` | 是否全部盲盒已开启 |
| `totalBoxes` | 盲盒总数 |
| `totalAmount` | Amount 总和 |
| `totalTtAmount` | TT Amount 总和 |
| `totalTfeAmount` | TFE Amount 总和 |
| `openedCount` | 已开启盲盒数量 |
| `error` | 错误信息 |
| `timestamp` | 时间戳 |

## 📋 日志说明

日志包含进程和钱包标识，方便定位问题：

```log
[W0][917FDb91] Processing wallet...
[W0][917FDb91] Boxes: 5 total, 2 unopened, Amount: 2090000.00
[W0][917FDb91] ✅ Completed
```

日志级别可通过 `.env` 中的 `LOG_LEVEL` 配置：
- `error`: 仅输出错误信息
- `warn`: 错误 + 警告信息
- `info`: 错误 + 警告 + 关键信息（默认）
- `debug`: 所有详细调试信息

## ⚠️ 注意事项

1. **必须配置有效的 yesCaptcha API Key** 才能正常使用
2. **强烈建议使用高质量代理** 避免触发频率限制
3. **合理设置并发参数**，过高可能导致 API 限制
4. **保护好私钥文件**，不要泄露给他人
5. 程序会自动跳过不符合空投条件的钱包

## 📦 打包为可执行文件

### 使用 Node.js 22+ 的 SEA (Single Executable Applications)

本项目支持使用 Node.js 22+ 的官方 SEA 功能创建可执行文件。

#### 构建可执行文件

确保使用 Node.js 22+ 版本：

```bash
node --version  # 应该显示 v22.x.x 或更高版本
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
tadle 或 tadle.exe     # 可执行文件
.env                   # 配置文件
wallets.txt            # 钱包私钥文件
proxies.txt            # 代理列表文件
outputs/               # 输出目录（自动创建）
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

## 📄 许可证

本项目采用 MIT 许可证，详情请参见 [LICENSE](LICENSE) 文件。