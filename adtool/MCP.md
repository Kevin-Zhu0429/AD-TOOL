# 墨盒版 MCP 接入

main 分支的墨盒广告工作台提供 58 个 MCP 工具。入口为现有网站的 `/mcp`，使用官方 MCP SDK 的 Streamable HTTP、OAuth 授权码和 PKCE，复用网站账号、SQLite 数据和业务接口。宠物版仍由其原分支维护。

## 开启服务

在服务器实际读取的 `.env` 中添加网站的 HTTPS 地址：

```dotenv
MCP_PUBLIC_URL=https://ink.example.com
```

地址应为网站 origin，包含协议和域名，可带端口；接口固定挂在根路径 `/mcp`。本机验证允许 `http://localhost:<端口>` 与 `http://127.0.0.1:<端口>`。没有配置或地址无效时 `/mcp` 返回 503，网站原有功能继续可用。

安装新依赖并重启后端；Docker 部署需重建镜像，Compose 的 `env_file` 会把 `MCP_PUBLIC_URL` 传入容器。无需新增端口、独立数据库或后台服务。首次启动创建 OAuth 表，现有业务资料保留。

```bash
cd adtool
docker compose up -d --build
```

如果反向代理只开放了某些路径，应转发 `/mcp`、`/mcp-auth.css`、`/.well-known/*`、`/authorize`、`/token`、`/register`、`/revoke`。MCP 每个请求直接返回 JSON，不依赖 SSE 长连接。服务器必须能从客户端访问；生产环境使用有效 HTTPS 证书。

## 连接与授权

在支持远程 MCP OAuth 的客户端添加 `https://ink.example.com/mcp`。首次连接会跳转到墨盒工作台授权页，使用已有网站用户名和密码登录。

- `ink:read`：查询、分析、计算和生成批量表。
- `ink:read ink:write`：额外允许网站数据维护、账号管理及库存/公共 ABA 同步。授权页明确显示这一范围。

所有在用账号都可授权。MCP 每次工具调用重新读取账号的角色、站点和功能权限；只读令牌无法调用写工具，普通运营无法调用 owner 工具。停用或删除账号后令牌立即失效，修改站点或模块权限后下一次调用生效。

访问令牌有效期 1 小时，刷新令牌有效期 30 天并在每次使用后轮换；刷新不能扩大权限。令牌和授权码只保存 SHA-256 摘要。网站与 OAuth 登录均不会向工具返回密码或亚马逊凭证。

支持精确的 ChatGPT / Claude 回调以及 HTTP 本机回环回调，不开放任意公网回调。客户端的 `Origin` 存在时必须与配置的网站 origin 一致。实际可用客户端回调如下：

- ChatGPT：`https://chatgpt.com/connector_platform_oauth_redirect`
- Claude：`https://claude.ai/api/mcp/auth_callback`、`https://claude.com/api/mcp/auth_callback`
- 本机：`http://localhost:<端口>/<回调>`、`http://127.0.0.1:<端口>/<回调>`、`http://[::1]:<端口>/<回调>`

HTTP 客户端配置格式示例（具体字段以客户端要求为准）：

```json
{
  "mcpServers": {
    "adtool-ink": {
      "url": "https://ink.example.com/mcp"
    }
  }
}
```

## 工具清单

工具均提供输入 JSON Schema、中文说明、只读/破坏性/外部访问标记，以及结构化结果。输入或业务权限错误返回 `isError: true`。写操作既保留网站原有业务日志，也补充 `mcp_call` 工具名称日志，不记录输入文件和密码。

| 模块 | 工具 |
|---|---|
| 工作台 | `workspace_overview` |
| SKU | `list_skus`、`import_skus`、`update_sku`、`delete_skus` |
| 广告组合 | `list_portfolios`、`import_portfolios`、`update_portfolio`、`delete_portfolios`、`match_portfolio` |
| 否定词与机型 | `get_negative_library`、`import_negative_library`、`update_negative_entry`、`delete_negative_entries`、`configure_negative_library`、`plan_negatives`、`list_cartridge_series` |
| 产品情报 | `list_products`、`import_products`、`import_products_all_markets`、`update_product`、`delete_products`、`delete_product_month`、`configure_product_intel`、`analyze_competitors` |
| ABA | `get_aba_brand`、`get_aba_asin`、`get_public_aba`、`import_aba_brand`、`import_aba_asin`、`get_public_aba_sync_status`、`sync_public_aba` |
| 亚马逊库存 | `get_inventory_status`、`get_inventory_admin`、`discover_amazon_shops`、`save_inventory_bindings`、`update_inventory_assignment`、`update_inventory_binding`、`sync_inventory`、`get_inventory_sync`、`sync_inventory_all`、`get_inventory_sync_all` |
| 超龄仓储费 | `get_aged_storage_fees`、`import_aged_inventory`、`correct_aged_sales`、`calculate_aged_storage_fee` |
| 账号与日志 | `list_users`、`create_user`、`update_user`、`delete_user`、`get_audit_log` |
| 广告生成与优化 | `get_ad_templates`、`calculate_ad_bid`、`check_model_drift`、`generate_auto_ads`、`generate_manual_ads`、`analyze_ad_bulk`、`export_ad_changes` |

## 数据与权限口径

- SKU、广告组合和私有 ABA 归授权账号，owner 也不能读取其他账号的私有 ABA。owner 可通过 `list_skus(scope="all")` 显式查看全部 SKU，但只能修改自己的 SKU。
- A 类词库与套用配置沿用站点维护权；B/C/D/E 沿用商品部维护权。区域库的变更影响整个覆盖区域。
- 产品情报沿用产品使用权和站点权限，手动广告沿用手动广告使用权，优化与跑偏工具沿用广告优化使用权。
- 公共 ABA 和超龄仓储费沿用网站现有共享规则。公共 ABA 手动同步、全账号库存同步、库存分配与账号管理需 owner。
- 库存同步只更新已有匹配 SKU：在库为可用+转运+正在接收，在途为处理中+已发货；欧洲大陆共享库存不重复相加。启动同步后查询对应状态工具。
- `replace=true` 和删除工具会删除网站资料，描述中标明受影响的账号、国家或区域。普通新增、更新默认不替换整库。
- 仓储费日销修正必须携带读取到的 `revision`，发生多人修改冲突时重新读取后再提交。

## 广告与文件使用

先调用 `get_ad_templates` 查看字段、默认值和枚举。生成广告会自动读取当前账号、当前站点的 SKU、词库与广告组合。`portfolioMode="auto"` 无法匹配时返回具体问题；使用 `portfolioMode="manual"` 时可自行填写 `portfolio`，空字符串表示不分配组合。

```json
{
  "marketplace": "ES",
  "tasks": [{ "skus": "MY-305-SKU", "places": ["TOS"], "tiers": "20,50,100" }],
  "format": "xlsx"
}
```

`generate_auto_ads` 与 `generate_manual_ads` 共用网页的否定逻辑、出价折算和自检；每次最多 20 个任务、20,000 行。返回 `format="rows"` 为 `headers` 和二维 `rows`；`format="xlsx"` 为 `filename`、`mimeType` 和 `base64`，客户端可解码保存为 Excel。

优化批量表仍在浏览器本机处理，MCP 无法读取尚未保存的浏览器状态。调用 `analyze_ad_bulk` 或 `export_ad_changes` 时提供当前基准表的 `headers` 和 `rows`。分析支持 `view="campaigns|skus|targets|placements|portfolios"`。输出的 `rowIndex` 为去掉表头及空行后的 0 基索引。

导出变更使用 `edits=[{rowIndex,field,value}]`，字段为 `bid`、`defaultBid`、`dailyBudget`、`percentage` 或 `state`。字段必须与实体类型匹配，数值、状态、竞价下限和溢价范围均校验；状态按原表中文/英文转换。可用 `negatives` 新建活动或广告组否定，活动和组编号必须属于传入基准表。

生成/导出工具仅返回批量表。亚马逊广告实际变更在人工核对并上传后台后生效。没有加入宠物版的 Listing 或实时广告修改功能，因为 main 墨盒版没有这些业务模块。

品牌 ABA 导入 `files=[{name,text}]`；ASIN 导入支持 CSV 的同样结构或 `{name:"merged.xlsx",sheets:[{name,rows}]}`，二维表保留原 AI/AJ 的 ASIN 与日期来源。单次最多 10 个文件，大小与报告归属按现有接口校验。

ABA 查询的 `query` 可包含 `q`、`brand`、`weeks`、`view`、`wordType`、`model`、`asin`、`skuId`、`year`、`month`、`merge`、`aggregation`、`sort`、`direction`、`page` 和 `pageSize`。`weeks` 为报告结束日期列表或逗号分隔字符串。其他清单使用 `q/offset/limit`，每次最多 500 行，通过 `nextOffset` 继续读取。

## 验证

```bash
npm --prefix server run test:mcp
npm --prefix server test
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
node web/tests/mcp.browser.mjs
```

浏览器测试可通过 `PLAYWRIGHT_MODULE` 指定 Playwright 模块位置，`PLAYWRIGHT_CHANNEL=chrome` 使用本机 Chrome。所有集成测试采用临时数据库，不调用真实亚马逊写接口。OAuth 测试覆盖发现、回调限制、PKCE、授权码单次使用、读写范围、刷新轮换和账号停用；工具测试覆盖私有数据隔离、最新权限、网页接口同值、广告自检与 Excel 导出。

协议依据：[MCP Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
