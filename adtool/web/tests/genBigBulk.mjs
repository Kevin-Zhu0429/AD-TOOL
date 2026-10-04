// 生成一份「大」的商品推广批量表,用来复现广告优化导入 / 批量操作卡顿
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';

export function bigBulk({ campaigns = 1500, groups = 2, ads = 8, kws = 15, terms = 150000, skus = 60 } = {}) {
  const H = ['产品', '实体层级', '操作', '广告活动编号', '广告组编号', '广告组合编号', '广告编号', '关键词编号', '商品投放 ID',
    '广告活动名称', '广告组名称', '广告活动名称（仅供参考）', '广告组名称（仅供参考）', '广告组合名称（仅供参考）', '开始日期', '投放类型', '状态',
    '每日预算', 'SKU', 'ASIN（仅供参考）', '广告组默认竞价', '竞价', '关键词文本', '匹配类型', '竞价方案', '广告位', '百分比',
    '展示量', '点击量', '花费', '销量', '订单数量', '商品数量'];
  const ix = Object.fromEntries(H.map((h, i) => [h, i]));
  const rows = [H];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const met = (r) => { const imp = Math.floor(rnd() * 3000), clk = Math.floor(imp * rnd() * 0.02), sp = +(clk * (0.4 + rnd())).toFixed(2), od = Math.floor(clk * rnd() * 0.2);
    r[ix['展示量']] = imp; r[ix['点击量']] = clk; r[ix['花费']] = sp; r[ix['订单数量']] = od; r[ix['商品数量']] = od; r[ix['销量']] = +(od * 29.99).toFixed(2); return r; };
  const row = (o) => { const r = new Array(H.length).fill(null); for (const k in o) r[ix[k]] = o[k]; r[ix['产品']] = '商品推广'; return met(r); };
  const groupIds = [];
  for (let c = 1; c <= campaigns; c++) {
    const cid = String(100000 + c), pf = '组合' + (c % 12);
    rows.push(row({ 实体层级: '广告活动', 广告活动编号: cid, 广告活动名称: 'SP 狗窝 活动 ' + c, '广告组合名称（仅供参考）': pf, 投放类型: c % 3 ? '手动' : '自动', 状态: '已启用', 每日预算: 20, 竞价方案: '动态竞价 - 只降低' }));
    for (const p of ['竞价调整 - 搜索结果顶部（首页）', '竞价调整 - 搜索结果的其余位置', '竞价调整 - 商品页面']) rows.push(row({ 实体层级: '竞价调整', 广告活动编号: cid, 广告位: p.replace('竞价调整 - ', ''), 百分比: 20 }));
    for (let g = 1; g <= groups; g++) {
      const gid = cid + '0' + g; groupIds.push([cid, gid]);
      rows.push(row({ 实体层级: '广告组', 广告活动编号: cid, 广告组编号: gid, 广告组名称: '组 ' + g, 状态: '已启用', 广告组默认竞价: 0.8 }));
      for (let a = 0; a < ads; a++) { const s = (c * 7 + g * 3 + a) % skus;
        rows.push(row({ 实体层级: '商品广告', 广告活动编号: cid, 广告组编号: gid, 广告编号: gid + 'a' + a, '广告组名称（仅供参考）': '组 ' + g, SKU: 'PET-SKU-' + s, 'ASIN（仅供参考）': 'B0PET' + String(s).padStart(5, '0'), 状态: '已启用' })); }
      for (let k = 0; k < kws; k++) rows.push(row({ 实体层级: '关键词', 广告活动编号: cid, 广告组编号: gid, 关键词编号: gid + 'k' + k, 关键词文本: 'dog bed ' + k, 匹配类型: ['精准', '词组', '广泛'][k % 3], 竞价: 0.9, 状态: '已启用' }));
    }
  }
  const SH = ['产品', '广告活动编号', '广告组编号', '关键词编号', '顾客搜索词', '展示量', '点击量', '花费', '销量', '订单数量', '商品数量'];
  const st = [SH];
  for (let t = 0; t < terms; t++) { const [cid, gid] = groupIds[Math.floor(rnd() * groupIds.length)];
    const imp = Math.floor(rnd() * 300), clk = Math.floor(imp * rnd() * 0.05), od = Math.floor(clk * rnd() * 0.3);
    st.push(['商品推广', cid, gid, gid + 'k' + (t % kws), 'dog bed term ' + (t % 20000), imp, clk, +(clk * 0.7).toFixed(2), +(od * 29.99).toFixed(2), od, od]); }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['产品', '实体层级', '广告组合编号', '广告组合名称', '预算的货币代码'], ['广告组合', '广告组合', '1', '组合1', 'USD']]), '广告组合');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '商品推广活动');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(st), '商品推广搜索词报告');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }), rows: rows.length - 1, terms };
}

if (process.argv[2]) {
  const out = bigBulk(JSON.parse(process.argv[3] || '{}'));
  writeFileSync(process.argv[2], out.buffer);
  console.log(process.argv[2], (out.buffer.length / 1048576).toFixed(1) + ' MB', out.rows + ' 行', out.terms + ' 搜索词');
}
