/**
 * 第三方包的本地类型补充（vendor stub）。
 *
 * DSH 官方包（@deepseek-ai/cordis 4.0.4 / @deepseek-ai/dsh-tools 0.1.0-rc.8）
 * 已于 2026-10-03 安装真实包并对照校验，其类型桩已删除。
 * 真实 DefineToolOptions 要求：output:{schema,render} 必填、execute 返回规范值（对象）。
 */

// jszip 3.10.x 自带类型与本项目用法冲突时的最小补充桩。
declare module 'jszip' {
  interface JSZipObject {
    async(type: 'string' | 'uint8array' | 'nodebuffer'): Promise<string | Uint8Array | Buffer>
  }
  interface JSZipLoadOptions {
    [key: string]: any
  }
  class JSZip {
    static loadAsync(
      data: Uint8Array | ArrayBuffer | Buffer | string,
      options?: JSZipLoadOptions,
    ): Promise<JSZip>
    file(path: string): JSZipObject | null
    file(path: string, data: string | Uint8Array | Buffer): JSZipObject
    files: Record<string, any>
    generateAsync(options: { type: 'nodebuffer' | 'uint8array' | 'string'; compression?: 'DEFLATE' | 'STORE' }): Promise<Buffer | Uint8Array | string>
  }
  export = JSZip
}
