// 接口回给页面的错误：内部代号换成人话（bin/serve.mjs 的 json() 每个回复都过一遍）。
// 写锁被占（another_radar_writer_running）是一时的：定时任务或执行器正在写，过几秒就好。
// 以前原样回给页面，对话里贴链接时你看到的就是这串英文（2026-09-30 真实链路测试）。
export const BUSY_TEXT = '系统正在写数据（定时任务或本机 AI 在跑），这一步没做成，过几秒再试一次';
export function publicError(data, status = 200) {
  if (data && typeof data.error === 'string' && /another_radar_writer_running/.test(data.error))
    return [{ ...data, error: BUSY_TEXT, busy: true }, status >= 500 ? status : 503];
  return [data, status];
}
