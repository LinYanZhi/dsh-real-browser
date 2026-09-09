# dsh-real-browser — 项目指令

## 这是什么

**DSH 插件**：让 DSH 的 AI 通过 CDP 驱动用户**真正在用的浏览器**（真实 Chrome/Edge 环境、RPA profile），不是插件自带的 Electron 沙盒浏览器。**零 npm 运行时依赖**（CDP 走 Node 22 内置 WebSocket/fetch，注册表/版本走 PowerShell）。

- 仓库：`github.com/LinYanZhi/dsh-real-browser`（main，主账号自研）
- 状态：**开发已移交家里**（2026-09-07 公司侧完成 v0.5.0 并 push）；本副本保留，公司机不再迭代
- 安装方式：DSH 插件装 `~/.dsh/profiles/`（file: 本地引用），源码在 `C:\Users\Administrator\Code\dsh-real-browser`

## 结构

```
顶层 *.js         各工具实现（cdp / launch / snapshot / captcha / stealth / policy / vault / workmode …）
client/           客户端界面
scripts/          构建/发布脚本（build-client.mjs）
tests/ + smoke.mjs  测试与冒烟
cordis.patch.yml  插件挂载配置
allowlist.js      授权白名单（tools/host 运行时 import，勿从 files 白名单漏掉）
```

## 能力模型（平台事实已内置，AI 无需试错）

- 默认浏览器数据目录（`...\Edge\User Data`）**拒绝远程调试**，只有非默认目录（如 `...\User Data Rpa`）可 CDP。
- 附加已运行浏览器要求其带 `--remote-debugging-port`；同一 user-data-dir 只能一个实例。
- 只驱动**已有**配置，不新建；未授权配置走审批（autoGrant）。

## 纪律

- 凭证走 vault（DPAPI 加密落盘）或 work_mode 隔离，**key/密文绝不进工具参数 / 模型上下文 / 日志**。
- AI 拉起的浏览器进程自己负责关闭（`real_browser_close`）。
- 改动后跑 `smoke.mjs` / tests 验证；改插件清单后重装到 profile 并跑 sync-dsh-config 对账。
