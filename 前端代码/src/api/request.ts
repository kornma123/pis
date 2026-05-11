import axios from 'axios'
import { toast } from 'sonner'

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

request.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

request.interceptors.response.use(
  (response) => {
    const { data } = response
    if (!data.success) {
      toast.error(data.error?.message || '操作失败')
      return Promise.reject(data.error)
    }
    return data.data
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    const msg = error.response?.data?.error?.message || error.message || '网络错误'
    toast.error(msg)
    return Promise.reject(error)
  }
)

export default request
