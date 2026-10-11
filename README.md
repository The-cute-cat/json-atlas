# JSON Atlas

JSON Atlas 是基于 Tauri 2 的本地 JSON / JSONL 可视化阅读器，在可交互的树形画布中探索、搜索和阅读 JSON / JSONL 文件。当前是从 Hopecat 网页阅读器迁移而来的桌面项目起点。

项目名称为 **JSON Atlas**，仓库与包名为 `json-atlas`。本地工作目录目前仍为 `D:\code\Rust\json-map-reader`。

## 当前功能

- JSON / JSONL 文件选择与拖入、多文件切换
- 导图式展开、平移、缩放、搜索定位
- 字段隐藏、展开模板、字符串内部 JSON 展开
- 阅读设置与可选会话恢复（当前仍使用 WebView localStorage）
- 全部文件在本地处理，无上传服务

## 开发环境（先支持 Windows）

Node.js 22.12+，Rust MSVC 工具链，Visual Studio C++ Build Tools（含 Windows SDK），Microsoft Edge WebView2 Runtime。
本项目通过 rust-toolchain.toml 选择已安装的 MSVC 工具链，不修改系统默认的 GNU 工具链。

~~~powershell
cd D:\code\Rust\json-map-reader
npm install
npm run desktop:dev
~~~

仅预览网页：npm run dev。前端检查：npm run check。前端构建：npm run build。
生成 Windows 安装包：npm run desktop:build。
默认 NSIS 输出目录：src-tauri/target/release/bundle/nsis/。

## 目录

- index.html：页面结构
- src/styles.css：阅读器样式
- src/reader.js：现有阅读逻辑，后续逐步拆分
- src/main.js：前端入口
- src-tauri/：Rust 桌面入口、窗口与权限配置
- examples/：不含私人数据的示例文件
- reference/：迁移来源的网页版单文件阅读器，仅作溯源，不参与构建
- docs/ROADMAP.md：实施范围与后续方向
- .github/workflows/：CI（前端检查 + 桌面端编译）与 Release（打 tag 出 Windows 安装包）

## 当前限制

这不是已经完成大文件优化的版本。文件仍全量读取和解析；搜索会创建大量界面节点；恢复功能受 localStorage 容量限制；同名同大小文件仍会被视为同一文件。尚未实现操作系统文件关联、路径会话恢复、文件监测、后台索引或自动更新。

首版优先验证 Windows。当前工具链和安装包配置面向 Windows；macOS/Linux 尚未配置和验证。网页预览通过不能代替 WebView2 内的实际交互验证。

## 来源和许可

阅读器界面与逻辑来自现有 Hopecat 工具集 json_mindmap_reader.html，原文件保存在 `reference/json_mindmap_reader.html` 且保持不变。JSON Atlas 使用 Apache-2.0 许可证，见 LICENSE。版权所有 (c) 2026 JSON Atlas contributors。发布前请确认原始资产及后续引入依赖的许可。
