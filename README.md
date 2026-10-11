# JSON Atlas

JSON Atlas 是由独立开发者 The_cute_cat 开发的本地 JSON / JSONL 可视化阅读器，基于 Tauri 2，在可交互的树形画布中探索、搜索和阅读数据。

项目名称为 **JSON Atlas**，仓库与包名为 `json-atlas`。

## 当前功能

- 原生文件选择与拖入、多文件切换，按完整路径区分同名文件
- 系统文件关联、启动参数打开文件，重复启动时交给现有窗口
- 原生菜单、工作区侧栏、紧凑的打开文件空状态与状态栏，独立的应用及文档图标
- 创建窗口前读取主显示器可用工作区，初始客户区宽高各占 75%，按 DPI 换算并居中；每次启动重新计算，不恢复旧窗口尺寸
- 导图式展开、平移、缩放、搜索定位
- 字段隐藏、展开模板、字符串内部 JSON 展开
- 阅读设置与可选会话恢复（当前仍使用 WebView localStorage）
- 全部文件在本地处理，无上传服务
- 后台解析、每个分支每页 100 项、可取消的数据搜索（最多列出前 1000 项匹配）

## 开发环境（先支持 Windows）

Node.js 22.12+，Rust MSVC 工具链，Visual Studio C++ Build Tools（含 Windows SDK），Microsoft Edge WebView2 Runtime。
本项目通过 rust-toolchain.toml 选择已安装的 MSVC 工具链，不修改系统默认的 GNU 工具链。

~~~powershell
cd json-atlas
npm ci
npm run desktop:dev
~~~

仅预览网页：npm run dev。前端检查：npm run check。回归测试：npm test。前端构建：npm run build。
桌面端回归测试：cargo test --manifest-path src-tauri/Cargo.toml --locked。
生成 Windows 安装包：npm run desktop:build。
默认 NSIS 输出目录：src-tauri/target/release/bundle/nsis/。

## 目录

- index.html：页面结构
- src/styles.css：阅读器样式
- src/reader.js：现有阅读逻辑，后续逐步拆分
- src/main.js：前端入口
- src/data.js、src/parser.worker.js：数据遍历、搜索与后台解析
- src/paging.js：树分支分页
- src/desktop.js：桌面文件入口
- src-tauri/：Rust 桌面入口、窗口与权限配置
- src-tauri/icons/app-source.png、document-source.png：用户提供的应用、文档原图；app.ico、app.png、document.ico：Windows 打包图标
- src/assets/：启动页使用的两种图标缩略图
- src-tauri/windows/installer-hooks.nsh：为关联文档设置独立图标
- examples/：不含私人数据的示例文件
- reference/：迁移来源的网页版单文件阅读器，仅作溯源，不参与构建
- docs/ROADMAP.md：实施范围与后续方向
- .github/workflows/：CI（前端检查 + 桌面端编译）与 Release（打 tag 出 Windows 安装包）

## 当前限制

这是第一轮大文件优化：解析在 Worker 中进行，JSONL 不再通过 split 创建全量行数组；搜索分批遍历数据，不再先创建整棵 DOM 树；分支分页显示，批量展开只处理当前页，显示节点达到约 5000 个时停止。搜索输入变化或按 Esc 会取消旧搜索；打开文件时可取消后台解析。

文件仍需完整读取并在内存中解析，尚未实现 JSONL 字节偏移索引与按需读取。单文件暂设 256 MiB 上限，作为保护阈值，不代表该大小的文件已通过性能验收；复杂结构和长字符串仍可能造成明显内存与界面开销。合成的 10 万条 JSONL 测试仅验证解析和搜索正确性，不能代替真实 WebView2 的大文件性能测量。

桌面恢复仅记住文件路径，重启时读取磁盘上的当前内容；设置和阅读状态仍保存在 WebView localStorage。网页预览仍使用文件内容副本，受存储容量限制。尚未实现最近文件列表、文件监测或自动更新。展开状态仍沿用结构模板的数组索引归一化方式，不承诺恢复所有数组条目的精确展开状态。

首版优先验证 Windows。当前工具链和安装包配置面向 Windows；macOS/Linux 尚未配置和验证。网页预览通过不能代替 WebView2 内的实际交互验证。

## 作为默认打开方式

Windows 安装包声明支持 `.json`、`.jsonl`、`.ndjson`、`.jsonlines`。安装后可在资源管理器中右键文件 → 打开方式 → 选择 JSON Atlas，并选择始终使用。也可在 Windows 的“默认应用”中按扩展名设置。应用支持首次启动及已运行时接收文件路径；单独复制 exe 不会安装文件关联。安装器将独立的 document.ico 放入应用目录，并为 JSONAtlas.Document 设置文档图标；只有选择本应用关联的文件才使用此图标。

卸载后会通知资源管理器刷新文件关联和图标。若曾将 JSON Atlas 设为默认应用，卸载后可能需要通过“打开方式”重新选择编辑器；卸载程序不替用户指定默认应用。

快捷键：Ctrl+O 打开文件，Ctrl+F 搜索，Ctrl+W 关闭当前文件（输入框外），F3 / Shift+F3 切换匹配，Esc 取消搜索或打开操作并关闭弹窗。

## 发布前验收

- 安装后启动应用，打开示例 JSON / JSONL，检查中文、搜索与多文件切换。
- 在资源管理器中选择 JSON Atlas 作为打开方式，检查文档图标与双击打开；应用运行时再次双击文件，应复用现有窗口。
- 检查文件拖入、设置保存和可选的重启恢复。
- 检查小屏、高 DPI 与多显示器下的初始窗口尺寸和工具栏显示。
- 卸载应用，确认程序文件与本应用的文件关联注册已清理。

## 来源和许可

JSON Atlas 使用 Apache-2.0 许可证，见 [LICENSE](LICENSE)。版权所有 (c) 2026 The_cute_cat 和其他贡献者。安装包发布者为 The_cute_cat。

阅读器界面与逻辑迁移自开发者个人网站中的 json_mindmap_reader.html，[迁移参考版本](reference/json_mindmap_reader.html)不参与构建。hopecat 为开发者个人网站的域名前缀。应用与文档图标由维护者提供，原图保存在 `src-tauri/icons/`。维护者已确认原网页及两张图标为自有作品或已获开源使用授权；第三方依赖保留各自的许可证。
