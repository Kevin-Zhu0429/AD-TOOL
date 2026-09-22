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

船长凭据使用 `.env` 的 `PET_CAPTAIN_CLIENT_ID` / `PET_CAPTAIN_CLIENT_SECRET`，不继承原墨盒凭据。未配置时该集成不可用。现有 HTTPS、会话密钥及端口配置沿用原 `.env`。

如需恢复墨盒，在工作区干净时切回 `main`，再执行 `docker compose --env-file /etc/amazon-app/app.env up -d --build`，会重新挂载原 `data-prod`。宠物数据仍保存在 `data-pet-prod`，不删除它。

### 将来独立域名部署（当前不用）

`compose.pet.yml` 和 `.env.pet.example` 保留供未来独立实例部署，默认绑定本机 8081；当前 novagaming 使用上面的默认 Compose 流程即可。

## 后续再定

否定词分类体系、宠物搜索意图判断、款式层级 ABA 汇总、更多宠物品类字段和竞品评分均未推断实现。先用真实报表验证现有字段，再逐项扩展。

## 宠物店铺共享数据

宠物版全部已登录账号共享 SKU、库存、广告组合、产品情报及品牌/ASIN ABA 报告，均可导入和维护。业务功能不再逐账号开通；账号管理和系统配置仍由管理员维护，操作日志保留真实操作者。

升级启动时自动事务迁移原账号数据，同一 SKU / 广告组合 / 品牌或 ASIN 周报重复时保留最近更新记录（时间相同按记录编号），原记录与报表明细归档在数据库的 `pet_shared_migration_archive`。共享数据不随个人账号删除。墨盒版维持原账号隔离。

本地广告草稿和广告优化中临时打开的文件仍在当前浏览器内，不属于已保存的服务器业务库，不会自动跨电脑同步。

## 价格策略表与船长同步

宠物版新增店铺共享的价格策略表，支持单行录入、Excel/CSV 导入和导出。第二行 7 个日期列表示所选快照日期及之前 6 天的每日销量。同步使用船长美国站的订单、广告和 FBA 库存接口；每天北京时间 10 时后自动同步前一天，也可在页面手动同步。上次同步时间和错误会显示在页面。

在现有 `/etc/amazon-app/app.env` 中设置 `PET_CAPTAIN_CLIENT_ID` 与 `PET_CAPTAIN_CLIENT_SECRET`，沿用原有 `docker compose --env-file /etc/amazon-app/app.env up -d --build`。这两个值应为宠物店铺已授权的船长 API 凭据。如果船长授权范围内有多个美国站店铺，再设置 `PET_CAPTAIN_CHANNEL_ID` 指向宠物店铺的 `open_channel_id`；未指定时会暂停同步并提示，避免混合店铺数据。不要把真实密钥提交到仓库。当地无凭据时表仍可人工维护。

自动指标：SKU 每日订单件数、当月与近 7 日订单数及销量、近 7 日广告点击和广告订单数、船长可售及在途库存、近 3 日动销值、近 7 日每日动销速度。近 7 日动销取近 7 日销量；有总库存且有销量时，周转周数＝总库存数÷近 7 日销量，预估售罄日按此速度向上取整到天；填入截止上月总销量时，总销量＝该值＋本月销量。转化率使用广告订单数除以广告点击数；7 天环比使用前 7 日销量。原订单的买家字段不会落库。无法准确按 SKU 获取的广告销量及未定义成本口径的利润、费比保留人工维护；`总库存数` 与船长可售库存分开显示。

船长的广告日报是否准时更新，以及订单 `LocalDate` 的实际时区口径，需要用服务器首次同步结果与后台报表核对。调度失败会留状态，不会删除人工录入的价格或利润。

免费版每天 100 次调用，失败请求也计次，并有每分钟频率限制。本应用宠物版每天最多请求 100 次；每次点击同步最多请求 20 次，任意两次请求至少间隔 10 秒。这个计数不包含你在船长后台或其他应用发出的请求。同步在后台运行，页面每 10 秒读取一次本应用状态（不请求船长）。订单和库存先保存，订单、广告清单和日报按页记录进度；当天遇到船长“请求频率过快”后停止重试，次日再运行。

订单和库存读取完成后立即生成基础价格策略行；后续广告请求失败或额度不足不会撤销基础数据。广告清单、广告日报和 FBA 库存都按页缓存游标，下一次从未完成页继续。广告清单和库存每次各查最近 30 天及一个更早的 30 天窗口，旧窗口逐日轮换，约 12 天覆盖之前一年。较久未修改的广告在历史窗口扫到之前可能暂时无法映射 SKU，页面会显示未匹配数量。
