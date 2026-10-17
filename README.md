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

## 大文件支持进度

设置中提供 32 MB、64 MB、128 MB、256 MB 四档大文件阈值，默认 64 MB，按 1 MB = 1024 × 1024 字节计算。桌面版打开超过阈值的 JSON / JSONL 时，在后台扫描并建立磁盘索引，显示加载动画、进度及取消按钮；展开、翻页时再读取对应内容。普通文件仍采用原有内存解析，浏览器预览仍保留 256 MiB 上限。

小文件使用“展开全部 / 展开全部下级”，普通分支直接显示内存中的子项，不按 100 项分页。为保护界面，单分支最多显示约 5000 项，超出会提示并可通过搜索定位。

大文件 JSONL 使用独立行锚点表：小于 2 GiB 时每条有效记录占 4 字节，更大文件使用 8 字节；普通行在展开时解析，末页可直接定位。超过 64 KiB 的单行采用流式子树索引后备路径。普通 JSON 使用固定大小的块缓冲读写索引，超过 100 个子节点的容器建立连续位置表，翻页和数组下标定位可直接读取目标位置。普通 JSON 的逐节点索引仍较占磁盘空间，宽对象按字段名查找仍需扫描。[JSON / JSONL 实测与复现方法](docs/README.md)。

索引模式共享 32 MiB 页面缓存预算，优先保留已显示页面，淘汰较久未使用的历史页，并在有余量时预读下一页。缓存命中仍校验文件是否变化；搜索不填充阅读缓存。远离视野的普通字段卡片会释放内容 DOM，保留精确尺寸占位，靠近或搜索定位时恢复；分支骨架和展开状态保留。长字段显示预览，单次全文读取/复制上限为 8 MiB。实现细节与验证范围见 [大文件实施记录](docs/LARGE_FILES.md)。

## 来源和许可

JSON Atlas 使用 Apache-2.0 许可证，见 [LICENSE](LICENSE)。版权所有 (c) 2026 The_cute_cat 和其他贡献者。
