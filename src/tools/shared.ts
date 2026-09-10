/**
 * REST 工具族共享基建：工具依赖、成本换算、通用 render 辅助。
 * 每个工具文件只声明自己的参数 schema 与端点映射，网络与错误映射集中在 http.ts。
 * @module dsh-kenari-plugin/tools/shared
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KenariHttpDeps } from '../http.js'

/** 工具族共享的运行时依赖：http 传输层 + attachment 存储 + 文档缓存 TTL。 */
export interface ToolsDeps {
  readonly http: KenariHttpDeps
  readonly ctx: Context
  /** /llms-full.txt 内存缓存有效期（毫秒），来自插件配置。 */
  readonly docsCacheTtlMs: number
}

/** micro-IDR → 可读 Rupiah 字符串（整除则不带小数）。 */
export function formatRupiah(microIdr: number): string {
  const rp = microIdr / 1_000_000
  return `Rp ${Number.isInteger(rp) ? rp.toLocaleString('id-ID') : rp.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** 单次调用的计费回显行；cost 缺失时不产生误导。 */
export function costLine(microIdr: number | undefined): string {
  return microIdr === undefined ? '' : `\n\n费用：${formatRupiah(microIdr)}（micro_idr ${microIdr}）`
}
