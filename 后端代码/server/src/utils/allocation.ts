export interface BatchAllocation {
  batchId: string
  batchNo: string
  quantity: number
  unitCost: number
}

export interface GroupBatchAllocation extends BatchAllocation {
  materialId: string
}

/** 按指定批次或 FEFO 分配批次，返回分配结果。库存不足时抛出错误。 */
export function allocateBatches(db: any, materialId: string, totalQty: number, batchId?: string): BatchAllocation[] {
  if (batchId) {
    const batch = db.prepare(`
      SELECT b.* FROM batches b
      JOIN materials m ON b.material_id = m.id
      WHERE b.id = ? AND b.material_id = ? AND b.status = 1 AND m.is_deleted = 0
    `).get(batchId, materialId) as any

    if (!batch) {
      throw new Error('指定出库批次不存在或不可用')
    }
    if (Number(batch.remaining || 0) < totalQty) {
      throw new Error(`批次库存不足: 需要 ${totalQty}, 可用 ${Number(batch.remaining || 0)}`)
    }

    return [{
      batchId: batch.id,
      batchNo: batch.batch_no,
      quantity: totalQty,
      unitCost: batch.inbound_price || 0,
    }]
  }

  const batches = db.prepare(`
    SELECT b.* FROM batches b
    JOIN materials m ON b.material_id = m.id
    WHERE b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
    ORDER BY b.expiry_date ASC, b.created_at ASC
  `).all(materialId) as any[]

  const totalAvailable = batches.reduce((sum, b) => sum + (b.remaining || 0), 0)
  if (totalAvailable < totalQty) {
    throw new Error(`批次库存不足: 需要 ${totalQty}, 可用 ${totalAvailable}`)
  }

  let remaining = totalQty
  const allocations: BatchAllocation[] = []

  for (const batch of batches) {
    if (remaining <= 0) break
    const take = Math.min(batch.remaining, remaining)
    allocations.push({
      batchId: batch.id,
      batchNo: batch.batch_no,
      quantity: take,
      unitCost: batch.inbound_price || 0,
    })
    remaining -= take
  }

  if (remaining > 0) {
    throw new Error(`批次库存不足: 需要 ${totalQty}`)
  }

  return allocations
}

/**
 * 在品牌池（同 group 的多物料）间按 FEFO 分配批次。
 * 遍历池内各物料的批次，直到满足总需求量。
 * 返回结果包含实际使用的 materialId，用于成本追溯。
 */
export function allocateGroupBatches(db: any, groupItems: any[], totalQty: number): GroupBatchAllocation[] {
  if (totalQty <= 0) return []

  // 收集池内所有物料的所有可用批次，统一按 FEFO 排序
  const allBatchOptions: Array<{
    materialId: string
    batchId: string
    batchNo: string
    remaining: number
    unitCost: number
    expiryDate: string
    createdAt: string
  }> = []

  for (const item of groupItems) {
    const batches = db.prepare(`
      SELECT b.* FROM batches b
      JOIN materials m ON b.material_id = m.id
      WHERE b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
      ORDER BY b.expiry_date ASC, b.created_at ASC
    `).all(item.material_id) as any[]

    for (const batch of batches) {
      allBatchOptions.push({
        materialId: item.material_id,
        batchId: batch.id,
        batchNo: batch.batch_no,
        remaining: batch.remaining || 0,
        unitCost: batch.inbound_price || 0,
        expiryDate: batch.expiry_date || '',
        createdAt: batch.created_at || '',
      })
    }
  }

  // 按 FEFO 排序（先按 expiry_date，再按 created_at）
  allBatchOptions.sort((a, b) => {
    if (a.expiryDate !== b.expiryDate) return a.expiryDate.localeCompare(b.expiryDate)
    return a.createdAt.localeCompare(b.createdAt)
  })

  const totalAvailable = allBatchOptions.reduce((sum, b) => sum + b.remaining, 0)
  if (totalAvailable < totalQty) {
    const materialNames = groupItems.map((i: any) => i.name || i.material_id).join(', ')
    throw new Error(`批次库存不足: 需要 ${totalQty}, 可用 ${totalAvailable} (品牌池: ${materialNames})`)
  }

  let remaining = totalQty
  const allocations: GroupBatchAllocation[] = []

  for (const opt of allBatchOptions) {
    if (remaining <= 0) break
    const take = Math.min(opt.remaining, remaining)
    allocations.push({
      materialId: opt.materialId,
      batchId: opt.batchId,
      batchNo: opt.batchNo,
      quantity: take,
      unitCost: opt.unitCost,
    })
    remaining -= take
  }

  if (remaining > 0) {
    throw new Error(`批次库存不足: 需要 ${totalQty}`)
  }

  return allocations
}
