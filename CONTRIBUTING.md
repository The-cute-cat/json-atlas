# 贡献指南

欢迎提交问题报告、文档改进和代码修改。请先阅读 [README](README.md) 了解应用用途和使用限制。

## 开发环境

Windows x64 桌面构建需要 Node.js 26+、Rust MSVC 工具链、Visual Studio C++ Build Tools（包含 Windows SDK）和 WebView2 运行时。Apple Silicon 测试版的构建和验收见下文。

仓库的 `rust-toolchain.toml` 为本项目选择 `stable-x86_64-pc-windows-msvc`，不需要修改系统的默认工具链。执行格式和静态检查前，请确保此工具链已安装 `rustfmt`、`clippy` 组件。

在仓库根目录执行：

```powershell
npm ci
npm run desktop:dev
```

`npm run dev` 可在浏览器中预览界面，但不提供桌面文件入口和磁盘索引，不能代替桌面大文件验证。

## 检查与构建

以下命令均从仓库根目录运行：

```powershell
npm run check
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --release --locked -- -D warnings
```

Rust 构建需要先生成前端的 `dist/` 目录。`npm run desktop:build -- -- --locked` 同时构建两种安装包：EXE 输出到 `src-tauri/target/release/bundle/nsis/`，MSI 输出到 `src-tauri/target/release/bundle/msi/`。只构建 MSI 时运行 `npm run desktop:build -- --bundles msi -- --locked`。首次构建 MSI 时，Tauri 会下载并缓存 WiX 工具集，需要网络连接。提交时保留 `package-lock.json` 和 `src-tauri/Cargo.lock`，不要提交依赖目录和编译产物。

MSI 使用固定的 `bundle.windows.wix.upgradeCode` 标识同一应用的后续更新，不要在版本更新时更换它。NSIS 的 `.nsh` 安装钩子仅适用于 EXE；MSI 使用 Tauri 的 WiX 安装流程和文件关联配置，详情见 [Tauri Windows 打包说明](https://v2.tauri.app/distribute/windows-installer/)。发布前分别验证安装、升级、卸载及文件关联，切换安装格式前先卸载旧格式，避免同时安装两份。

`src-tauri/windows/file-associations.wxs` 为 MSI 补充与 EXE 共用的 `JSONAtlas.Document` 标识、“打开方式”和 Windows 默认应用注册，避免切换安装方式后原有选择指向失效的标识。不要移除该兼容标识或直接写入 Windows 的 `UserChoice`。打包后可运行以下只读检查；发布流程也执行同一检查：

```powershell
./scripts/check-msi.ps1 -Path 'src-tauri/target/release/bundle/msi/JSON Atlas_0.3.0_x64_zh-CN.msi'
```

该检查核对安装包内的注册信息及组件引用，不能替代实际安装、升级和卸载测试。校验步骤排在打包之后，因此失败时草稿 Release 已经生成；请删除该草稿，修复后重新触发工作流，不要把未通过校验的产物公开发布。

`windows/installer-ui.wxs` 定义 MSI 完成页及卸载清理条件；`installer_cleanup.rs` 在启动 WebView 前处理清理请求。普通卸载及静默卸载均自动删除当前用户的 `%LOCALAPPDATA%\io.hopecat.jsonatlas` 和 `%APPDATA%\io.hopecat.jsonatlas`，不弹出选择框。仅应用专用目录会被清理，目录链接会拒绝处理。不要把文件浏览记录中的原文件路径加入清理范围。

升级通过 `NOT UPGRADINGPRODUCTCODE` 排除清理。发布前应在测试账户验证普通卸载、静默卸载与升级路径；清理当前账户不等于清理机器上的所有账户。旧 MSI 已缓存的卸载逻辑不会自动改变，需要先安装包含此改动的新包。

### macOS Apple Silicon 测试包

在 M 系列 Mac 上准备 macOS 15 或以上、Node.js 26+、Rustup 和 Xcode 命令行工具（`xcode-select --install`）。从仓库根目录运行：

```sh
export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
npm ci
npm run desktop:dev
# 打包时另行运行：
npm run desktop:build -- --target aarch64-apple-darwin -- --locked
```

DMG 输出到 `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`。GitHub Actions 的 **macOS Apple Silicon Preview** 工作流也会运行 Rust 回归测试、检查 DMG 和应用签名，并上传测试包作为运行产物，保留 14 天。测试包使用临时签名，不上传到 Releases。

在真实 Mac 上验收：从 DMG 安装并启动；用 Finder 的「打开方式」分别在应用未运行和已运行时打开 JSON / JSONL（含中文、空格和 `#` 的文件名）；检查拖放、搜索、大文件翻页、`⌘O` / `⌘S`、另存为与未保存时退出。切换文件和视图并修改文档，核对菜单中的「保存」「撤销修改」随状态启用或禁用；在树形视图检查 `⌘C` 复制节点，在 IDE 中检查 `⌘Z` 撤销文档，再在搜索框验证剪切、复制、粘贴、全选及文本撤销。只使用测试文件做写回验证，并记录实际验收的 macOS 版本。

## 项目介绍页与浏览器试用版

`site/index.html` 和 `site/style.css` 是介绍页源码，图片放在 `assets/`。截图应来自实际应用，使用 `examples/` 中的虚构数据，避免出现个人目录或真实业务内容。

```powershell
npm run build:single
npm run build:site
```

前者生成 `dist/json-atlas.html`，可直接双击离线打开；后者生成完整站点 `dist/site/`，包含介绍页、图片和 `app.html`。可从该目录启动静态服务器预览。产物不提交，构建过程不修改 `site/` 源文件。单文件构建把解析和搜索 Worker 内联为 data URL，保持后台执行；若 Vite 的产物格式改变，构建会失败并提示检查。

提交前运行前端检查与测试，再检查站点的桌面和手机宽度、图片与链接，以及试用页打开 JSON / JSONL、搜索、编辑和下载副本的流程。同时直接用 `file://` 打开 `dist/json-atlas.html` 验证离线行为。

Pages 工作流在 `main` 的相关文件变更后构建并部署 `dist/site/`；Pull Request 的 CI 只验证构建。首次发布需在仓库 Settings → Pages 中将 Source 设为 GitHub Actions。工作流通过并不代表桌面安装包验证完成。

## 测试数据与性能验证

`examples/` 提供可直接打开的小样例。`tests/` 中的 JSON 是回归测试输入，应该与测试代码一起提交；不要将真实业务数据放在此目录。

大文件生成器默认写入已忽略的 `local-data/test-files/`。例如，只生成空文件和语法错误样例：

```powershell
node scripts/generate-test-files.js --only 21-,22-
```

`--quick` 只跳过两个约 256 MiB 的主样本，仍会生成数百 MB 数据。默认跳过已存在的文件；只有明确需要重新生成时才使用 `--force`。生成的 `manifest.json` 说明各样本的用途，样本大小以实际字节数为准。

Rust 中的性能测试和大文件集成测试默认忽略。需要时单独运行，例如：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --release --locked indexed::benchmarks::jsonl_many_fields_benchmark -- --ignored --nocapture --test-threads=1
```

这类测试会生成较大的临时文件并消耗磁盘空间。报告性能时，请同时提供硬件、构建模式、文件字节数、记录数和测试命令；不要把单次本机耗时当成所有设备的保证。

## 提交改动

- 修复问题时提供最小复现和相应回归测试；界面调整说明操作方式，并附相关截图。
- 日志、截图和样例应脱敏，不包含用户目录、真实路径、凭据或业务内容。
- 可复现的测试和生成脚本属于项目源码；大样本、原始性能日志、个人笔记及设计草稿保留在本地。
- 修改用户可见行为时同步更新 README 或更新记录。避免提交与本次修改无关的格式变化。

## 版本发布

发布前核对 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 中的应用版本，并更新 [CHANGELOG](CHANGELOG.md)。

在 PowerShell 中可执行版本一致性检查：

```powershell
$env:RELEASE_TAG = 'v0.3.0'
node scripts/check-release.js
```

发布工作流由 `vX.Y.Z` 标签触发，也支持手动选择已有标签。工作流检查通过后生成草稿 Release，除 NSIS 与 MSI 安装包外还上传 `JSON-Atlas-<tag>-portable.zip`（免安装版，解压直接运行 `json-atlas.exe`）。免安装版不注册文件关联、不提供卸载入口，依赖系统已安装 WebView2 Runtime，草稿确认时一并验证。维护者验证安装包和发布说明后再公开发布。不要向仓库提交签名证书或其他凭据。
