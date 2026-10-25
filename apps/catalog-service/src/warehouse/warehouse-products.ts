import { EntityManager } from 'typeorm';
import {
  formatProductSkuCode,
  parseProductSkuCode,
  PRODUCT_SKU_PREFIX,
  productBarcodeLookupVariants,
  warehouseChargeableWeight,
  warehouseDisplayCode,
} from '@app/common';
import { Product } from '../entities/product.entity';
import { badRequest, tableRef } from './warehouse.util';

/** Ombor so'rovlari uchun mahsulot qatori (xom SQL). */
export interface WarehouseProductRow {
  id: string;
  name: string;
  user_id: string;
  is_deleted: boolean;
  sku_code: string | null;
  barcode: string | null;
  image_url: string | null;
  weight_kg: string | number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  volumetric_enabled: boolean | null;
}

const PRODUCT_COLUMNS = `
  p."id"::text AS id, p."name", p."user_id"::text AS user_id,
  p."is_deleted", p."sku_code", p."barcode", p."image_url",
  p."weight_kg", p."length_cm", p."width_cm", p."height_cm",
  p."volumetric_enabled"`;

export const productColumns = (alias = 'p'): string =>
  PRODUCT_COLUMNS.replace(/\bp\./g, `${alias}.`);

export async function loadProducts(
  manager: EntityManager,
  ids: string[],
): Promise<Map<string, WarehouseProductRow>> {
  const unique = Array.from(new Set(ids));
  if (!unique.length) return new Map();
  const rows: WarehouseProductRow[] = await manager.query(
    `SELECT ${productColumns()} FROM ${tableRef(manager, Product)} p
      WHERE p."id" = ANY($1::bigint[])`,
    [unique],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Skaner kodi → FAOL mahsulot(lar): `ELC-P-…` — Elchi kodi, boshqasi — zavod
 * shtrix kodi (kanonik GTIN variantlari). catalog `findByCode` bilan AYNI
 * qoida (`@app/common` yordamchilari), lekin market boyitishisiz.
 */
export async function findProductsByCode(
  manager: EntityManager,
  rawCode: string,
  marketId?: string | null,
): Promise<WarehouseProductRow[]> {
  const code = rawCode.trim();
  const params: unknown[] = [];
  let where: string;
  if (code.toUpperCase().startsWith(PRODUCT_SKU_PREFIX)) {
    const id = parseProductSkuCode(code);
    if (!id) {
      badRequest(
        `Elchi mahsulot kodi noto'g'ri: ${code.slice(0, 40)} (namuna: ELC-P-000123)`,
      );
    }
    params.push(formatProductSkuCode(id));
    where = `p."sku_code" = $1`;
  } else {
    const variants = productBarcodeLookupVariants(code);
    if (!variants.length) return [];
    params.push(variants);
    where = `p."barcode" = ANY($1::text[])`;
  }
  if (marketId) {
    params.push(marketId);
    where += ` AND p."user_id" = $2`;
  }
  return manager.query(
    `SELECT ${productColumns()} FROM ${tableRef(manager, Product)} p
      WHERE p."is_deleted" = false AND ${where}
      ORDER BY p."id" ASC LIMIT 20`,
    params,
  );
}

/**
 * Javobdagi mahsulot ko'rinishi (kod yorlig'i + «Hisob vazni»).
 * `volumetricFromKg` — narx sozlamasidagi hajm chegarasi (AQ9lkgVB;
 * `WarehouseDirectoryService.volumetricFromKg()`), 0 — chegara yo'q.
 */
export function productView(row: WarehouseProductRow, volumetricFromKg = 0) {
  const weight =
    row.weight_kg === null || row.weight_kg === undefined
      ? null
      : Number(row.weight_kg);
  const measure = {
    weight_kg: weight,
    length_cm: row.length_cm ?? null,
    width_cm: row.width_cm ?? null,
    height_cm: row.height_cm ?? null,
    volumetric_enabled: row.volumetric_enabled !== false,
  };
  return {
    id: row.id,
    name: row.name,
    market_id: row.user_id,
    sku_code: row.sku_code ?? null,
    barcode: row.barcode ?? null,
    image_url: row.image_url ?? null,
    is_deleted: row.is_deleted === true,
    code: warehouseDisplayCode(row),
    ...measure,
    ...warehouseChargeableWeight(measure, volumetricFromKg),
  };
}

export type WarehouseProductView = ReturnType<typeof productView>;
