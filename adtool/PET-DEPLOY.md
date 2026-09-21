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
docker compose up -d --build
```

`data-pet-prod` 必须允许现有 `.env` 的 `APP_UID` / `APP_GID` 写入；如果部署账号与该身份不同，由管理员设置该目录的所有者。原墨盒 `data-prod` 原地保留，宠物不会打开或修改它。原域名现在展示宠物版，墨盒容器被同名宠物服务替换；不会同时运行两个站点。

首次创建宠物管理员（只执行一次）：

```bash
docker compose exec adtool node src/seed.js 用户名 显示名 密码
```

本地账号不自动同步到服务器。打开原域名重新登录；访问 `/api/config` 应看到 `id: "pet"` 和 `markets: ["US"]`。如果原来登录页已打开，刷新页面后再登录。

以后在此分支更新：

```bash
git pull --ff-only origin codex-pet-adaptation
docker compose up -d --build
```

船长凭据使用 `.env` 的 `PET_CAPTAIN_CLIENT_ID` / `PET_CAPTAIN_CLIENT_SECRET`，不继承原墨盒凭据。未配置时该集成不可用。现有 HTTPS、会话密钥及端口配置沿用原 `.env`。

如需恢复墨盒，在工作区干净时切回 `main`，再执行 `docker compose up -d --build`，会重新挂载原 `data-prod`。宠物数据仍保存在 `data-pet-prod`，不删除它。

### 将来独立域名部署（当前不用）

`compose.pet.yml` 和 `.env.pet.example` 保留供未来独立实例部署，默认绑定本机 8081；当前 novagaming 使用上面的默认 Compose 流程即可。

## 后续再定

否定词分类体系、宠物搜索意图判断、款式层级 ABA 汇总、更多宠物品类字段和竞品评分均未推断实现。先用真实报表验证现有字段，再逐项扩展。
