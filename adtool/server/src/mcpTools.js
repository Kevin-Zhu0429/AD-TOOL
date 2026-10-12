import * as z from 'zod/v4';
import * as XLSX from 'xlsx';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db, audit } from './db.js';
import { canRead, publicUser } from './auth.js';
import { MARKETPLACES, LIBS } from './libs.js';
import { MCP_WRITE_SCOPE } from './mcpAuth.js';
import { invokeApi } from './mcpApi.js';
import * as auto from '../../shared/adEngine.js';
import * as manual from '../../shared/manualEngine.js';
import { normLibData, seriesModelGroups } from '../../shared/negLib.js';
import { resolvePortfolio } from '../../shared/portfolioMatch.js';
import * as opt from '../../shared/optCore.js';
import { priceStats, opportunities } from '../../shared/productLogic.js';
import { calculateSkuFee, AGE_BUCKETS, MARKET_RATES } from '../../shared/agedStorageFee.js';
import { buildDModelIndex, campaignModelContext, detectModelDrift, driftPresentation } from '../../shared/modelDrift.js';

const market = z.enum(MARKETPLACES).describe('亚马逊站点码');
const id = z.number().int().positive();
const text = z.string().max(5000);
const record = z.record(z.string(), z.unknown());
const ids = z.array(id).min(1).max(5000);
const rows = z.array(record).min(1).max(20000);
const paging = { q: text.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) };
const changes = record.describe('修改字段，字段名称与网站 API 一致');
const query = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])).optional();
const lib = z.enum(['A', 'B', 'C', 'D', 'E']);
const sourceFile = z.string().max(255).optional();
const dataMonth = z.string().regex(/^\d{4}-\d{2}$/);
const skuRow = z.object({ country: market, sku: z.string().min(1).max(120), brand: text.optional(), model: text.optional(),
  setGroup: text.optional(), asin: z.string().optional(), stock: z.union([z.number(), z.string()]).optional(), transit: z.union([z.number(), z.string()]).optional() });
const reportFiles = z.array(z.object({ name: z.string().max(255), text: z.string().optional(),
  sheets: z.array(z.object({ name: z.string().optional(), rows: z.array(z.array(z.unknown())) })).optional() })).min(1).max(10);
const units = z.object({ on: z.boolean(), bid: z.union([z.number(), z.string()]).optional(), text: z.string().max(200000).default('') });
const negatives = { libUse: z.object({ A: z.boolean(), B: z.boolean(), C: z.boolean(), D: z.boolean(), E: z.boolean() }).optional(),
  adType: z.enum(['mixed', 'series']).optional(), seriesModels: z.array(z.string()).max(100).optional(), seriesScope: z.enum(['both', 'models', 'printers']).optional(),
  extraNeg: z.object({ negExact: text.optional(), negPhrase: text.optional(), cnegExact: text.optional(), cnegPhrase: text.optional(), negAsin: text.optional() }).optional() };
const taskBase = { skus: z.string().min(1).max(100000), portfolio: text.optional(), portfolioMode: z.enum(['auto', 'manual']).optional(),
  date: z.string().regex(/^\d{8}$/).optional(), budget: z.number().positive().optional(), defBid: z.number().min(0.02).optional(),
  baseBid: z.number().positive().optional(), rounding: z.enum(['round', 'trunc']).optional(),
  coefs: z.object({ TOS: z.number().positive(), ROS: z.number().positive(), PP: z.number().positive() }).optional(), ...negatives };
const autoTask = z.object({ ...taskBase, mode: z.enum(['wf', 'combo']).optional(), places: z.array(z.enum(auto.ORDER)).optional(),
  tiers: text.optional(), combos: text.optional(), autoTypes: z.array(z.enum(auto.AUTO_TYPES.map((x) => x[0]))).min(1).optional(),
  strategies: z.array(z.enum(auto.STRATEGIES.map((x) => x.id))).min(1).optional(), prefix: text.optional(), sep: text.optional(),
  autoLang: z.enum(['en', 'zh']).optional(), idleBid: z.number().min(0.02).optional(),
  tokens: z.array(z.object({ id: z.enum(auto.NAME_TOKENS.map((x) => x.id)), on: z.boolean() })).optional() });
const manualTask = z.object({ ...taskBase, camp: z.string().min(1).max(128), group: text.optional(), mode: z.enum(['kw', 'tgt']).optional(),
  splitGroup: z.boolean().optional(), strategy: z.enum(manual.MANUAL_STRATEGIES.map((x) => x.id)).optional(), bidMode: z.enum(['bid', 'cpc']).optional(),
  places: z.object({ TOS: z.number().min(0).max(900).optional(), ROS: z.number().min(0).max(900).optional(), PP: z.number().min(0).max(900).optional() }).optional(),
  kw: z.object(Object.fromEntries(manual.MATCH_TYPES.map((x) => [x.id, units.optional()]))).optional(),
  kwTriple: z.boolean().optional(), kwShared: z.string().max(200000).optional(),
  tgt: z.object(Object.fromEntries(manual.TARGET_TYPES.map((x) => [x.id, units.optional()]))).optional() });

function page(data, args, key = 'items') {
  const all = data[key] ?? [];
  const q = String(args.q ?? '').trim().toLowerCase();
  const filtered = q ? all.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(q))) : all;
  const offset = args.offset ?? 0, limit = args.limit ?? 100;
  return { ...data, [key]: filtered.slice(offset, offset + limit), total: filtered.length,
    offset, limit, nextOffset: offset + limit < filtered.length ? offset + limit : null };
}
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()).replaceAll('-', '');
function defaults(input, type) {
  const base = { portfolio: '', portfolioMode: 'auto', date: today(), budget: 1.2, defBid: type === 'auto' ? 0.02 : 0.3,
    baseBid: 0.36, rounding: 'round', coefs: { TOS: 2, ROS: 1.5, PP: 1.5 },
    extraNeg: {}, libUse: { A: true, B: true, C: true, D: true, E: false }, adType: 'mixed', seriesModels: [], seriesScope: 'both' };
  const config = type === 'auto' ? { mode: 'wf', places: [], tiers: '', autoTypes: ['Close'], strategies: ['down_zh'],
    prefix: '全店铺_SP_Auto', sep: '_', autoLang: 'en', idleBid: 0.02, tokens: auto.NAME_TOKENS.map((x) => ({ ...x, on: x.id !== 'bid' })) }
    : { group: '', strategy: 'down', places: {}, bidMode: 'bid', mode: 'kw', splitGroup: false,
      kw: Object.fromEntries(manual.MATCH_TYPES.map((x) => [x.id, { on: false, bid: '', text: '' }])),
      tgt: Object.fromEntries(manual.TARGET_TYPES.map((x) => [x.id, { on: false, bid: '', text: '' }])) };
  return { ...base, ...config, ...input, kw: { ...config.kw, ...input.kw }, tgt: { ...config.tgt, ...input.tgt } };
}
export function workbookResult(aoa, sheet, format = 'rows', filename = '广告批量表.xlsx') {
  if (aoa.length > 20001) throw new Error('单次生成最多 20000 行，请拆分任务');
  if (format === 'rows') return { sheet, headers: aoa[0], rows: aoa.slice(1), rowCount: aoa.length - 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return { filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }), rowCount: aoa.length - 1 };
}

export function createInkMcpServer({ authInfo, siteUrl = '' } = {}) {
  const server = new McpServer({ name: 'adtool-ink', version: '1.0.0' }, { instructions:
    '墨盒广告工作台。先用 workspace_overview 确认账号、站点和权限。私有报告、SKU 和组合归当前授权账号；公共 ABA 和仓储费为共享数据。写工具要求 ink:write。广告工具生成批量文件，需上传亚马逊后台才生效。浏览器未保存的优化表不能直接读取，调用时提供表头和行数据。分页查询请继续 nextOffset/page。' });
  function user() {
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(authInfo?.extra?.userId);
    if (!row?.is_active) throw new Error('账号不存在或已停用，请重新授权');
    return publicUser(row);
  }
  const api = (method, path, args) => invokeApi(user().id, method, path, args);
  const ensureMarket = (mk) => { if (!canRead(user(), mk)) throw new Error('无权访问该站点'); };
  function tool(name, description, schema, handler, { write = false, destructive = false, external = false } = {}) {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write,
      destructiveHint: destructive, idempotentHint: !write, openWorldHint: external } }, async (args) => {
      try {
        user();
        if (write && !authInfo?.scopes?.includes(MCP_WRITE_SCOPE)) throw new Error('当前是只读授权，此工具需要 ink:write；请重新连接并选择读写授权');
        const data = await handler(args);
        if (write) audit(user().id, args.marketplace ?? null, 'mcp_call', 'mcp_tool', null, { name });
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
    });
  }
  function route(name, description, schema, method, path, options = {}, transform) {
    tool(name, description, schema, async (args) => {
      const { q: _q, offset: _offset, limit: _limit, query: params, id: rowId, ...body } = args;
      const url = path.replace(':id', String(rowId)).replace(':asin', encodeURIComponent(args.asin ?? ''));
      const data = await api(method, url, { ...params, ...body });
      return transform ? transform(data, args) : data;
    }, { write: method !== 'GET', ...options });
  }

  tool('workspace_overview', '查看墨盒工作台账号、权限、站点、各模块工具及数据归属。', {}, async () => ({
    user: user(), siteUrl, scopes: authInfo?.scopes ?? [], markets: MARKETPLACES, libraries: LIBS,
    notes: ['SKU、组合、私有 ABA 按授权账号隔离；owner 可显式读取全部 SKU，但只能编辑自己的 SKU。',
      '公共 ABA 和超龄仓储费共享。广告批量表需另行上传亚马逊后台。库存 stock 为可用+转运+接收，transit 为处理中+已发货。'] }));
  route('list_skus', '查询本人 SKU、墨盒型号、套组、ASIN、在库/在途库存及断货补货记录。owner 可用 scope=all 只读查看全账号。',
    { marketplace: market.optional(), scope: z.enum(['mine', 'all']).default('mine'), ...paging }, 'GET', '/api/sku', {}, page);
  route('import_skus', '批量新增/更新本人 SKU。replace 清除本批有效行涉及国家的旧数据；未提供 ASIN 时保留已有关联。',
    { rows: z.array(skuRow).min(1).max(20000), replace: z.boolean().default(false) }, 'POST', '/api/sku/rows', { destructive: true });
  route('update_sku', '编辑本人 SKU 行，无法修改其他账号的行。', { id, ...Object.fromEntries(Object.entries(skuRow.shape).map(([k, v]) => [k, v.optional()])) }, 'PATCH', '/api/sku/:id');
  route('delete_skus', '永久删除本人 SKU 行；传入 list_skus 返回的记录 id。', { ids }, 'POST', '/api/sku/delete', { destructive: true });
  route('list_portfolios', '查询当前账号与站点的广告组合库。', { marketplace: market, ...paging }, 'GET', '/api/portfolio', {}, page);
  route('import_portfolios', '导入两列广告组合；相同 portfolioId 更新名称，replace 只清当前账号当前站点。',
    { marketplace: market, rows: z.array(z.object({ portfolioId: z.string().min(1), name: z.string().min(1).max(200) })).min(1).max(5000), replace: z.boolean().default(false) }, 'POST', '/api/portfolio/rows', { destructive: true });
  route('update_portfolio', '编辑本人广告组合编号及名称。', { id, portfolioId: text.optional(), name: text.optional() }, 'PATCH', '/api/portfolio/:id');
  route('delete_portfolios', '删除本人广告组合记录。', { ids }, 'POST', '/api/portfolio/delete', { destructive: true });
  tool('match_portfolio', '按 SKU 库墨盒系列匹配 Series 或混投组合；缺资料或有多个候选时返回原因，不猜测。',
    { marketplace: market, skus: z.string().min(1) }, async (args) => {
      const skus = await api('GET', '/api/sku', { marketplace: args.marketplace });
      const portfolios = await api('GET', '/api/portfolio', { marketplace: args.marketplace });
      return resolvePortfolio(args.skus, skus.items, portfolios.items);
    });
  tool('get_negative_library', '查询站点 A–E 词库、区域覆盖及套用配置。可指定 lib 和 q，结果按类别分页。',
    { marketplace: market, lib: lib.optional(), ...paging }, async (args) => {
      const data = await api('GET', '/api/neg', { marketplace: args.marketplace });
      const categories = args.lib ? [args.lib] : Object.keys(data.items);
      const pages = Object.fromEntries(categories.map((key) => [key, page({ items: data.items[key] }, args)]));
      return { ...data, items: Object.fromEntries(categories.map((key) => [key, pages[key].items])), pagination: pages };
    });
  route('import_negative_library', '维护 A–E 结构化词库；A 需站点维护权，B/C/D/E 需商品部权。replace 会清除整类区域/站点数据。',
    { marketplace: market, lib, rows, replace: z.boolean().default(false) }, 'POST', '/api/neg/rows', { destructive: true });
  route('update_negative_entry', '编辑词库行，沿用词库维护权限。', { id, term: text.optional(), brand: text.optional(), series: text.optional(), printer: text.optional(), asin: text.optional(), note: text.optional() }, 'PATCH', '/api/neg/:id');
  route('delete_negative_entries', '永久删除有维护权的词库行。区域库删除影响区域全部站点。', { ids }, 'POST', '/api/neg/delete', { destructive: true });
  route('configure_negative_library', '设置站点广告生成时词库启用、否定匹配方式和活动/组级范围；需该站点维护权。',
    { marketplace: market, lib, enabled: z.boolean().optional(), matchType: z.enum(['否定精准', '否定词组', '']).optional(), level: z.enum(['camp', 'group']).optional() }, 'POST', '/api/neg/config');
  tool('plan_negatives', '按混合/系列广告和当前站点词库推导否定关键词、打印机型号与竞品 ASIN。',
    { marketplace: market, ...negatives }, async (args) => auto.buildNegatives(normLibData(await api('GET', '/api/neg', { marketplace: args.marketplace })), defaults(args, 'auto')));
  tool('list_cartridge_series', '查看 D 库墨盒系列及相关打印机型号，供系列广告和否定方案选型。', { marketplace: market }, async (args) => ({
    groups: seriesModelGroups(normLibData(await api('GET', '/api/neg', args))) }));
  route('list_products', '查询指定站点和月份的产品情报，需产品情报使用权；返回产品和站点设置。',
    { marketplace: market, dataMonth: dataMonth.optional(), ...paging }, 'GET', '/api/products', {}, (data, args) => page(data, args, 'products'));
  route('import_products', '按站点和数据月份导入产品，保留人工修改的品牌和套组。',
    { marketplace: market, dataMonth, sourceFile, products: rows }, 'POST', '/api/products/import');
  route('import_products_all_markets', '全市场月度产品导入；先校验全部国家与权限再写入。',
    { dataMonth, sourceFile, productsByMarketplace: z.partialRecord(market, rows) }, 'POST', '/api/products/import-all');
  route('update_product', '编辑产品资料；changes 支持品牌、墨盒型号、套组、价格、评价、销量、BSR、标题等。',
    { marketplace: market, dataMonth: dataMonth.optional(), asin: z.string().min(1), changes }, 'PATCH', '/api/products/:asin');
  route('delete_products', '删除当前站点月份指定 ASIN 的产品情报。', { marketplace: market, dataMonth: dataMonth.optional(), asins: z.array(z.string()).min(1).max(5000) }, 'POST', '/api/products/delete', { destructive: true });
  route('delete_product_month', '永久删除某站点整月产品资料。', { marketplace: market, dataMonth }, 'POST', '/api/products/delete-month', { destructive: true });
  route('configure_product_intel', '设置本站自有品牌与竞品最低销量门槛。', { marketplace: market, ownBrand: text, minSales: z.number().min(0).max(10000000) }, 'POST', '/api/products/settings');
  tool('analyze_competitors', '按墨盒型号与颜色套组筛选产品，计算价格统计和竞争机会，沿用网页分析口径。',
    { marketplace: market, dataMonth: dataMonth.optional(), model: text.optional(), colorGroup: text.optional(), ownBrand: text.optional(), ...paging }, async (args) => {
      const data = await api('GET', '/api/products', args);
      const items = (data.products ?? []).filter((x) => (!args.model || String(x.model).toLowerCase() === args.model.toLowerCase()) && (!args.colorGroup || x.color_grp === args.colorGroup));
      const own = args.ownBrand || data.settings?.own_brand || '';
      const mine = items.filter((x) => String(x.brand).toLowerCase() === own.toLowerCase());
      return page({ items, stats: priceStats(items), opportunities: mine.map((product) => ({ asin: product.asin,
        competitors: opportunities(items, product, data.settings?.min_sales ?? 100).slice(0, args.limit) })) }, args);
    });
  for (const [name, path, label] of [['get_aba_brand', '/api/aba', '本人品牌'], ['get_aba_asin', '/api/aba/asin', '本人 ASIN'], ['get_public_aba', '/api/aba-public/asin', '公共 ASIN']]) {
    route(name, `查询${label} ABA 周报、搜索词和机型分类。query 支持 brand、weeks(结束日期逗号分隔)、q、view=queries/printers、wordType=all/printer/cartridge、model、asin、skuId、year、month、aggregation=sum/average、merge=0/1、sort、direction、page、pageSize。分页不影响全量汇总。`,
      { marketplace: market, query }, 'GET', path);
  }
  route('import_aba_brand', '导入本人品牌搜索查询 CSV 周报，同账号/品牌/周重传更新；files 为 name+text。', { marketplace: market, files: reportFiles }, 'POST', '/api/aba/import');
  route('import_aba_asin', '导入本人 ASIN CSV 或已解析的 XLSX；files 为 name+text 或 name+sheets，sheets 为 name+rows二维数组，沿用现有校验。', { marketplace: market, files: reportFiles }, 'POST', '/api/aba/asin/import');
  route('get_public_aba_sync_status', '查看公共 ABA 同步队列、阶段、批次和失败信息。', {}, 'GET', '/api/aba-public/status');
  route('sync_public_aba', '启动公共 ABA SP-API 同步，需 owner；返回任务进度，随后查询状态。', {}, 'POST', '/api/aba-public/sync', { external: true });
  route('get_inventory_status', '查看本人亚马逊库存分配与最近同步结果。', {}, 'GET', '/api/captain/status');
  route('get_inventory_admin', 'owner 查看库存配置完整性、店铺分配和 SKU 覆盖，不返回凭证。', {}, 'GET', '/api/captain/admin');
  route('discover_amazon_shops', 'owner 从亚马逊读取店铺和欧洲共享库存组。', {}, 'POST', '/api/captain/discover', { external: true });
  route('save_inventory_bindings', 'owner 保存品牌、店铺组和各国家负责账号。字段格式沿用库存管理 API。',
    { brand: text, groupName: text, groupKey: text, scope: z.enum(['EU', ...MARKETPLACES]),
      channels: z.array(z.object({ country: market, openChannelId: text, channelName: text, siteId: z.number().optional() })).min(1).max(50),
      assignments: z.array(z.object({ country: market, userId: id })).min(1).max(50) }, 'POST', '/api/captain/bindings');
  route('update_inventory_assignment', 'owner 修改库存国家分配的启用状态。', { id, enabled: z.boolean() }, 'PATCH', '/api/captain/assignments/:id');
  route('update_inventory_binding', 'owner 修改库存绑定的启用状态。', { id, enabled: z.boolean() }, 'PATCH', '/api/captain/bindings/:id');
  for (const [suffix, path] of [['', 'sync'], ['_all', 'sync-all']]) {
    route(`sync_inventory${suffix}`, `启动${suffix ? '所有账号（owner）' : '本人'}库存同步；同步仅更新已有匹配 SKU 的库存并记录断货补货。`, {}, 'POST', `/api/captain/${path}`, { external: true });
    route(`get_inventory_sync${suffix}`, '查询库存同步后台任务的真实进度与结果。', {}, 'GET', `/api/captain/${path}`);
  }
  route('get_aged_storage_fees', '读取共享超龄仓储费批次与计算结果。', { batchId: id.optional(), ...paging }, 'GET', '/api/aged-fees', {}, (data, args) => page(data, args, 'rows'));
  route('import_aged_inventory', '导入共享库龄库存并计算超龄仓储费。rows 为与库存表表头一致的对象；日期 YYYY-MM-DD。',
    { rows, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), scenario: z.enum(['uniform', 'youngest', 'oldest']).default('uniform'), sourceFile }, 'POST', '/api/aged-fees/import');
  route('correct_aged_sales', '修正共享仓储费记录日销；必须提交读取时的 revision，冲突时刷新重试。',
    { id, special: z.boolean(), value: z.number().positive().nullable(), reason: z.string().max(500), revision: z.number().int().min(0) }, 'PATCH', '/api/aged-fees/rows/:id');
  tool('calculate_aged_storage_fee', '按网站现有费率、每月15日快照和先进先出计算单 SKU 超龄仓储费。只计算，不保存。',
    { marketplace: market, buckets: z.array(z.number().min(0)).length(8).describe('依次为0-30、31-60、61-90、91-180、181-270、271-365、366-455、>456天数量'), dailySales: z.number().positive(), date: z.string(), scenario: z.enum(['uniform', 'youngest', 'oldest']).default('uniform') },
    async (args) => ({ result: calculateSkuFee(args.buckets, args.dailySales, args.date, args.marketplace, args.scenario), ageBuckets: AGE_BUCKETS, rates: MARKET_RATES }));
  route('list_users', 'owner 查询网站账号、负责站点和试用功能权限。', {}, 'GET', '/api/auth/users');
  route('create_user', 'owner 创建网站账号并分配角色、站点与模块使用权。',
    { username: z.string().min(1), displayName: z.string().min(1), password: z.string().min(6), role: z.enum(['owner', 'admin', 'operator']), markets: z.array(market).optional(), goodsAdmin: z.boolean().optional(), manualAds: z.boolean().optional(), adOpt: z.boolean().optional(), productIntel: z.boolean().optional() }, 'POST', '/api/auth/users');
  route('update_user', 'owner 更新账号权限/状态；网站禁止停用自己或修改自己的角色。',
    { id, displayName: text.optional(), role: z.enum(['owner', 'admin', 'operator']).optional(), markets: z.array(market).optional(), isActive: z.boolean().optional(), goodsAdmin: z.boolean().optional(), manualAds: z.boolean().optional(), adOpt: z.boolean().optional(), productIntel: z.boolean().optional() }, 'PATCH', '/api/auth/users/:id');
  route('delete_user', 'owner 永久删除其他账号及其私有 SKU、ABA、组合和库存分配；共享资料与日志保留。', { id }, 'DELETE', '/api/auth/users/:id', { destructive: true });
  route('get_audit_log', 'owner 查询操作统计和日志；query 支持 userId/action/entity/days/from/to/before/limit。', { query }, 'GET', '/api/auth/audit');
  tool('get_ad_templates', '查询自动和手动广告任务字段、默认值、投放类型、匹配方式、竞价策略和批量表表头。', {}, async () => ({
    auto: defaults({ skus: '' }, 'auto'), manual: defaults({ camp: '', skus: '' }, 'manual'),
    autoTypes: auto.AUTO_TYPES, autoStrategies: auto.STRATEGIES, manualStrategies: manual.MANUAL_STRATEGIES,
    matchTypes: manual.MATCH_TYPES, targetTypes: manual.TARGET_TYPES, placements: auto.PLACEMENTS, headers: auto.HEADERS }));
  tool('calculate_ad_bid', '按目标 CPC、溢价和竞价策略反推出价，并展示各广告位落地 CPC。沿用网页的最贵广告位口径。',
    { targetCpc: z.number().positive(), strategy: z.enum(['down', 'updown', 'fixed']).default('down'),
      places: z.object({ TOS: z.number().min(0).max(900), ROS: z.number().min(0).max(900), PP: z.number().min(0).max(900) }),
      coefs: z.object({ TOS: z.number().positive(), ROS: z.number().positive(), PP: z.number().positive() }).optional(), rounding: z.enum(['round', 'trunc']).default('round') }, async (args) => {
        const factors = manual.placeFactors(args.places, args.strategy, args.coefs ?? manual.DEFAULT_COEFS);
        const { factor, driver } = manual.topFactor(factors), bid = manual.bidFromCpc(args.targetCpc, factor, args.rounding);
        if (bid < auto.MIN_BID) throw new Error('反推出价低于亚马逊最低 0.02，请提高目标 CPC 或降低溢价');
        return { bid, factor, driver, landing: manual.landedCpc(bid, factors) };
      });
  tool('check_model_drift', '按当前账号 SKU 投放型号与区域 D 库判断搜索词是否跑偏，返回候选机型、墨盒和具体原因；资料不足时不猜测。',
    { marketplace: market, skus: z.array(z.string()).min(1).max(500), searchTerms: z.array(z.string().min(1).max(1000)).min(1).max(500) }, async (args) => {
      if (!user().adOpt) throw new Error('没有广告优化使用权');
      const index = buildDModelIndex(normLibData(await api('GET', '/api/neg', { marketplace: args.marketplace })));
      const skuData = await api('GET', '/api/sku', { marketplace: args.marketplace });
      const context = campaignModelContext({ ads: args.skus.map((sku) => ({ sku })) }, skuData.items, index);
      return { models: context.models, incomplete: context.incomplete, unknownSkus: context.unknownSkus, unmappedModels: context.unmappedModels,
        items: args.searchTerms.map((term) => { const result = detectModelDrift(term, context, index); return { term, ...result, presentation: driftPresentation(result) }; }) };
    });

  for (const type of ['auto', 'manual']) {
    tool(`generate_${type}_ads`, `生成${type === 'auto' ? '自动' : '手动'}广告批量表。复用网站引擎、词库和三道自检。format=rows 返回表头/行；xlsx 返回文件名与 Base64。portfolioMode=auto 时匹配当前账号广告组合；无法匹配须改成 manual 并明确 portfolio。最多20任务/20000行。`,
      { marketplace: market, tasks: z.array(type === 'auto' ? autoTask : manualTask).min(1).max(20), format: z.enum(['rows', 'xlsx']).default('rows'), existingNames: z.array(z.string()).max(5000).optional() }, async (args) => {
        ensureMarket(args.marketplace);
        if (type === 'manual' && !user().manualAds) throw new Error('没有手动广告使用权');
        const library = normLibData(await api('GET', '/api/neg', { marketplace: args.marketplace }));
        const skus = await api('GET', '/api/sku', { marketplace: args.marketplace });
        const portfolios = await api('GET', '/api/portfolio', { marketplace: args.marketplace });
        const plans = args.tasks.map((input) => {
          const task = defaults(input, type);
          const date = new Date(`${task.date.slice(0, 4)}-${task.date.slice(4, 6)}-${task.date.slice(6, 8)}T00:00:00Z`);
          if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10).replaceAll('-', '') !== task.date) throw new Error('开始日期不是有效日期');
          const matched = resolvePortfolio(task.skus, skus.items, portfolios.items);
          if (task.portfolioMode === 'auto') task.portfolio = matched.portfolioId;
          const neg = auto.buildNegatives(library, task);
          const plan = type === 'auto' ? auto.buildTaskPlan(task, neg) : manual.buildManualPlan(task, neg);
          if (type === 'auto') for (const campaign of plan.campaigns) {
            if (campaign.name.length > 128) plan.problems.push('广告活动名称不能超过128字符');
            if (!Number.isFinite(campaign.bid)) plan.problems.push('折算后的竞价不是有效数字');
            if (Object.values(campaign.prem).some((value) => !Number.isInteger(value) || value < 0 || value > 900)) plan.problems.push('广告位溢价必须是0–900的整数');
          }
          if (task.portfolioMode === 'auto' && matched.status !== 'matched') plan.problems.push(matched.message);
          return { task, plan };
        });
        const problems = plans.flatMap(({ plan }, index) => plan.problems.map((problem) => `任务${index + 1}：${problem}`));
        if (problems.length) throw new Error(problems.join('；'));
        const estimated = plans.reduce((sum, { plan }) => sum + (type === 'auto' ? plan.campaigns.length * (plan.blockRows + 1) : plan.rows + 1), 0);
        if (estimated > 20000) throw new Error('单次生成最多20000行，请减少任务或溢价组合');
        const result = type === 'auto' ? auto.buildWorkbookData(plans, new Set(args.existingNames ?? [])) : manual.buildManualWorkbookData(plans);
        if (result.bad.length) throw new Error(result.bad.join('；'));
        return { ...workbookResult(result.aoa, auto.SHEET, args.format, `${args.marketplace}_${type}_ads.xlsx`), warnings: plans.flatMap(({ plan }) => plan.warnings ?? []),
          notes: ['批量表尚未上传亚马逊，下载核对后通过后台批量操作上传。'] };
      });
  }
  const bulkInput = { marketplace: market, headers: z.array(z.string()).min(3).max(200), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(20000) };
  function bulkModel(args) {
    ensureMarket(args.marketplace);
    if (!user().adOpt) throw new Error('没有广告优化使用权');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([args.headers, ...args.rows]), auto.SHEET);
    return opt.parse(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), XLSX);
  }
  tool('analyze_ad_bulk', '分析传入的广告批量表数据，返回总指标、活动及异常原因。rowIndex 为去掉表头和空行后的0基行号，供导出变更。',
    { ...bulkInput, view: z.enum(['campaigns', 'skus', 'targets', 'placements', 'portfolios']).default('campaigns'), ...paging }, async (args) => {
      const model = bulkModel(args);
      const entities = args.view === 'skus' ? 'ads' : args.view === 'targets' ? 'targets' : args.view === 'placements' ? 'placements' : null;
      let items;
      if (entities) {
        const grouped = new Map();
        for (const cp of model.campaigns) for (const item of cp[entities]) {
          const key = entities === 'ads' ? item.sku : entities === 'targets' ? `${item.text}|${item.matchType}` : item.key;
          const group = grouped.get(key) ?? { key, label: item.sku || item.text || item.label, metrics: [], entities: [] };
          group.metrics.push(item.m); group.entities.push({ campaignId: cp.id, campaignName: cp.name, rowIndex: item.row.i, id: item.id, state: item.state });
          grouped.set(key, group);
        }
        items = [...grouped.values()].map((group) => ({ ...group, metrics: opt.sumMetrics(group.metrics) }));
      } else if (args.view === 'portfolios') {
        const groups = new Map();
        for (const cp of model.campaigns) {
          const key = cp.row?.d[model.colIdx.portfolioId] || cp.portfolio || '未分配';
          const group = groups.get(key) ?? { id: key, name: cp.portfolio, campaigns: [], metrics: [] };
          group.campaigns.push(cp.id); group.metrics.push(cp.m); groups.set(key, group);
        }
        items = [...groups.values()].map((group) => ({ ...group, metrics: opt.sumMetrics(group.metrics) }));
      } else items = model.campaigns.map((cp) => ({ id: cp.id, name: cp.name, state: cp.state, metrics: cp.m,
        entities: [...cp.ads, ...cp.targets, ...cp.placements, ...cp.adGroups, ...cp.negatives].map((item) => ({ ...item, row: undefined, rowIndex: item.row.i })) }));
      items = items.map((item) => ({ ...item, flags: opt.flagsFor(args.view, item.metrics, {}, opt.DEFAULT_CFG) }));
      return page({ items, view: args.view, totals: opt.totals(model), rowCount: model.rows.length, rows: model.rows.map((r) => ({ rowIndex: r.i, kind: r.kind })) }, args);
    });
  tool('export_ad_changes', '在传入的基准批量表上验证并导出改动行；仅允许竞价、预算、溢价和状态。生成表不直接修改亚马逊。',
    { ...bulkInput, edits: z.array(z.object({ rowIndex: z.number().int().min(0), field: z.enum(['bid', 'defaultBid', 'dailyBudget', 'percentage', 'state']), value: z.union([z.number(), z.string()]) })).max(5000).default([]),
      negatives: z.array(z.object({ kind: z.enum(['negKeyword', 'campNegKw', 'negTarget']), campaignId: z.string().min(1), adGroupId: z.string().optional(),
        text: z.string().min(1).max(80), match: z.enum(['exact', 'phrase']).optional() })).max(5000).optional(), format: z.enum(['rows', 'xlsx']).default('rows') }, async (args) => {
        const model = bulkModel(args), changeSet = new opt.ChangeSet();
        for (const edit of args.edits) {
          const row = model.rows[edit.rowIndex], column = model.colIdx[edit.field];
          if (!row || column === undefined || column < 0) throw new Error('变更行或字段不存在');
          const allowed = { bid: ['keyword', 'target'], defaultBid: ['adGroup'], dailyBudget: ['campaign'], percentage: ['bidAdj'], state: ['campaign', 'adGroup', 'productAd', 'keyword', 'target', 'negKeyword', 'campNegKw', 'negTarget'] };
          if (!allowed[edit.field].includes(row.kind)) throw new Error('该实体不支持修改此字段');
          if (edit.field === 'state' && !['enabled', 'paused', 'archived'].includes(opt.normState(edit.value))) throw new Error('状态值不合法');
          if (edit.field !== 'state' && (typeof edit.value !== 'number' || !Number.isFinite(edit.value))) throw new Error('竞价、预算和溢价必须是有效数字');
          const value = edit.field === 'state' ? opt.VOCAB[model.lang].state[opt.normState(edit.value)] : edit.value;
          changeSet.set(edit.rowIndex, column, row.d[column], value, edit.field);
        }
        for (const negative of args.negatives ?? []) {
          const campaign = model.campaigns.find((cp) => cp.id === negative.campaignId);
          if (!campaign) throw new Error('否定词广告活动编号不在基准表中');
          if (negative.kind !== 'campNegKw' && !campaign.adGroups.some((group) => group.id === negative.adGroupId)) throw new Error('否定词广告组编号不在对应活动中');
          changeSet.addNegative(negative);
        }
        const issues = opt.validate(model, changeSet);
        const errors = issues.filter((issue) => issue.level === 'error');
        if (errors.length) throw new Error(errors.map((issue) => issue.text).join('；'));
        if (!changeSet.count()) throw new Error('没有需要导出的改动');
        return { ...workbookResult([model.header, ...opt.buildExportRows(model, changeSet)], auto.SHEET, args.format, `${args.marketplace}_ad_changes.xlsx`),
          changes: opt.changeList(model, changeSet), warnings: issues.filter((issue) => issue.level !== 'error') };
      });
  return server;
}
