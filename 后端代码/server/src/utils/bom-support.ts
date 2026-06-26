export interface BomSupportMaterial {
  materialId: string
  usagePerSample: number
  stock: number
  lockedStock: number
  availableStock: number
  supportableSamples: number
}

export interface BomSupportability {
  supportableSamples: number | null
  materials: BomSupportMaterial[]
}

export function calculateBomSupportability(db: any, bomId: string | null | undefined): BomSupportability {
  if (!bomId) return { supportableSamples: null, materials: [] }

  const rows = db.prepare(`
    SELECT
      bi.material_id,
      COALESCE(bi.usage_per_sample, 0) as usage_per_sample,
      CASE WHEN m.id IS NULL THEN 0 ELSE COALESCE(i.stock, 0) END as stock,
      CASE WHEN m.id IS NULL THEN 0 ELSE COALESCE(i.locked_stock, 0) END as locked_stock
    FROM bom_items bi
    LEFT JOIN materials m ON bi.material_id = m.id AND m.is_deleted = 0
    LEFT JOIN inventory i ON bi.material_id = i.material_id
    WHERE bi.bom_id = ?
    ORDER BY bi.sort_order ASC, bi.created_at ASC
  `).all(bomId) as any[]

  const materials = rows
    .map((row: any) => {
      const usagePerSample = Number(row.usage_per_sample) || 0
      const stock = Number(row.stock) || 0
      const lockedStock = Number(row.locked_stock) || 0
      const availableStock = Math.max(0, stock - lockedStock)
      return {
        materialId: row.material_id,
        usagePerSample,
        stock,
        lockedStock,
        availableStock,
        supportableSamples: usagePerSample > 0 ? Math.floor(availableStock / usagePerSample) : 0,
      }
    })
    .filter((row: BomSupportMaterial) => row.usagePerSample > 0)

  if (materials.length === 0) {
    return { supportableSamples: null, materials: [] }
  }

  return {
    supportableSamples: Math.min(...materials.map(item => item.supportableSamples)),
    materials,
  }
}

export function calculateBomSupportableSamples(db: any, bomId: string | null | undefined): number | null {
  return calculateBomSupportability(db, bomId).supportableSamples
}
