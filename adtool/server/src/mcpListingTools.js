import * as z from 'zod/v4';
import { EDITABLE_ATTRIBUTES } from './listings.js';
import { AMAZON_MARKETPLACES } from './spApi.js';

export function registerListingTools({ tool, api, page }) {
  const name = z.string().trim().min(1).max(200);
  const store = { brand: name, country: z.enum(Object.keys(AMAZON_MARKETPLACES)) };
  const sku = z.string().trim().min(1).max(200);
  const item = { ...store, sku };
  const attributeValue = z.union([z.array(z.record(z.string(), z.unknown())).min(1).max(100), z.null()]);
  const changes = z.partialRecord(z.enum([...EDITABLE_ATTRIBUTES]), attributeValue)
    .refine((value) => Object.keys(value).length > 0, '至少提供一项 Listing 改动')
    .describe('亚马逊属性对象数组；null 删除属性。先读取 get_listing 的 attributes，保留其他站点、语言及 B2B 报价。');
  const fill = z.object({ gdpr_risk: name.optional(), supplier_declared_dg_hz_regulation: name.optional(),
    batteries_required: z.boolean().optional(), country_of_origin: name.optional() }).optional();
  const variation = { ...store, parentSku: sku.optional(), theme: name,
    newParent: z.object({ sku, itemName: z.string().trim().min(1).max(5000), brand: name, category: name.optional() }).optional(),
    children: z.array(z.object({ sku, values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
      z.union([z.string().max(5000), z.number(), z.boolean()])).optional() })).min(1).max(50), fill };
  const writing = { write: true, external: true };
  const live = { ...writing, destructive: true };
  tool('list_listing_stores', '超级管理员查询已配置的 Listing 品牌、站点、卖家编号和正式提交开关，不返回凭证。', {},
    () => api('GET', '/api/listings/stores'));
  tool('get_listing_edit_schema', '超级管理员查看 Listing 可编辑属性、变体补填字段和读写流程。修改前先读取 get_listing。', {}, async () => {
    const status = await api('GET', '/api/listings/stores');
    return { editableAttributes: [...EDITABLE_ATTRIBUTES], valueFormat: '亚马逊属性对象数组；null 删除属性',
      fillAttributes: ['gdpr_risk', 'supplier_declared_dg_hz_regulation', 'batteries_required', 'country_of_origin'],
      liveSubmit: status.liveSubmit,
      notes: ['标题、五点、描述、搜索词、报价(价格/促销日期)和打印页数可修改。',
        'validate 只校验；submit/merge/detach 正式修改亚马逊，校验通过才提交。',
        '新建父体后子体可能校验失败，操作可部分成功；读取返回的 parent/results 后核对，不重复提交已成功项。'] };
  });
  tool('list_listings', '超级管理员查询本地 Listing 缓存，含标题、价格、问题和变体关系；q 搜索，nextOffset 分页。',
    { ...store, q: z.string().max(5000).optional(), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100) }, async (args) => page(await api('GET', '/api/listings/items',
      { brand: args.brand, country: args.country }), args));
  tool('get_listing', '超级管理员读取本地单 SKU Listing 的完整属性、商品类型、问题及报价，不自动刷新亚马逊。', item,
    (args) => api('GET', '/api/listings/item', args));
  tool('refresh_listing', '超级管理员从亚马逊刷新单 SKU 并更新本地缓存；需要 ink:write。', item,
    (args) => api('GET', '/api/listings/item', { ...args, refresh: '1' }), writing);
  tool('pull_listings', '超级管理员启动整店 Listing 拉取并更新本地缓存；随后调用 get_listing_pull 查询进度。', store,
    (args) => api('POST', '/api/listings/pull', args), writing);
  tool('get_listing_pull', '超级管理员查询整店 Listing 拉取的进度、完成数量和失败原因。', store,
    (args) => api('GET', '/api/listings/pull', args));
  for (const [formal, options] of [[false, writing], [true, live]]) {
    tool(formal ? 'submit_listing_changes' : 'validate_listing_changes', formal
      ? '超级管理员正式提交 Listing 改动到亚马逊。先自动校验，失败返回 blocked；ACCEPTED 仅表示接收，刷新确认生效。需 ink:write。'
      : '超级管理员让亚马逊校验 Listing 改动，返回 patches 和 issues；不正式修改线上商品，需 ink:write。',
    { ...item, changes }, (args) => api('POST', '/api/listings/item/submit', { ...args, live: formal }), options);
    tool(formal ? 'merge_listing_variations' : 'validate_listing_variation_merge', formal
      ? '超级管理员正式合并变体，可指定已有 parentSku 或 newParent 新建父体。最多50个子体；新父体可先成功而子体失败，检查 parent/results。需 ink:write。'
      : '超级管理员校验变体合并或新建父体，不正式修改亚马逊。提供 parentSku 或 newParent、theme 和 children；需 ink:write。',
    variation, (args) => api('POST', '/api/listings/variation/merge', { ...args, live: formal }), options);
    tool(formal ? 'detach_listing_variation' : 'validate_listing_variation_detach', formal
      ? '超级管理员将子体正式移出变体家族，先校验再提交；会修改线上关系，需 ink:write。'
      : '超级管理员校验子体移出变体，不正式修改线上关系；需 ink:write。',
    item, (args) => api('POST', '/api/listings/variation/detach', { ...args, live: formal }), options);
  }
}
