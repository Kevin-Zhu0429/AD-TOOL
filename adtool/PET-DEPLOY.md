# 宠物版（美国站）

品类配置由服务端 `APP_PROFILE=pet` 决定；前端启动时读取 `/api/config`。同一个前端构建可部署为墨盒版或宠物版。未设置时默认仍为墨盒版。宠物版只接受 US 站点，账户权限仍由原来的角色和功能开关控制。

## 已包含

- SKU：SKU、款式、尺码、颜色、面料外观、在库库存、在途库存、品牌、ASIN。国家默认 US；尺码独立保存。支持导入、粘贴、编辑、分页、导出、属性筛选及选 SKU 开广告。
- 自动和手动广告：共用原广告引擎，手动选择广告组合；保留手动否定词和否定 ASIN。
- 产品情报：美国站按月导入，先预览并映射列；产品属性和对比组人工维护，不从标题推断。评分、评论数、销量等无来源时留空。优惠先保存说明，价格范围不自动折算优惠。
- ABA：品牌与 ASIN 视图、上传、趋势、搜索、分页、导出；ASIN 可按关联 SKU 的款式、尺码、颜色筛选。不同 ASIN 分开显示，不做款式汇总，不分摊 SKU 指标。
- 广告优化：通用工作台与库存风险联动；不使用墨盒跑偏检测、D 库或共享否定词库。

## 本地启动（推荐）

在 `adtool` 或 `adtool/server` 目录打开终端，一条命令同时启动前后端：

```powershell
npm run dev:pet
```

打开 http://localhost:5174 。墨盒版用 `npm run dev:ink`，打开 http://localhost:5173 。两版可同时运行，切换浏览器地址即可；各自的账号、数据库和登录 Cookie 独立。按 Ctrl+C 或输入 `q` 回车会停止本次启动的前后端。端口被旧服务占用时，先在旧终端按 Ctrl+C。

首次创建宠物管理员（已有账号不用再创建）：

```powershell
npm run seed:pet -- 你的用户名 你的显示名 你的密码
```

墨盒管理员对应 `npm run seed:ink -- 用户名 显示名 密码`。创建账号与启动自动使用同一数据库，无需手动设置环境变量。

要查看构建后的页面，在 `adtool` 目录执行：

```powershell
npm run build
npm run start:pet
```

构建版宠物地址为 http://localhost:8081 ，墨盒 `npm run start:ink` 为 http://localhost:8080 。同一品类的开发和构建服务共用后端端口，先停止其中一个再启动另一个。

本地命令固定品类和端口，不受终端里遗留的 `APP_PROFILE`、`PORT`、`DATA_DIR` 影响。宠物数据固定在 `server/data-pet`；墨盒读取 `server/.env` 的 `DATA_DIR`（相对路径按 `server` 解析），未设置则用 `server/data`。需要自定义本地数据目录时使用 `PET_DATA_DIR` / `INK_DATA_DIR`。其他后端配置读取 `server/.env`，本地 HTTP 自动关闭 secure Cookie。

这些命令用于本地运行；服务器 HTTPS 部署继续使用下面的 Compose 配置。

## novagaming 服务器（本分支的默认部署）

`codex-pet-adaptation` 分支的 `docker-compose.yml` 已固定 `APP_PROFILE=pet`。沿用现有 `.env`、容器名、宿主机端口与域名反向代理，不需要新增 DNS，也不用 `.env.pet` 或 `compose.pet.yml`。公司服务器继续使用 `main` 墨盒分支。

在服务器现有项目的 `adtool` 目录执行（工作区应无未提交的代码改动）：

```bash
git fetch origin
git switch codex-pet-adaptation
git pull --ff-only origin codex-pet-adaptation
mkdir -p data-pet-prod
docker compose --env-file /etc/amazon-app/app.env up -d --build
```

`data-pet-prod` 必须允许现有 `.env` 的 `APP_UID` / `APP_GID` 写入；如果部署账号与该身份不同，由管理员设置该目录的所有者。原墨盒 `data-prod` 原地保留，宠物不会打开或修改它。原域名现在展示宠物版，墨盒容器被同名宠物服务替换；不会同时运行两个站点。

首次创建宠物管理员（只执行一次）：

```bash
docker compose --env-file /etc/amazon-app/app.env exec adtool node src/seed.js 用户名 显示名 密码
```

本地账号不自动同步到服务器。打开原域名重新登录；访问 `/api/config` 应看到 `id: "pet"` 和 `markets: ["US"]`。如果原来登录页已打开，刷新页面后再登录。

以后在此分支更新：

```bash
git pull --ff-only origin codex-pet-adaptation
docker compose --env-file /etc/amazon-app/app.env up -d --build
```

亚马逊凭据使用 `.env` 的 `PET_SP_*`（见下方“亚马逊 SP-API 同步”），不继承墨盒的 `BRAND<n>_` 凭据。未配置时同步不可用，SKU 库和价格策略表仍可人工维护。现有 HTTPS、会话密钥及端口配置沿用原 `.env`。

如需恢复墨盒，在工作区干净时切回 `main`，再执行 `docker compose --env-file /etc/amazon-app/app.env up -d --build`，会重新挂载原 `data-prod`。宠物数据仍保存在 `data-pet-prod`，不删除它。

### 将来独立域名部署（当前不用）

`compose.pet.yml` 和 `.env.pet.example` 保留供未来独立实例部署，默认绑定本机 8081；当前 novagaming 使用上面的默认 Compose 流程即可。

## 后续再定

否定词分类体系、宠物搜索意图判断、款式层级 ABA 汇总、更多宠物品类字段和竞品评分均未推断实现。先用真实报表验证现有字段，再逐项扩展。

## 宠物店铺共享数据

宠物版全部已登录账号共享 SKU、库存、广告组合、产品情报及品牌/ASIN ABA 报告，均可导入和维护。业务功能不再逐账号开通；账号管理和系统配置仍由管理员维护，操作日志保留真实操作者。

升级启动时自动事务迁移原账号数据，同一 SKU / 广告组合 / 品牌或 ASIN 周报重复时保留最近更新记录（时间相同按记录编号），原记录与报表明细归档在数据库的 `pet_shared_migration_archive`。共享数据不随个人账号删除。墨盒版维持原账号隔离。

本地广告草稿和广告优化中临时打开的文件仍在当前浏览器内，不属于已保存的服务器业务库，不会自动跨电脑同步。

## 亚马逊 SP-API 同步（SKU 库 + 价格策略表 + 销售统计）

宠物版不再使用船长。SKU 库左栏的「从亚马逊同步」和价格策略表的「立即同步」是同一个后台任务，一次完成：

1. **Listing 报告**（`GET_MERCHANT_LISTINGS_ALL_DATA`）：店铺全部卖家 SKU、ASIN、当前售价。新 SKU 自动加入共享 SKU 库；已有 SKU 更新 ASIN。当前售价存进 `pet_listing_cache`。
2. **FBA 库存**（`/fba/inventory/v1/summaries`）：在库＝可售数量；在途＝已发货＋接收中＋处理中，与墨盒版口径一致。写入 SKU 库。
3. **商品目录**（Catalog Items 2022-04-01）：只给尺码或颜色还空着的 SKU 补尺码、颜色。款式、面料外观等人工字段从不覆盖。
4. **订单报告**（`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`）：按太平洋时间日期和 SKU 汇总销量、订单数和销售额（`item-price`，不含税），写入 `pet_daily_sales`，覆盖到的日期整天重写。第一次同步回填到当年 1 月 1 日（至少 3 个月，每 30 天一份报告，需要较长时间），之后每次只重拉最近 9 天。取消的订单行和非 Amazon.com 渠道不计；待付款（Pending）与卖家后台“已订购商品数量”一样计入，金额按 Listing 当前价估算。报告不含买家信息。

日期按美国太平洋时间切日，与卖家后台一致。服务器每 3 小时自动同步一次，页面也可以随时「立即同步」。同步在后台运行，页面每 10 秒刷新状态。

**价格策略表**不再存每日快照：打开页面时按“今天”（太平洋时间）实时计算，第一列是今天的日期，近 7 天是今天之前的 7 个完整日，每天自动往后滚。列出在库、在途、可售天数、每日销量、近 3 日动销（最近 3 天÷3）、近 7 天动销速度（近 7 天÷7）、本月销量（含今天已同步部分）、预估售罄日（今天＋在库÷动销速度）和 Listing 售价。广告数据等亚马逊广告 API（Ads API）开通后接入。

**销售统计**：周销量按 ISO 周列出周一到周日的全店销量；每月数据里实际销量和销售额来自 `pet_daily_sales`，目标销量/销售额/利润、实际利润额和广告花费在页面上按月填写（`pet_monthly_targets`），费比和利润率据此计算。

### 配置

在 `/etc/amazon-app/app.env` 中设置（不要提交真实值）：

```bash
PET_SP_LWA_CLIENT_ID=amzn1.application-oa2-client.xxxx   # 宠物店铺开发者应用
PET_SP_LWA_CLIENT_SECRET=amzn1.oa2-cs.v1.xxxx
PET_SP_LWA_REFRESH_TOKEN=Atzr|xxxx                        # 北美卖家账号授权
PET_SP_SELLER_ID=AXXXXXXXXXXXXX                          # 卖家编号（Merchant Token）
PET_SP_BRAND=                                             # 选填：新 SKU 写入 SKU 库时的品牌
```

开发者应用需要的角色：亚马逊物流（库存）、库存和订单跟踪（订单报告）、商品信息（Listing 与目录）、品牌分析（ABA，需品牌备案）。改完执行 `docker compose --env-file /etc/amazon-app/app.env up -d --build`。只填了部分变量时，页面会提示缺哪一项。

旧的船长缓存表（`pet_price_*_cache`、`pet_captain_api_usage`）和旧的价格策略快照表 `pet_price_strategy` 保留在数据库中，不再读取。

## ABA ASIN 视图：亚马逊自动同步

ABA 报告 → ASIN 视图顶部的「从亚马逊同步」读取品牌分析「搜索查询表现」（`GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`）周报，ASIN 取自共享 SKU 库。字段与上传的 ASIN 视图 CSV 一一对应（搜索查询量、市场曝光/点击/购买、ASIN 曝光/点击/购买），写入同一张表，来源记为 `Amazon SP-API`；同 ASIN 同周的上传报告会被覆盖，内容相同时不重写。

- 周按亚马逊的周日到周六，周数与卖家后台一致。一周结束 3 天后才去拉，数据还没出（报告被亚马逊取消）的周会跳过，下次自动补。
- 默认只补还没有的 ASIN × 周；每天美西时间第一次检查时自动补最近 4 周，页面可选最近 1/4/8/12 周手动同步。
- 每份报告最多 18 个 ASIN（接口限制 200 字符），ASIN 多时分批申请。
- 亚马逊接口只提供按 ASIN 的数据，没有卖家后台的**品牌视图**，品牌视图继续上传 CSV。
- 需要开发者应用勾选「品牌分析」角色，店铺需完成品牌备案；没有权限时页面会提示 403。

## Claude 连接器（MCP，只读）

网站提供一个 MCP 接口，加到 claude.ai 的自定义连接器后，在 Claude 网页版、桌面版、手机 App 里就能直接问“分析一下某款狗窝最近为什么掉单”，Claude 会自己调用下面的工具查数据。全部只读：不写数据库，也不改亚马逊上的任何东西。

| 工具 | 内容 | 来源 |
|---|---|---|
| `store_overview` | 数据新鲜度、近 7 天/前 7 天销量销售额、本月目标完成、最近几周周销量、断货/库存不足/积压/有货不动销提醒 | 数据库 |
| `list_skus` | 价格策略表同款：每个 SKU 的属性、售价、在库在途、近 7 天每日销量、动销、可售天数、预估售罄日 | 数据库 |
| `get_sales_trend` | 按天/周/月的销量、订单、销售额，可按 SKU、ASIN、款式、尺码、颜色筛选 | 数据库 |
| `get_search_terms` | ABA 搜索查询表现：搜索量、市场与本店曝光/点击/购买、份额、点击率、转化率 | 数据库 |
| `get_listing` | 本店 Listing 实时内容：标题、五点、描述、后台搜索词、图片、报价、Listing 问题、全部属性 | SP-API Listings Items |
| `get_catalog_items` | 任意 ASIN（含竞品）的标题、品牌、五点、BSR、变体、图片和属性，一次最多 10 个 | SP-API Catalog Items |
| `get_product_images` | 下载某个 ASIN 的主图和副图给 Claude 看 | SP-API Catalog Items + 亚马逊图片 |

广告数据要等亚马逊广告 API 开通后再加。

### 开启

1. 在 `.env`（或 `/etc/amazon-app/app.env`）加一行网站的 https 地址，只写到域名：

   ```bash
   MCP_PUBLIC_URL=https://你的域名
   ```

   同时确认 `TRUST_PROXY=true`（登录页按真实 IP 限流需要）。然后照常 `docker compose ... up -d --build`。日志里出现 `[mcp] Claude 连接器地址 https://你的域名/mcp` 就是开好了。不填这一项时连接器关闭，`/mcp` 返回 503。
2. 反向代理要把 `/mcp`、`/authorize`、`/token`、`/register`、`/revoke` 和 `/.well-known/` 开头的路径转给网站（整站都转发的话不用改）。接口直接返回 JSON，不用开 SSE 或长连接。
3. 打开 claude.ai → 设置 → 连接器 → 添加自定义连接器，名称随意，地址填 `https://你的域名/mcp`，其他留空。点连接后会跳到网站的授权页，用**超级管理员**账号登录并授权，跳回 Claude 即可使用。

### 安全

- 授权用网站自己的账号密码（OAuth 2.1 + PKCE），只有在用的超级管理员能授权；账号停用或改成非超级管理员后，已发的令牌立即失效。
- 只接受 Claude 的回调地址（`https://claude.ai/api/mcp/auth_callback`）和本机回环地址（Claude Code、MCP Inspector 用），别人注册的客户端没法把授权码转到自己的网站。
- 访问令牌 1 小时有效，刷新令牌 30 天、每用一次换新的；数据库只存令牌的 SHA-256 摘要。授权页同一 IP 15 分钟最多 30 次请求。
- 每次授权记一条操作日志（`authorize` / `mcp_client`）。想让 Claude 断开，在 Claude 的连接器设置里删除即可；要立刻作废全部令牌，清空 `mcp_oauth_tokens` 表。
