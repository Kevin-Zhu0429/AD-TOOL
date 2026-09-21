// A disabled internal principal owns shop data; human account deletion cannot remove it.
export function migratePetShared(db) {
  if (db.prepare("SELECT 1 FROM app_metadata WHERE key='pet_shared_v1'").get()) return;
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM users WHERE id=-1').get()) throw new Error('共享店铺保留编号冲突');
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,marketplace,is_active)
      VALUES(-1,'__pet_shared_shop__','宠物店铺共享','!disabled','operator','US',0)`).run();
    db.exec(`CREATE TABLE IF NOT EXISTS pet_shared_migration_archive
      (table_name TEXT NOT NULL, row_id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(table_name,row_id))`);
    const archive = db.prepare('INSERT INTO pet_shared_migration_archive VALUES(?,?,?)');
    const groups = [
      ['sku_items',['dedupe']], ['portfolio_items',['marketplace','portfolio_id']],
      ['aba_reports',['marketplace','brand','week_end'],'aba_queries'],
      ['aba_asin_reports',['marketplace','asin','week_end'],'aba_asin_queries'],
    ];
    for (const [table, keys, child] of groups) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC,id DESC`).all();
      const seen = new Set();
      for (const row of rows) {
        archive.run(table,row.id,JSON.stringify(row));
        if (child) for (const detail of db.prepare(`SELECT * FROM ${child} WHERE report_id=?`).all(row.id)) archive.run(child,JSON.stringify([detail.report_id,detail.query]),JSON.stringify(detail));
        const key=JSON.stringify(keys.map(k=>k==='brand' ? row[k].toLowerCase() : row[k]));
        if (seen.has(key)) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
        else { seen.add(key); db.prepare(`UPDATE ${table} SET user_id=-1 WHERE id=?`).run(row.id); }
      }
    }
    for (const table of ['captain_channel_bindings','captain_channel_assignments']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) archive.run(table,row.id,JSON.stringify(row));
      db.prepare(`UPDATE ${table} SET user_id=-1`).run();
    }
    db.prepare("INSERT INTO app_metadata(key,value) VALUES('pet_shared_v1','1')").run();
  })();
}
