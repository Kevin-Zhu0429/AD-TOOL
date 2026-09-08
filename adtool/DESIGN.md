---
version: alpha
name: "CYES 广告工作台"
description: "面向广告运营的密集数据工作台，保留活动、搜索词和检测原因之间的直接联系。"
omitted:
  - section: colors
    reason: "运行时颜色由 web/src/index.css 的浅色和深色语义变量维护。"
  - section: typography
    reason: "运行时字体由 web/src/index.css 的 --font 和 --mono 维护。"
  - section: spacing
    reason: "沿用 optimizer.css 的既有表格密度，本次不新增间距系统。"
  - section: rounded
    reason: "沿用现有按钮和 flagchip 样式。"
  - section: components
    reason: "组件所有权与检测状态定义见 UX-CONTRACT.md。"
---

# CYES 广告工作台

## Overview

中文界面的广告运营工具，处理多站点、多语言搜索词。设计参照现有广告优化工作台及搜索词明细：优先让用户逐行核对投放系列、搜索需求和数据指标。此次工作只调整检测结果和解释，保留既有视觉身份。

## Colors

运行时源为 `web/src/index.css`。`web/src/components/optimizer.css` 的 Shadow DOM 适配层将 `--red/--red-soft` 映射为 `--mg/--mg-b`，将 `--amber/--amber-soft` 映射为 `--ye/--ye-b`。红色表示疑似跑偏，黄色表示需要核对；必须同时有文字标签，不单靠颜色。

## Typography

沿用 `--font` 的 Segoe UI、苹方、微软雅黑等回退字体；数字指标沿用 `--mono` 与等宽数字。机型和墨盒列表保留原始可读写法。长原因允许换行，不能只通过鼠标悬停读取。

## Layout

保留原生表格、左侧活动导航和分析页结构。原因列随内容增高，保留指标列及否定操作；`.antbl .drift-reason` 的最小宽度为 260px、最大宽度为 380px，避免窄屏把长原因压成逐字竖排。窄屏沿用工作台内容滚动，不为新标签改变页面滚动所有权。

## Elevation & Depth

沿用已有浅深主题、表头和边框，不新增卡片、阴影或浮层。

## Shapes

状态标签复用 `.flagchip`，表格行复用 `.lv-bad` 和 `.lv-warn`。

## Components

`modelDrift.js` 的 `driftPresentation` 定义结果名称和语义色，`optApp.js` 的 `driftBadge` 负责统一渲染。明细与分析页不得各自解释状态。检测行为和验证入口见 `UX-CONTRACT.md`。

## Do's and Don'ts

- 显示候选机型、对应墨盒以及活动是否已投放，让人工判断有具体依据。
- 保留输入搜索词，不把推测的机型写成用户明确输入的机型。
- 不新增营销式装饰、动效或不影响决策的实现说明。
- 不将词库记录冲突或 SKU 资料缺失显示为确定的未投放。
