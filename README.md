# JSON Atlas

JSON Atlas 是本地 JSON / JSONL 可视化阅读器，基于 Tauri 2，在可交互的树形画布中探索、搜索和阅读数据。

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

## 开发环境

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

## 来源和许可

JSON Atlas 使用 Apache-2.0 许可证，见 [LICENSE](LICENSE)。版权所有 (c) 2026 The_cute_cat 和其他贡献者。
