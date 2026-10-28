# VisualLaTeX Studio

**导入文档，直接可视化修改，再导出——支持多文件、PostScript 与本机 PDF 编译。**

这是基于 [Escap1ng/VisualLaTeX](https://github.com/Escap1ng/VisualLaTeX) 的独立工作区版本，延续可视化修改现有 LaTeX 文档的用途，并增加完整源码、多文件项目、参考文献、ZIP 管理及真实编译。公式编辑内置 MathLive 0.111.1（MIT）及其字体，无需 npm 安装或构建即可离线编辑；编译需要 Node.js 22+ 和相应工具链。

**完整 LaTeX 文档默认进入「可视化编辑」。** 直接修改文字和标题，用工具栏调整格式；单击排版后的公式，使用图形输入框编辑分式、上下标等内容。引用和标签显示为可读条目，单击即可修改，无需切换源码。只修改需要改动的内容，保留其余源码；切换文件会记住当前会话中为各文件选择的编辑模式。

「源码编辑」随时可用，适合修改导言区、自定义宏和复杂结构。BibTeX、PostScript、章节片段及未完成的文档可直接编辑源码，并保存、导出；它们不会被强行转换成可视化内容。PostScript 当前支持源码编辑和渲染，不提供任意图形对象的可视化修改。

## 开始使用

默认项目包含 `main.tex`、`references.bib` 和 `drawing.ps`。只需编辑时可以双击 `index.html`；需要预览和 PDF 导出时，按以下方式启动本地服务。

### Windows

安装 [Node.js 22 或更新版本](https://nodejs.org/en/download)，解压源码包，在该目录打开 PowerShell：

```powershell
.\setup-windows.ps1
.\start.ps1
```

如果 PowerShell 的默认执行策略阻止脚本，可对这一次调用使用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-windows.ps1`，启动脚本同理；无需修改系统执行策略。

安装脚本下载固定版本的 Tectonic 0.17.0、Ghostscript 10.08.0 和解压工具，校验官方发布的 SHA-256 后放入当前目录的 `.tools`。它只解包安装器，不运行安装器、不写注册表、不覆盖项目文件。再次执行会保留已存在的工具；失败时下载和暂存文件会留在 `.tools` 便于检查。第三方引擎未包含在源码包中，各自许可保留在下载包内。

启动后在浏览器打开终端显示的地址，默认是 `http://127.0.0.1:4173`。更换端口可用 `.\start.ps1 -Port 4174`。终端需保持运行；按 Ctrl+C 退出。

### macOS、Linux 或已有工具链

安装 [Tectonic](https://tectonic-typesetting.github.io/book/latest/installation/index.html) 或 XeLaTeX，以及 [Ghostscript](https://ghostscript.com/releases/gsdnld.html)，确保可执行文件在 PATH 中，然后运行：

```bash
node server.mjs
```

也可用以下环境变量指定已有引擎的**可执行文件路径**：`VISUALLATEX_TECTONIC`、`VISUALLATEX_XELATEX`、`VISUALLATEX_GHOSTSCRIPT`；XeLaTeX 的文献工具可用 `VISUALLATEX_BIBTEX`、`VISUALLATEX_BIBER`。显式设置 XeLaTeX 可选择本机 TeX 发行版；不要同时指定两个 LaTeX 引擎。

Tectonic 首次编译会按需联网下载宏包和字体支持文件，之后可复用缓存；源码在本机编译，不上传到第三方。Windows 启动脚本将缓存放在 `.tools/cache`；也可设置 `TECTONIC_CACHE_DIR`。已有本机 TeX 发行版按其自身方式管理宏包与字体。

### 编辑与生成 PDF

1. 用「添加文件」加入文件，或用「打开文件夹」「打开项目」导入目录/ZIP。
2. 从左侧选择 `main.tex` 等完整 LaTeX 文档，在「可视化编辑」中修改文字、标题和格式；单击公式、引用或标签直接编辑。自定义宏和复杂结构可切换到「源码编辑」修改，再返回可视化继续写作。
3. 用「下载文件」导出当前文件，或用「导出 ZIP」保存整个项目及资源。
4. 选择编译目标：LaTeX 使用完整的主文档，PostScript 使用 `.ps` / `.eps` 文件，点击编译/渲染或按 Ctrl/Cmd+Enter。
5. 在预览区检查生成的 PDF，使用「导出 PDF」保存结果。PDF 预览只显示排版结果，修改内容仍在编辑区完成。编译失败可查看日志，也可取消运行中的任务。

修改源码后，旧 PDF 会标记为过期；导出会先编译当前内容，避免将旧结果误当成最新版本。编译失败时保留上次预览，项目源码保持可编辑。本机安装 Ghostscript 后，预览以分页图片显示，不依赖浏览器自带 PDF 阅读器；可用「上一页」「下一页」切换。未安装 Ghostscript 时会明确提示，并尝试浏览器原生 PDF 预览，仍可导出完整 PDF。

图片预览最多显示前 100 页，每页固定为 1200×1600 的适配画布（保留整页比例），不影响原 PDF 的页面尺寸、矢量内容和全部页数。每页按需生成，默认最多等待 20 秒；失败可以重试。图片预览不提供文字选择，请在导出的 PDF 中复制文本。

`file://` 和 GitHub Pages 的静态版本只提供编辑，不执行编译。浏览器草稿按来源隔离；从旧离线页面切到本地服务前，请先导出 ZIP，再在本地服务中打开。

打开文件夹或项目包会在确认后替换当前项目；添加文件会保留已有文件，并自动为重名文件另起名称。源码中已有的 `\input`、图片路径和引用键不会因重命名文件而自动重写。

## 编辑能力

| 功能 | 支持范围 |
| --- | --- |
| 可视化修改 | 完整 LaTeX 文档默认可视化编辑；直接修改文字、标题、格式、列表、公式、引用及标签 |
| 图形公式编辑 | 公式排版显示；单击编辑分式、上下标等，支持行内/行间公式及 equation、align、gather 的普通和星号环境 |
| 完整源码 | `.tex`、`.latex`、`.sty`、`.cls`、`.bib`、`.ps`、`.eps` 及自定义扩展名的 UTF-8 文本文件 |
| 多文件工作区 | 新建、重命名、删除、设定主文件；保留相对目录结构 |
| 可视化/源码 | 切换时同步内容；记住各文件在当前会话中选择的模式；不完整 TeX、片段、BibTeX 和 PostScript 使用源码模式 |
| 引用与文献 | `\cite` / `\ref` / `\label` 显示为可读条目并可单击编辑；选择项目标签及 BibTeX 条目，修改引用键和可选注，新增文献条目 |
| 查找替换 | 当前文件查找、循环查找、单次替换、全部替换、区分大小写 |
| 撤销重做 | 每个文件独立历史，支持源码和可视化编辑；同一输入过程合并成一步 |
| PostScript | `.ps` / 文本 `.eps` 源码编辑、页面/过程导航、示例文件、UTF-8 与 Latin-1 编码；暂不支持任意 PS 图形的可视化修改 |
| 图片等资源 | 二进制文件按原始字节保存；二进制 EPS 保留为资源，可单独下载 |
| 项目 ZIP | 导入 stored/deflate ZIP，导出标准 ZIP；包含未打开文件的编辑及原始资源 |
| 本机草稿 | 整个项目单次保存；失败时显示状态；兼容旧版单文档草稿迁移 |
| LaTeX 编译 | Tectonic 或 XeLaTeX，带项目文件与资源、引用及参考文献处理 |
| PostScript 渲染 | Ghostscript 将 PS/EPS 转为 PDF；EPS 按 BoundingBox 裁切 |
| PDF 预览与导出 | 编译目标选择、取消、错误日志、旧结果标记及当前版本导出 |

可视化引用使用项目中的章节标题、标签键和 BibTeX 作者、标题、年份等元数据帮助识别目标，不将这些提示当作编译后的引用编号或页码。最终引用编号、文献样式和公式排版以编译生成的 PDF 为准。

公式编辑窗口提供图形数学输入和标签/显示编号字段，保留公式分隔符、环境名及未编辑的原文。多行公式的标签和编号按所属行保留。自定义宏或当前渲染器不支持的复杂表达式仍可使用窗口中的高级输入或源码编辑。LaTeX 章节、基础格式、列表和简单图片保留可视化支持；其他复杂结构以可编辑原文块呈现。

新建 `main.tex` 会生成完整文档；其他 `.tex` 文件默认留空，适合 `\input` 的章节片段。新建 `.ps` / `.eps` 会提供对应模板。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| Ctrl/Cmd + S | 保存本机项目草稿 |
| Ctrl/Cmd + F | 当前文件查找替换 |
| Ctrl/Cmd + Z | 撤销 |
| Ctrl/Cmd + Shift + Z / Ctrl + Y | 重做 |
| Ctrl/Cmd + Enter | 编译或渲染当前目标 |
| Tab | 在源码中插入两个空格 |

底栏的编码按钮可显式切换 UTF-8 / Latin-1。Latin-1 不能表达的字符不会被静默替换；需要输入这些字符时先切换编码。

## 数据与边界

- 项目最多 500 个文件、展开后 50 MB；ZIP 包最多 100 MB。加密、分卷和 ZIP64 包暂不支持。
- 浏览器自动保存容量由浏览器决定，可能小于项目导入上限。大项目请使用「导出 ZIP」备份；撤销历史仅保留在当前会话。
- UTF-8 BOM、原始换行和未编辑的 LaTeX 源码块会被保留。可视化改动的区段会重新生成 LaTeX。
- ZIP 中的项目名称、主文件和当前文件记录在 ZIP 注释中，不占用或覆盖用户文件名；第三方重新打包可能移除这些设置，但源码和资源仍可导入。
- 编译是显式操作，默认最长 180 秒；初次下载宏包可能较慢。修复错误后可重新编译，日志包含引擎报告的文件名和行号。
- Tectonic 提供 TeX/BibTeX 自动多遍处理；BibLaTeX/Biber 项目应使用安装了 Biber 的 XeLaTeX 工具链。中文及自定义字体需在工具链中可用。需要 shell-escape 的宏包（例如部分 minted 工作流）不受支持。
- 字体实测限制：Tectonic 0.17.0 使用默认 ctex/Fandol 字体时，样例 PDF 的中文外观正常，但复制或文本提取的字符映射异常。Windows 上有对应系统字体时，可在自己的文档中显式使用 `\usepackage[UTF8,fontset=windows]{ctex}`；该设置已在此 Windows 样例验证复制正常。应用不会自动修改项目的字体设置，其他平台和字体组合需自行核验。
- 服务仅绑定本机回环地址，检查 Host、Origin 和会话令牌；临时项目目录在任务结束后清理。Tectonic 使用 `--untrusted`，XeLaTeX 关闭 shell-escape，Ghostscript 使用 `SAFER`。这些选项**不是操作系统沙箱**，请编译可信的本机项目，不要将此服务改成公网编译服务。
- 可视化编辑不提供完整 TeX 语法分析；正式排版与诊断以编译引擎结果为准。

## 开发与验证

Node.js 22+，无需安装 npm 包：

```bash
node --check main.js
node --check workspace.js
node --check visual-math.js
node --check visual-references.js
node --check visual-references-ui.js
node --check preview.js
node --check compiler.mjs
node --check server.mjs
node tests/smoke.mjs
node --test
```

测试覆盖源码往返、HTML 注入、草稿迁移、多文件历史、引用索引、PostScript/资源字节、ZIP 完整性、编译进程与本地服务边界、取消/过期结果及实际界面事件。新增回归覆盖公式/引用展示变化不改写原文、只修改选中的引用命令、数学分隔符与环境及标签保留、旧草稿快照迁移、可视化引用交互，以及本机服务的公式脚本/字体白名单。常规测试通过模拟引擎验证流程，无需安装工具链；DOM 测试使用最小模型，不代表真实浏览器布局或实际引擎排版验证。

MathLive 的本地脚本、样式、字体和许可位于 `vendor/mathlive/`；[manifest.json](vendor/mathlive/manifest.json) 记录固定版本、下载来源、包完整性及每个文件的 SHA-256。编辑器从本地资源加载它们，不依赖 CDN。

真实浏览器验收步骤见 [浏览器验收清单](tests/browser-acceptance.md)。本次真实工具链验证使用 Tectonic 和 Ghostscript；XeLaTeX 分支尚未在真实发行版中验证。

CI 检查 `main` / `dev` 的推送与 PR；部署和发布都在检查通过后执行。

```
index.html / workspace.css  工作台界面
workspace.js                文件、编辑模式、查找替换与导入导出协调
project-model.js            源码、项目状态、历史、引用索引
project-archive.js          无依赖 ZIP 读写
main.js / style.css         LaTeX 解析、转换及可视化编辑核心
visual-math.js / .css       公式排版、图形输入及公式标签编辑
visual-references*.js/.css  引用语义、可读展示和编辑窗口
vendor/mathlive/            MathLive 固定版本、字体、许可及校验清单
preview.js / preview.css    编译状态、PDF 预览和导出界面
compiler.mjs / server.mjs   本机编译工具与回环 HTTP 服务
pdf-preview.mjs             有界的本机 PDF 分页图片渲染
setup-windows.ps1 / start.ps1  Windows 便携工具安装与启动
tests/                      零依赖回归测试
```

## 许可

项目代码沿用 [Apache-2.0](LICENSE)。原项目由 Escap1ng 开发，本分支在其基础上扩展。内置 MathLive 0.111.1 使用 [MIT 许可](vendor/mathlive/LICENSE.txt)，随源码包保留其许可声明。
