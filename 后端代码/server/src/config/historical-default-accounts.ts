/**
 * 历史上由正式种子脚本写入共享公开口令的账号全集。
 *
 * 启动门禁与事故改密脚本必须共同引用这一份清单，避免一个新增种子账号只进入其中一条链路。
 */
export const HISTORICAL_DEFAULT_ACCOUNTS = [
  { username: 'admin', resetEnv: 'RESET_ADMIN_PASSWORD' },
  { username: 'cangguan', resetEnv: 'RESET_CANGGUAN_PASSWORD' },
  { username: 'jishuyuan1', resetEnv: 'RESET_JISHUYUAN1_PASSWORD' },
  { username: 'jishuyuan2', resetEnv: 'RESET_JISHUYUAN2_PASSWORD' },
  { username: 'yishi1', resetEnv: 'RESET_YISHI1_PASSWORD' },
  { username: 'yishi2', resetEnv: 'RESET_YISHI2_PASSWORD' },
  { username: 'caigou', resetEnv: 'RESET_CAIGOU_PASSWORD' },
  { username: 'caiwu', resetEnv: 'RESET_CAIWU_PASSWORD' },
] as const
