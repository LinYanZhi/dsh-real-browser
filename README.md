# dsh-real-browser

DSH 插件：让 DSH 的 AI 通过 **CDP 驱动用户真正在用的浏览器**（真实 Chrome/Edge 环境、RPA 店铺 profile）——**不是**插件自带的 Electron 沙盒浏览器。用于开发阶段辅助调试：环境检测、拉起/附加/接管、看页面、执行 JS、导航、清理。

零 npm 运行时依赖（CDP 走 Node 22 内置 WebSocket/fetch，注册表/版本走 PowerShell），规避 profile 安装 pnpm allowBuilds / 半途烂尾的坑。

---

## 能力模型（内置平台知识，AI 无需试错）

> 这是本插件的核心设计：把 Chrome/Edge 的平台限制直接编码进工具描述与检测输出。

| 平台事实 | 对插件的影响 | 已内置 |
|---|---|---|
| **默认数据目录**（`...\Edge\User Data` / `...\Chrome\User Data`）**拒绝远程调试** | `real_browser_env` 将其标记为「不可 CDP」；`real_browser_launch` 对默认目录**快速报错**（不傻等超时） | ✅ |
| **非默认目录**（如 `...\Edge\User Data Rpa`）**可以**开调试端口 | `real_browser_env.cdp_environments` 列出所有可驱动环境及其 profile | ✅ |
| 附加已运行的浏览器要求它启动时带 `--remote-debugging-port` | `real_browser_list` 标注可附加性；`launch` 对无端口占用做接管 | ✅ |
| 同一 user-data-dir 只能有一个实例（含 Edge 后台 `--no-startup-window` 占位进程） | `force: true` 杀锁重开（含后台占位） | ✅ |
| 只用**已有**配置，不新建 | `launch` 对不存在的目录快速报错 | ✅ |

## 工具

| 工具 | 作用 |
|---|---|
| `real_browser_env` | **入口**：已装浏览器（Edge/Chrome）+ 全部用户环境的 CDP 能力标注（默认目录=不可 CDP；`cdp_environments`=可驱动的非默认目录及其 profile/头像/下载目录） |
| `real_browser_list` | 正在运行的真实浏览器实例（CDP 端口 / user-data-dir / profile / 是否可附加 / 是否后台占位） |
| `real_browser_launch` | 启动 / 附加 / 接管：已在运行且带端口→附加；未运行→拉起带调试端口（45s 等待）；占用且无端口→默认报错，`force:true` 杀锁重开。**未授权配置**：默认报错并指引下一步，`autoGrant:true` 则弹审批、批准后自动加入允许列表并继续启动 |
| `real_browser_allow` | **授权开关（AI 侧）**：把某浏览器配置加入/移出允许列表。授权走 DSH 审批（Web GUI 弹卡片，用户批准才写入）；撤销无需审批 |
| `real_browser_close` | 关闭指定 CDP 端口的所有浏览器进程（AI 自己拉起的自己清理） |
| `real_page_list` | 列出已附加浏览器的打开页面 |
| `real_page_dom` | 查看页面 DOM（整页或 CSS 选择器，上限 100k 字符） |
| `real_page_eval` | 在页面主世界执行 JS（读状态 / 点元素 / 填输入），返回序列化值或异常 |
| `real_page_navigate` | 在驱动浏览器里导航到指定 URL |
| `real_page_snapshot` | **交互元素快照**：可点/可填元素编号 `e1..eN`（含角色/名称/值/中心坐标/CSS 选择器），交互前必用 |
| `real_page_click` | 按 ref / 选择器 / x,y 坐标点击（真实 CDP 鼠标事件，支持双击） |
| `real_page_fill` | 填输入/文本域/contenteditable（原生 setter + input/change，React/Vue 安全），可清空或追加 |
| `real_page_type` | 聚焦元素后 CDP 键入文本（触发 keydown 的输入框用） |
| `real_page_press_key` | 按键或组合键（Enter/Tab/Escape/方向键/Control+a…） |
| `real_page_select` | `<select>` 选选项（按 value 或可见文本） |
| `real_page_check` | 勾选/取消复选框、单选钮 |
| `real_page_hover` | 鼠标悬停（触发悬停菜单/提示） |
| `real_page_scroll` | 元素滚入视野，或按方向+像素滚动窗口 |
| `real_page_wait` | 等待元素可见/文本/URL/JS 条件/固定延时；超时返回 satisfied=false 不抛错 |
| `real_page_find` | 按选择器列出匹配元素（标签/id/文本/href/值/可见性） |
| `real_page_tabs` | 标签页管理：list / new / switch / close |
| `real_page_network` | 页面网络请求（Performance Resource Timing），可按 URL/类型/状态过滤 |
| `real_page_upload` | 真实文件上传（CDP DOM.setFileInputFiles） |
| `real_page_console` | 读取页面 console 日志（注入 hook，可清空） |

> 交互层参照 `agent-browser/eve` 与 Cebian 的工具模型：**快照出 `@eN` 元素引用 → 按引用/选择器/坐标操作**，等待语义与 tabs/network 对齐业界标准。

## 架构

```
dsh-real-browser/
├── index.js          # 根入口（re-export + cordis 插件入口）
├── cordis.patch.yml  # 挂载清单（tools 子路径 + host 裸包名，见下方「挂载到 DSH web profile」）
├── allowlist.js      # AI 操作边界：~/.dsh/realbrowser-allowlist.json；isAllowed/assertAllowed/toggleAllowed
├── cdp.js            # 零依赖 CDP 客户端：list/eval/dom/navigate + 提交态验证选页
├── discover.js       # 运行实例发现（PowerShell 扫进程 → 端口/目录/profile/后台标记）
├── env.js            # 环境检测 + 能力模型（镜像 app-kit::browser_paths/profiles/avatar）
├── launch.js         # 启动/附加/接管/关闭（镜像 app-kit start_or_connect + 内置护栏）
├── snapshot.js       # 交互元素快照（ref 编号 + CSS 选择器生成 + 坐标/可见性）
├── interact.js       # 交互原语：click/fill/type/keys/select/check/hover/scroll/wait/find/tabs/network/upload/console
├── tools.js          # 24 个 AI 工具注册（defineTool + ctx.tools.register；launch 前 assertAllowed / autoGrant 审批）
├── host.js           # host 服务 realBrowser（typert RPC：detectEnv/listRunning/getAllowlist/setAllowed/launch/close）
├── typert.js         # typert RPC 清单（zod codec；服务方法按清单参数顺序位置调用）
├── client/           # web 客户端插件源码（React：「浏览器设置」栏目 + dev 徽标）
├── build-client.mjs  # esbuild 打包 client/index.js → client.js（__ModuleLoader__.load 格式）
├── client.js         # 打包产物（web 加载的就是它；主题走 --dsw-alias-* token）
├── smoke.mjs         # 端到端冒烟（headless 临时 profile，自清理）
└── tests/            # 注册/能力模型/护栏/host-RPC/交互 回归测试
```

环境检测对照 `app-kit/shared/core/src/browser/`：注册表 App Paths + 标准路径、FileVersion/注册表版本、`Local State` 的 `/profile/info_cache`、7 级头像回退、下载目录（Preferences → 系统下载）、建议目录（同层含 Local State 兄弟 + "Edge Rpa/Chrome RPA" 变体）。

## 用法流程（AI 侧）

1. `real_browser_env` → 看「可 CDP 驱动的环境」（如 `User Data Rpa` 的广州/香港子账号）
2. `real_browser_launch` → 指定该环境的 `userDataDir` + `profileId`，得到 CDP 端口
3. **未授权配置**（错误消息会指明）：调 `real_browser_allow` 申请授权（Web GUI 弹审批卡片，用户批准后自动写入允许列表），或 `real_browser_launch` 直接带 `autoGrant:true` 一步到位；批准后无需用户去设置页手动勾选
4. 看页面：`real_page_list` / `real_page_dom` / `real_page_eval`
5. **交互**：`real_page_snapshot` 拿 `eN` 引用 → `real_page_click` / `real_page_fill` / `real_page_select` / `real_page_check` / `real_page_press_key` / `real_page_type` / `real_page_wait`（调试表单、按钮、下拉）
6. 排障：`real_page_find` / `real_page_network` / `real_page_console` / `real_page_tabs` / `real_page_upload`
7. `real_browser_close` → 用完清理

## 挂载到 DSH web profile

1. 依赖：`~/.dsh/profiles/web/package.json` 的 `dependencies` 加
   `"dsh-real-browser": "file:C:\\Users\\LinYanZhi\\Code\\dsh-real-browser"`，profile 目录跑 `pnpm install`。
2. 补丁：`~/.dsh/profiles/web/cordis.patch.yml`（用户 patch 层）追加：
   ```yaml
   - insert:
       - id: real-browser-tools
         name: dsh-real-browser/tools
   ```
3. 重启 DSH web + 硬刷新（Ctrl+Shift+R）。

> 与 `dsh-mobile-remote` 同款挂载（file: 依赖 + 用户 patch insert）。开发期建议把 profile 里的副本换成 junction 指向源码（`pnpm` 在 Windows 对 file: 依赖是拷贝，改代码需重装或 junction）。

## 开发 / 测试

```powershell
node smoke.mjs                 # 端到端冒烟（headless，自清理）
node tests/test-registration.mjs  # 插件形状 + 工具注册（24 个）
node tests/test-env-tool.mjs     # real_browser_env 工具端到端
node tests/test-guards.mjs       # 内置护栏（默认目录/不存在目录 快速拒绝）
node tests/test-host-rpc.mjs     # host typert RPC 位置参数契约（setAllowed 持久化/launch 门控）
node tests/test-allow.mjs        # 允许列表审批门控（real_browser_allow / launch autoGrant）
node tests/test-interaction.mjs  # 交互层冒烟（snapshot/click/fill/type/keys/select/check/scroll/wait/find/tabs/network/console）
```

## 限制与安全

- **默认 profile 目录无法开调试端口**（Chrome/Edge 安全限制，见能力模型）；可驱动的必须是**非默认目录**（RPA 环境、自定义目录）。
- **无法附加**未带调试端口启动的浏览器；无端口实例会明确标注。
- **不自动杀进程**；`force: true` 才接管（含 Edge 后台占位），留给显式决策。
- **允许列表是 AI 操作边界**：未勾选的配置默认拒绝；AI 可用 `real_browser_allow` 或 `launch autoGrant:true` 发起审批申请，用户批准后自动加入（审批策略为 `never` 或审批服务未挂载时降级为手动勾选指引）。
- 真实 profile = 登录态 = 高权限；写回/下单类操作应挂 DSH 审批。
- 版本：0.4.0。
