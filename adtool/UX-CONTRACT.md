# 广告优化：搜索词跑偏检测

## Scope and sources

本次维护范围为跑偏检测与两处结果展示。业务依据是用户确认的优化方案（2026-09-08）；账户 SKU、区域 D 库和本地文件处理口径见 `README.md`、`server/src/libs.js`、`server/src/skuLib.js`。其他页面的行为尚未做全站审计。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| 检测状态 | `web/src/modelDrift.js`：`driftPresentation` | 用户确认方案 | 疑似跑偏、部分匹配、需人工判断、需核对品牌、需核对词库、资料不足 | 型号回归测试、浏览器明细及分析页 |
| 原因与状态展示 | `web/src/optApp.js`：`driftBadge`、`driftReason` | 同一结果对象 | 搜索词明细、跑偏检测表 | 两处文案一致、长原因换行 |
| 语义色及表格 | `web/src/index.css` → `web/src/components/optimizer.css` | 运行时 CSS；`DESIGN.md` 记录用途 | 浅色、深色，bad/warn | 浏览器桌面及窄屏检查 |

## Detection contract

- 先独立解释搜索词，再与投放比较；活动不能改变搜索词的型号识别。
- 完整打印机前缀只覆盖同一处数字。已知品牌连写、XL、墨盒词与词库内配对编号参与墨盒识别；保留完整数字边界。
- 识别过程按品牌保留候选。品牌冲突需要核对，不能强行补齐打印机前缀。
- 同一打印机、同一墨盒组的重复记录合并；不同墨盒组没有额外兼容性证据时显示词库待核对。
- 多机型候选显示每个机型及其墨盒和投放覆盖情况。部分覆盖须人工判断；均覆盖不报告跑偏。
- 同一搜索词同时有已投放和未投放系列时显示部分匹配。
- 缺少 SKU、型号或可靠 D 库映射时显示资料不足，不断言活动未投放。
- 无可识别型号的普通词不作为跑偏记录。匹配成功的词仍可在搜索词明细查看。
- 状态不会自动创建否定。原有词组、精准按钮由用户决定使用；本次不改变导出或否定行为。
- 重新载入批量表、切换站点或更新词库/SKU 后重新计算投放上下文，不能复用旧活动的型号。

## Verification

运行 `web` 下的 `npm test`、`npm run lint`、`npm run build`。`src/modelDrift.test.js` 覆盖截图词、前缀与数字边界、品牌冲突、候选映射、部分匹配和资料不足。浏览器验证使用合成批量表和测试词库，不修改用户账户或数据库。

浏览器回归入口为 `web/tests/modelDrift.browser.mjs`，通过本机回环地址的临时 Vite 页面加载真实工作台并导入合成 XLSX，结束后关闭服务器和浏览器。运行环境需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指定已有模块路径；默认使用已安装的 Edge，其他浏览器可设置 `BROWSER_CHANNEL`。运行 `node tests/modelDrift.browser.mjs`，截图写入项目 `.tmp`，不会打包测试页面。
