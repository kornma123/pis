import { useState, useEffect, useCallback } from 'react'
import { materialApi, supplierApi, locationApi, projectApi, userApi } from '@/api/master'

type EntityType = 'materials' | 'suppliers' | 'locations' | 'projects' | 'users'

// 各实体 API 返回分页负载（request 拦截器已解包），此处仅取 list 作为下拉选项。
const apiMap: Record<EntityType, (params: Record<string, unknown>) => Promise<{ list?: any[] } | null>> = {
  materials: (params) => materialApi.getList(params),
  suppliers: (params) => supplierApi.getList(params),
  locations: (params) => locationApi.getList(params),
  projects: (params) => projectApi.getList(params),
  users: (params) => userApi.getList(params),
}

/**
 * 公共 Hook：加载下拉选项数据
 * @param entities 需要加载的实体类型列表
 * @param options 配置选项
 * @returns 各实体的数据和加载状态
 */
export function useReferenceData(
  entities: EntityType[],
  options?: {
    pageSize?: number
    status?: string
    autoLoad?: boolean
  }
) {
  const { pageSize = 999, status = 'active', autoLoad = true } = options || {}

  const [data, setData] = useState<Record<EntityType, Record<string, unknown>[]>>({
    materials: [],
    suppliers: [],
    locations: [],
    projects: [],
    users: [],
  })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const results = await Promise.all(
        entities.map(async (entity) => {
          const api = apiMap[entity]
          if (!api) return [entity, [] as any[]] as const
          const res = await api({ page: 1, pageSize, status })
          return [entity, (res?.list || []) as any[]] as const
        })
      )
      setData(prev => {
        const next = { ...prev }
        for (const [entity, list] of results) {
          next[entity as EntityType] = list
        }
        return next
      })
    } catch (e) {
      console.error('Failed to load reference data:', e)
    } finally {
      setLoading(false)
    }
  }, [entities.join(','), pageSize, status])

  useEffect(() => {
    if (autoLoad) {
      load()
    }
  }, [load, autoLoad])

  return {
    ...data,
    loading,
    reload: load,
  }
}
