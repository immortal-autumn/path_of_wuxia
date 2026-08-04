import type { DatabaseSync } from "node:sqlite";
import type { WorldSeedShopfront } from "./world-data";

const CATEGORY_ITEMS: Record<string, string[]> = {
  medicine: ["healing-poultice", "herb", "moxa", "herb-seed"],
  tea: ["tea", "tea-cake", "sweet-cake", "water-flask"],
  food: ["simple-meal", "sweet-cake", "travel-ration", "rice", "salt", "tea"],
  textile: ["linen-bolt", "silk-bolt", "cotton-robe", "cloth-boots"],
  finance: ["silk-bolt", "bronze-mirror", "classic-book", "iron-sword"],
  books: ["paper", "ink-stick", "classic-book"],
  craft: ["wood", "iron-ore", "wooden-sword", "iron-sword", "farm-hoe", "bronze-mirror"],
  lodging: ["travel-ration", "simple-meal", "tea", "water-flask", "lamp-oil"],
  bath: ["soap-bean", "tea", "water-flask"],
  general: ["water-flask", "travel-ration", "lamp-oil", "paper", "salt"],
};

const INTERIOR_SLUGS: Record<string, string> = {
  "惠民药铺": "medicine",
  "春风茶坊": "tea",
  "广济邸店": "warehouse",
  "汴京绫罗铺": "silk",
  "永通金银质库": "pawn",
  "崇文书铺": "books",
  "通济铁器作": "smithy",
  "安乐浴堂": "bath",
};

function hoursFor(category: string) {
  if (category === "food" || category === "lodging") return { opensMinute: 5 * 60, closesMinute: 24 * 60 };
  if (category === "bath") return { opensMinute: 6 * 60, closesMinute: 23 * 60 };
  return { opensMinute: 7 * 60, closesMinute: 22 * 60 };
}

/** Seeds durable retail metadata while preserving live stock quantities and tills. */
export function seedShopCatalog(db: DatabaseSync, shopfronts: WorldSeedShopfront[], revision: number, now: string) {
  db.prepare("UPDATE shops SET is_active=0 WHERE seed_revision>0 AND seed_revision<?").run(revision);
  const shopInsert = db.prepare(`
    INSERT INTO shops(
      id,location_id,name,category,opens_minute,closes_minute,till_wen,is_active,seed_revision,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,200000,1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET location_id=excluded.location_id,name=excluded.name,category=excluded.category,
      opens_minute=excluded.opens_minute,closes_minute=excluded.closes_minute,is_active=1,
      seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
  `);
  const serviceLocationInsert = db.prepare(`
    INSERT OR IGNORE INTO shop_service_locations(shop_id,location_id) VALUES (?,?)
  `);
  const stockInsert = db.prepare(`
    INSERT INTO shop_stock(shop_id,item_definition_id,quantity,buy_price_wen,sell_price_wen,updated_at)
    SELECT ?,id,?,MAX(1,(base_value*120+99)/100),MAX(1,(base_value*60)/100),?
    FROM item_definitions WHERE id=? AND is_active=1
    ON CONFLICT(shop_id,item_definition_id) DO UPDATE SET
      buy_price_wen=excluded.buy_price_wen,sell_price_wen=excluded.sell_price_wen,updated_at=excluded.updated_at
  `);

  for (const shop of shopfronts) {
    const hours = hoursFor(shop.category);
    shopInsert.run(
      shop.id, shop.locationId, shop.name, shop.category, hours.opensMinute, hours.closesMinute,
      revision, now, now,
    );
    serviceLocationInsert.run(shop.id, shop.locationId);
    const slug = INTERIOR_SLUGS[shop.name];
    if (slug) {
      const rooms = db.prepare("SELECT id FROM locations WHERE is_active=1 AND id LIKE ? ORDER BY id")
        .all(`kaifeng-shop-${slug}-room-%`) as Array<{ id: string }>;
      for (const room of rooms) serviceLocationInsert.run(shop.id, room.id);
    }
    const itemIds = CATEGORY_ITEMS[shop.category] ?? CATEGORY_ITEMS.general;
    for (const itemId of itemIds) stockInsert.run(shop.id, 12, now, itemId);
  }
}
