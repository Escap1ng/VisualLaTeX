<div align="center">

# VisualLaTeX

**导入 · 轻改 · 导出 —— 一个字符都不丢的离线 LaTeX 轻编辑器**

[![Version](https://img.shields.io/badge/Version-v2.0.1-6f42c1)](https://github.com/Escap1ng/VisualLaTeX/releases)
[![License](https://img.shields.io/badge/License-Apache_2.0-0366d6)](./LICENSE)
[![CI](https://github.com/Escap1ng/VisualLaTeX/actions/workflows/ci.yml/badge.svg)](https://github.com/Escap1ng/VisualLaTeX/actions/workflows/ci.yml)
[![Online Demo](https://img.shields.io/badge/Online_Demo-GitHub_Pages-00b4d8)](https://Escap1ng.github.io/VisualLaTeX/)
[![Dependencies](https://img.shields.io/badge/Dependencies-none-959da5)](https://github.com/Escap1ng/VisualLaTeX/actions/workflows/build.yml)

**中文** · [English](README.en.md)

</div>

---

<div align="center">

![VisualLaTeX 编辑器界面](screenshots/editor.png)

</div>

## 为什么需要它

论文截稿前夜，导师只让你"改几句话、换个标题"——可一打开 `.tex`，满屏反斜杠和花括号扑面而来。Overleaf 很强，但它为写代码的人设计；你只想安全地小改一下。

**VisualLaTeX 就是为此而生：**

| 场景 | 传统代码编辑器 | VisualLaTeX |
|:---|:---|:---|
| 小改动效率 | 在源码中手动定位结构 | 所见即所得，直接点改 |
| 误改风险 | 容易碰坏命令与环境 | 复杂结构原样锁存，零风险 |
| 上手成本 | 需熟悉 LaTeX 语法 | 会用 Word 就会用 |

## 核心工作流

**导入 `.tex` → 可视化轻改 → 导出 `.tex`**

修改只发生在你改动的地方，其余内容逐字符原样保留，全程离线。

## 功能一览

| 功能 | 说明 |
|:---|:---|
| 一键导入 | 打开本地 `.tex`，章节、段落、列表、公式、图片自动转为可视化元素 |
| 双栏同屏 | 左侧可视化编辑，右侧 LaTeX 源码实时预览 |
| 基础排版 | 三级标题、加粗、斜体、居中、有序/无序列表 |
| 公式输入 | 30+ 符号快捷面板，支持行内 `$...$` 与行间 `$$...$$` |
| 原样保留块 | 表格、参考文献、代码清单等复杂结构原文展示、可编辑、导出不丢失 |
| 命令保护 | `\cite`、`\ref` 等引用命令原样保留，绝不被转义破坏 |
| 图片插入 | 填写路径自动生成 `figure` 浮动环境 |
| 一键导出 | 复制源码或下载 `.tex`，自动沿用导入文件名 |
| 自动缓存 | 草稿连同导言区一起保存，刷新页面内容不丢失 |

## 快速开始

**零安装 · 零依赖 · 零构建**，克隆后双击即可离线运行：

```bash
git clone https://github.com/Escap1ng/VisualLaTeX.git
```

然后双击 `index.html`。就这样。

也可以直接使用[在线预览版](https://Escap1ng.github.io/VisualLaTeX/)（由 GitHub Actions 自动部署）。

## 项目结构

```
VisualLaTeX/
├── index.html    # 主页面（布局、工具栏）
├── style.css     # 全局样式
├── main.js       # 编辑器核心、.tex 解析、DOM↔LaTeX 转换
├── tests/        # 零依赖冒烟检查（CI 使用）
├── .github/      # GitHub Actions 工作流（CI / 自动发布 / Pages 部署）
├── README.md     # 项目说明（中文）
└── README.en.md  # 项目说明（English）
```

## 持续集成

项目使用 GitHub Actions 实现自动化检查与发布：

| 工作流 | 触发时机 | 作用 |
|:---|:---|:---|
| CI | 推送 `main` / 针对 `main` 的 PR | JS 语法检查 + 零依赖冒烟检查（资源完整、标签配对、DOM id 一致性） |
| Build & Release | 推送 `v*` 版本标签 | 打包 `VisualLaTeX-vX.Y.Z.zip` 并自动上传至 GitHub Release |
| Deploy to GitHub Pages | 推送 `main` | 自动部署[在线预览版](https://Escap1ng.github.io/VisualLaTeX/) |

## 推荐工作流

导入要修改的 `.tex` → 可视化完成文字与结构调整 → 导出下载 → 放回原项目编译。

<details>
<summary><b>已知限制</b></summary>

1. 基于 `contenteditable` 简易富文本实现，复杂嵌套排版容易解析出错
2. 不支持可视化表格编辑（表格以原样保留块形式编辑源码）
3. 嵌套同名环境（如 itemize 套 itemize）等极端结构可能解析不完美
4. 定位是轻量修改工具，大规模重写建议直接使用代码编辑器

</details>

<details>
<summary><b>版本历史</b></summary>

- **v2.0.0**：去垂直化改造，转型为通用离线 LaTeX 轻编辑器；新增 .tex 导入；未支持结构原样保留，实现往返保真；修复导言区不随草稿缓存、公式误改丢数据等问题
- **v1.1.0**：可视化编辑器 + 数模公式助手（已被 v2.0.0 移除）
- **v1.0.0**：首个版本

</details>

## 参与贡献

欢迎提交 [Issue](https://github.com/Escap1ng/VisualLaTeX/issues) 或 Pull Request。

## 开源协议

[Apache License 2.0](./LICENSE) © Escap1ng

---

<div align="center">

**如果这个工具帮你省下了一小时，欢迎点一个 Star**

</div>
