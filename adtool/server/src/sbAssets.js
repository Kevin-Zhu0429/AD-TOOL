import express from 'express';
import { db, audit } from './db.js';
import { canManualAds, canRead, canWrite, requireLogin } from './auth.js';
import { MARKETPLACES } from './libs.js';

/**
 * 品牌推广(SB)素材:品牌实体编号、徽标、视频。
 * 浏览器把后台下载的 SB 批量表解析好,只把这几样传上来,按站点整份覆盖,同站点共用。
 */
export const sbAssetsRouter = express.Router();
sbAssetsRouter.use(requireLogin);

const MAX_ITEMS = 500;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function marketplace(req, res, write = false) {
  const user = req.session.user;
  if (!canManualAds(user)) {
    res.status(403).json({ error: '没有手动 / 品牌广告使用权' });
    return '';
  }
  const value = String(req.query.marketplace ?? req.body?.marketplace ?? '').trim().toUpperCase();
  if (!MARKETPLACES.includes(value)) {
    res.status(400).json({ error: '站点不合法' });
    return '';
  }
  if (!(write ? canWrite(user, value) : canRead(user, value))) {
    res.status(403).json({ error: `没有 ${value} 站的访问权限` });
    return '';
  }
  return value;
}

function asset(raw) {
  const assetId = text(raw?.assetId, 200);
  if (!assetId) return null;
  const out = { assetId, name: text(raw?.name, 200), url: text(raw?.url, 500), entityId: text(raw?.entityId, 60) };
  const crop = text(raw?.crop, 200);
  if (crop) out.crop = crop;
  return out;
}

/** 只留认识的字段,防止把整张表或别的东西塞进来 */
export function normAssets(input) {
  const brands = (Array.isArray(input?.brands) ? input.brands : [])
    .map((b) => ({ entityId: text(b?.entityId, 60), name: text(b?.name, 120) }))
    .filter((b) => /^ENTITY[A-Z0-9]+$/i.test(b.entityId));
  const logos = (Array.isArray(input?.logos) ? input.logos : []).map(asset).filter(Boolean);
  const videos = (Array.isArray(input?.videos) ? input.videos : []).map(asset).filter(Boolean);
  if (!brands.length) return { error: '没有品牌实体编号' };
  if (brands.length > 50 || logos.length > MAX_ITEMS || videos.length > MAX_ITEMS) return { error: '素材数量太多' };
  return { data: { brands, logos, videos } };
}

sbAssetsRouter.get('/', (req, res) => {
  const mk = marketplace(req, res);
  if (!mk) return;
  const row = db.prepare(
    `SELECT a.data, a.file_name AS fileName, a.updated_at AS updatedAt, u.display_name AS uploadedBy
       FROM sb_brand_assets a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.marketplace = ?`
  ).get(mk);
  if (!row) return res.json({ marketplace: mk, data: null });
  res.json({ marketplace: mk, data: JSON.parse(row.data), fileName: row.fileName, updatedAt: row.updatedAt, uploadedBy: row.uploadedBy });
});

sbAssetsRouter.post('/', (req, res) => {
  const mk = marketplace(req, res, true);
  if (!mk) return;
  const result = normAssets(req.body?.data);
  if (result.error) return res.status(400).json({ error: result.error });
  const fileName = text(req.body?.fileName, 200) || null;
  db.prepare(
    `INSERT INTO sb_brand_assets (marketplace, data, uploaded_by, file_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (marketplace) DO UPDATE SET
       data = excluded.data, uploaded_by = excluded.uploaded_by, file_name = excluded.file_name,
       updated_at = datetime('now', 'localtime')`
  ).run(mk, JSON.stringify(result.data), req.session.user.id, fileName);
  const { brands, logos, videos } = result.data;
  audit(req.session.user.id, mk, 'replace', 'sb_brand_assets', null, { brands: brands.length, logos: logos.length, videos: videos.length });
  res.json({ ok: true, data: result.data });
});
