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
| `real_browser_launch` | 启动 / 附加 / 接管：已在运行且带端口→附加；未运行→拉起带调试端口（45s 等待）；占用且无端口→默认报错，`force:true` 杀锁重开。**未授权配置**：默认报错并指引下一步，`autoGrant:true` 则弹审批、批准后自动加入允许列表并继续启动。可选 `stealth:true` 追加反自动化检测参数 |
| `real_browser_allow` | **授权开关（AI 侧）**：把某浏览器配置加入/移出允许列表。授权走 DSH 审批（Web GUI 弹卡片，用户批准才写入）；撤销无需审批 |
| `real_browser_fingerprint` | **stealth 审计**：页面级自动化检测信号扫描（webdriver / cdc_* 驱动残留 / 插件面 / window.chrome 形状 / permissions / headless 启发式 / 本插件注入的全局），逐项 clean/flagged + 总 verdict；纯信息不改写页面 |
| `real_browser_policy` | **URL 策略守卫**：管理 `deny` / `requireApproval` 规则（glob-lite 通配）；deny 硬拦截（AI 不可自行绕过），requireApproval 操作弹审批；remove 需审批（松开 AI 自己的约束） |
| `real_browser_work_mode` | **凭证隔离开关**：ON 时 fill/type 对**所有**字段返回脱敏结果、snapshot 掩码所有输入值（登录/填密环节 agent 不可见） |
| `real_browser_vault` | **加密凭证库**：`~/.dsh/realbrowser-vault.json`，值经 Windows DPAPI 加密落盘（仅本机本用户可解，文件内永无明文）；set/get/list/delete |
| `real_browser_close` | 关闭指定 CDP 端口的所有浏览器进程（AI 自己拉起的自己清理） |
| `real_page_list` | 列出已附加浏览器的打开页面 |
| `real_page_dom` | 查看页面 DOM（整页或 CSS 选择器，上限 100k 字符） |
| `real_page_eval` | 在页面主世界执行 JS（读状态 / 点元素 / 填输入），返回序列化值或异常 |
| `real_page_navigate` | 在驱动浏览器里导航到指定 URL（受 URL 策略守卫） |
| `real_page_snapshot` | **交互元素快照**：可点/可填元素编号 `e1..eN`（含角色/名称/值/中心坐标/CSS 选择器/id），交互前必用。**同源 iframe 内的元素也会收录**并带 `frame` 字段（如 `"0"`、`"0/1"`），跨源 iframe 无法穿透、单独列在 `crossOriginFrames`。**密码框值在页面内即掩码**（`[redacted]`），敏感模式掩码所有输入值 |
| `real_page_click` | 按 ref / 选择器 / x,y 坐标点击（真实 CDP 鼠标事件，支持双击；ref 自动携带 iframe，也可显式传 `frame`） |
| `real_page_fill` | 填输入/文本域/contenteditable（原生 setter + input/change，React/Vue 安全），可清空或追加；**密码框/敏感模式返回脱敏结果** |
| `real_page_type` | 聚焦元素后 CDP 键入文本（触发 keydown 的输入框用）；密码框/敏感模式脱敏回显 |
| `real_page_type_secret` | **从 vault 键入凭证**：只传 vault key，密文在 host 侧解密后经 CDP 键入，**绝不进入工具参数/模型上下文/日志** |
| `real_page_press_key` | 按键或组合键（Enter/Tab/Escape/方向键/Control+a…） |
| `real_page_select` | `<select>` 选选项（按 value 或可见文本） |
| `real_page_check` | 勾选/取消复选框、单选钮 |
| `real_page_hover` | 鼠标悬停（触发悬停菜单/提示） |
| `real_page_scroll` | 元素滚入视野，或按方向+像素滚动窗口 |
| `real_page_wait` | 等待元素可见/文本/URL/JS 条件/固定延时；超时返回 satisfied=false 不抛错 |
| `real_page_find` | 按选择器列出匹配元素（标签/id/文本/href/值/可见性），可用 `frame` 限定 iframe |
| `real_page_tabs` | 标签页管理：list / new / switch / close |
| `real_page_network` | 页面网络请求：**首次调用激活 CDP Network 实时捕获**（带真实 HTTP method/status/type，支持 method 过滤），并返回 resource-timing 历史供即时使用；可按 URL/类型/method/状态过滤 |
| `real_page_upload` | 真实文件上传（CDP DOM.setFileInputFiles） |
| `real_page_downloads` | **下载跟踪**：监听/列出该浏览器触发过的下载（文件名/URL/字节进度/状态 completed），首次调用激活监听；下载落盘目录默认用户 Downloads（可用 `downloadDir` 指定） |
| `real_page_console` | 读取页面 console 日志（注入 hook **不可枚举**、可清空，不污染页面临时全局） |
| `real_page_captcha` | **验证码探测**：识别 reCAPTCHA v2/v3、hCaptcha、Cloudflare Turnstile、Geetest、网易易盾、阿里云 noCaptcha 及通用 iframe/图片验证码启发式，逐项置信度标注；检测到即提示 AI 停下交人工 |

> 交互层参照 `agent-browser/eve` 与 Cebian 的工具模型：**快照出 `@eN` 元素引用 → 按引用/选择器/坐标操作**，等待语义与 tabs/network 对齐业界标准。

## 架构

```
dsh-real-browser/
├── index.js          # 根入口（re-export + cordis 插件入口）
├── cordis.patch.yml  # 挂载清单（tools 子路径 + host 裸包名，见下方「挂载到 DSH web profile」）
├── allowlist.js      # AI 操作边界（第一层）：~/.dsh/realbrowser-allowlist.json；isAllowed/assertAllowed/toggleAllowed
├── policy.js         # URL 策略守卫（第二层）：~/.dsh/realbrowser-policy.json deny/requireApproval 规则
├── workmode.js       # 凭证隔离：work mode 开关 + DPAPI 加密 vault（~/.dsh/realbrowser-vault.json）
├── stealth.js        # stealth 审计（指纹电池）+ 残留清理（信息型，不改写页面）
├── captcha.js        # 验证码探测（reCAPTCHA/hCaptcha/Turnstile/Geetest/易盾/阿里云/通用）
├── cdp.js            # 零依赖 CDP 客户端：list/eval/dom/navigate + 提交态验证选页 + 不可达/端口占用清晰报错
├── discover.js       # 运行实例发现（PowerShell 扫进程 → 端口/目录/profile/后台标记）
├── env.js            # 环境检测 + 能力模型（镜像 app-kit::browser_paths/profiles）
├── env-avatars.js    # 头像管线（fallback 链读取 + 64px PNG 内容哈希缓存，零 npm 依赖）
├── launch.js         # 启动/附加/接管/关闭（镜像 app-kit start_or_connect + 内置护栏 + stealth 参数；port 0/undefined 均自动分配）
├── snapshot.js       # 交互元素快照（ref 编号 + CSS 选择器生成 + 坐标/可见性；同源 iframe 递归 + 跨源标记；密码值页面内掩码）
├── interact.js       # 交互原语：click/fill/type/typeSecret/keys/select/check/hover/scroll/wait/find（frame 解析层）
├── interact-aux.js   # 交互辅助：tabs 管理 / 实时网络捕获 / 文件上传 / console 捕获（frame 解析层）
├── downloads.js      # 下载跟踪（持久浏览器级会话监听 Browser 下载事件）
├── network.js        # 实时网络捕获（持久页面级会话监听 Network 域，带真实 method/status）
├── tools.js          # 工具注册入口（聚合三域模块，共 31 个 AI 工具）
├── tools-common.js   # 工具共享辅助（text render / 审批申请 / URL 策略守卫 / 当前页 URL）
├── tools-browser.js  # 浏览器生命周期域：list/launch/close/allow/env/fingerprint
├── tools-page.js     # 页面交互域：dom/eval/navigate/snapshot/click/fill/…/downloads
├── tools-guard.js    # 安全边界域：policy/work_mode/vault
├── host.js           # host 服务 realBrowser（typert RPC：detectEnv/listRunning/getAllowlist/setAllowed/launch/close/getConfig/setConfig/getLaunchCommand/createUserDataDir/createShortcut/closeProfile/killAll；detectEnv 5s 内存缓存）
├── typert.js         # typert RPC 清单（zod codec；服务方法按清单参数顺序位置调用）
├── config.js         # 全局浏览器配置（~/.dsh/realbrowser-config.json）：exe 路径 + 自定义用户数据目录，跨会话保留
├── ops.js            # 运维操作：getLaunchCommand/createUserDataDir/createShortcut/closeProfile/killAll（PowerShell 零依赖）
├── edge-avatars.js   # Edge 预设头像内置资源（index -> PNG base64，取自 GLBT app-kit；无 Chrome 的 Avatars 缓存目录时的头像回退）
├── scripts/          # PowerShell 辅助（avatar-resize.ps1：System.Drawing 批量缩放头像，PS5.1 内置，零 npm 依赖）
├── client/           # web 客户端插件源码（React：「浏览器设置」栏目 = 概览条 + 分段视图 当前浏览器配置/全局浏览器配置；dev 徽标）
├── client/view-model.js # 客户端视图数据层（buildGroups 转换 + localStorage env 缓存，纯函数）
├── build-client.mjs  # esbuild 打包 client/index.js → client.js（__ModuleLoader__.load 格式）
├── client.js         # 打包产物（web 加载的就是它；主题走 --dsw-alias-* token）
├── smoke.mjs         # 端到端冒烟（headless 临时 profile，自清理）
└── tests/            # 注册/能力模型/护栏/host-RPC/契约/config/交互/iframe/downloads/stealth/policy/vault/captcha/network 回归测试
```

环境检测对照 `app-kit/shared/core/src/browser/`：注册表 App Paths + 标准路径、FileVersion/注册表版本、`Local State` 的 `/profile/info_cache`、7 级头像回退、下载目录（Preferences → 系统下载）、建议目录（同层含 Local State 兄弟 + "Edge Rpa/Chrome RPA" 变体）。每个 profile 标注**受限等级**（对齐 GLBT profile-rules）：`default_dir`（默认路径不可 CDP）/ `multi_user`（同目录多用户，浏览器单实例锁）/ `none`；`real_browser_env` 的 render 与设置页 UI 均展示该标注。`realbrowser-config.json` 里的自定义目录自动合并进检测（AI 与设置页同一视图）。

## 浏览器设置 UI（设置 → 浏览器设置）

对标 GLBT「当前浏览器配置 + 全局浏览器配置」双面板（布局对齐其视觉语言，不复刻代码）：

- **概览条**：已授权 x/y · 运行 n · 刷新检测；运行状态每 5s 轮询（●绿=运行带 CDP 端口）
- **「当前浏览器配置」视图**＝授权边界（AI 能用什么）：按浏览器分组的**方形 profile 卡片网格墙**（对齐 GLBT 卡片：左上角 🔒默认/⚠多用户标记、右上角选中勾、大头像、名称/账号/来源目录、底部受限标签行「默认路径·不可用 / 多用户目录·受限 / 单用户目录·可用」），点卡片勾选/取消授权（默认目录点击提示不可用），组头全选/全不选，工具栏「隐藏不可控」开关（收掉默认路径配置），⋮ 菜单 = 启动 / 查看启动命令 / 创建桌面快捷方式 / 关闭该配置 / 全部终止
- **「全局浏览器配置」视图**＝环境资产（机器上有什么+怎么管理）：顶部浏览器选择条（对齐 GLBT 左栏的角色，窄栏下用 tab）→ 选中浏览器详情面板——exe 路径编辑（持久化到 `realbrowser-config.json`）、用户数据目录块（🔒默认 / ⬡可 CDP / 自定义徽标 + profile 明细行：头像/账号/下载目录 + 命令/快捷方式/关闭行操作）、添加自定义目录、新建用户数据目录（含最小 Local State，env 检测立即可见）、移除自定义目录、全部终止（确认后执行）
- URL 策略守卫（deny/requireApproval）不进设置页——AI 侧 `real_browser_policy` 工具保留
- 凭证隔离 Work Mode 不进设置页——AI 侧 `real_browser_work_mode` 工具保留（无需手动 UI 开关）
- 授权边界与 AI 工具层共用 `~/.dsh/realbrowser-allowlist.json`——勾选即生效，无需重启

## 用法流程（AI 侧）

1. `real_browser_env` → 看「可 CDP 驱动的环境」（如 `User Data Rpa` 的广州/香港子账号）
2. `real_browser_launch` → 指定该环境的 `userDataDir` + `profileId`，得到 CDP 端口（RPA 场景可先 `real_browser_fingerprint` 审计环境是否干净）
3. **未授权配置**（错误消息会指明）：调 `real_browser_allow` 申请授权（Web GUI 弹审批卡片，用户批准后自动写入允许列表），或 `real_browser_launch` 直接带 `autoGrant:true` 一步到位；批准后无需用户去设置页手动勾选
4. 看页面：`real_page_list` / `real_page_dom` / `real_page_eval`（被 URL 策略守卫保护的目标会弹审批或被拒）
5. **交互**：`real_page_snapshot` 拿 `eN` 引用 → `real_page_click` / `real_page_fill` / `real_page_select` / `real_page_check` / `real_page_press_key` / `real_page_type` / `real_page_wait`（调试表单、按钮、下拉）；登录/填密前开 `real_browser_work_mode`，密文用 `real_page_type_secret`（vault）
6. 排障：`real_page_find` / `real_page_network` / `real_page_console` / `real_page_tabs` / `real_page_upload`
7. **验证码**：`real_page_captcha` 检测到 → 停下交用户解决
8. `real_browser_close` → 用完清理

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
node tests/test-registration.mjs  # 插件形状 + 工具注册（31 个）
node tests/test-env-tool.mjs     # real_browser_env 工具端到端
node tests/test-guards.mjs       # 内置护栏（默认目录/不存在目录 快速拒绝）
node tests/test-host-rpc.mjs     # host typert RPC 位置参数契约（setAllowed 持久化/launch 门控）
node tests/test-allow.mjs        # 允许列表审批门控（real_browser_allow / launch autoGrant）
node tests/test-stealth.mjs      # stealth 审计电池 + console hook 防枚举 + 残留清理
node tests/test-policy.mjs       # URL 策略守卫（匹配语义 / deny 拦截导航 / 增删规则）
node tests/test-vault.mjs        # DPAPI vault 落盘加密 + work mode 脱敏 + typeSecret 不暴露
node tests/test-captcha.mjs      # 验证码探测（多组件页 / 干净页）
node tests/test-network.mjs      # 实时网络捕获（method 过滤真实生效）
node tests/test-interaction.mjs  # 交互层冒烟（snapshot/click/fill/type/keys/select/check/scroll/wait/find/tabs/network/console）
node tests/test-iframe.mjs       # iframe 穿透（同源递归快照 + frame 定位 + 跨源拒绝）
node tests/test-downloads.mjs    # 下载跟踪（真实 headless 下载事件）
node tests/test-contract.mjs     # host/client 契约 + client bundle 内容完整性
node tests/test-config.mjs       # 全局浏览器配置持久化（exe 路径 / 自定义目录）
node tests/test-ops.mjs          # 运维操作（启动命令 / 建目录 / 快捷方式 / 关闭 / 全杀）
node tests/test-avatars.mjs      # 头像管线（压缩 / 缓存魔数 / 回退）
node tests/test-lossless.mjs     # 全部 31 个工具输出 lossless JSON 校验（防 undefined 字段回归）
```

## 限制与安全

- **默认 profile 目录无法开调试端口**（Chrome/Edge 安全限制，见能力模型）；可驱动的必须是**非默认目录**（RPA 环境、自定义目录）。
- **三层 AI 操作边界**：① 允许列表（allowlist.js）管「哪些浏览器环境可驱动」；② URL 策略（policy.js）管「哪些目标 URL 可操作」——deny 硬拦截（AI 不可自行绕过，需用户编辑策略或经审批移除），requireApproval 弹审批；③ 凭证隔离（workmode.js）——敏感模式 + DPAPI vault + `real_page_type_secret`（密文不进入模型上下文）。
- **iframe 只穿透同源**：快照会收录同源 iframe 的元素（`frame` 字段）并列出跨源 iframe（`crossOriginFrames`）；对跨源 frame 的操作会明确报错（浏览器安全限制，无法从父上下文访问）。
- **无法附加**未带调试端口启动的浏览器；无端口实例会明确标注。
- **不自动杀进程**；`force: true` 才接管（含 Edge 后台占位），留给显式决策。
- **允许列表是 AI 操作边界**：未勾选的配置默认拒绝；AI 可用 `real_browser_allow` 或 `launch autoGrant:true` 发起审批申请，用户批准后自动加入（审批策略为 `never` 或审批服务未挂载时降级为手动勾选指引）。
- **下载跟踪只记录激活后的事件**：`real_page_downloads` 首次调用才开始监听；启用期间该浏览器的下载会落到 `downloadDir`（默认用户 Downloads）。实时网络捕获同理（`real_page_network` 首次调用激活，只记录激活后的请求）。
- **stealth 纪律**：直接 CDP 附加本就不置 `navigator.webdriver`；控制台 hook 以不可枚举属性注入、可被 `real_browser_fingerprint` 审计并清理，附加后页面不残留可枚举驱动全局。插件从不为"修指纹"而改写页面。
- **凭证纪律**：vault 值经 DPAPI 加密落盘（仅本机本用户可解），快照/填充对密码框一律脱敏（页面内掩码，值不出浏览器）；`typeSecret` 只传 vault key。
- 真实 profile = 登录态 = 高权限；写回/下单类操作应挂 DSH 审批。
- 版本：0.7.0。
