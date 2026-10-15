const HUMAN_REASONS = new Set([
  "这个招聘页需要浏览器读取，上次没有接着打开页面",
  "网站的 robots.txt 不允许自动读取这个页面",
  "网站的 robots.txt 暂时读不到，无法确认是否允许自动读取",
  "网站要求两次读取之间等更久，这一轮先停下",
  "网站要求人机验证，自动读取已停止",
  "这台电脑没有可用的专用 Chrome",
  "专用 Chrome 暂时没有启动或连接成功",
  "网站的证书验证没有通过，已停止读取",
  "当前是演示环境，没有实际打开浏览器",
  "专用 Chrome 里另一个任务正在用这个网站",
  "浏览器已交给你操作，自动读取已停止",
  "专用 Chrome 的连接断了或页面被关闭了",
  "读取时页面跳转了，尚未取得完整正文",
  "网页在等待时间内没有加载完",
  "暂时连不上这个招聘页面",
  "这个页面要求登录后才能读取",
  "这个招聘页面已经不存在或链接失效",
  "网站拒绝了这次自动读取",
  "页面打开了，但没有读到完整岗位正文",
  "读取程序中途出错，尚未取得可核实的岗位内容",
  "岗位列表仍在加载，暂时没读到岗位",
  "另一个任务正在使用读取或判断资源，已排队，空出来后自动继续"
]);
// 只把明确的资源占用排回队列；验证、登录或网站拒绝不能当锁冲突反复重试。
export const companyResourceBusy = error => /another_radar_writer_running|SQLITE_BUSY|database is locked|\bsite_busy\b/i.test([error?.code, error?.message, error?.stderr, error?.stdout, typeof error === 'string' ? error : ''].filter(Boolean).join('\n'));
// 公司找岗的用户回执不使用异常原文；底层诊断留在关联证据里。
export function companyReadReason(error) {
  const s = String(error?.message || error || '');
  if (HUMAN_REASONS.has(s)) return s;
  if (companyResourceBusy(error)) return '另一个任务正在使用读取或判断资源，已排队，空出来后自动继续';
  if (/needs_browser_extraction/.test(s)) return '这个招聘页需要浏览器读取，上次没有接着打开页面';
  if (/robots.*(?:不让|disallow|禁止)/i.test(s)) return '网站的 robots.txt 不允许自动读取这个页面';
  if (/robots.*(?:读不到|unreadable|server_error)/i.test(s)) return '网站的 robots.txt 暂时读不到，无法确认是否允许自动读取';
  if (/crawl_delay|robots.*隔很久/i.test(s)) return '网站要求两次读取之间等更久，这一轮先停下';
  if (/site_check|bot_challenge|captcha|验证|验证码/i.test(s)) return '网站要求人机验证，自动读取已停止';
  if (/chrome_missing|ENOENT.*(?:Chrome|chromium)/i.test(s)) return '这台电脑没有可用的专用 Chrome';
  if (/chrome_host_(?:wait|start_failed|profile_busy)/i.test(s)) return '专用 Chrome 暂时没有启动或连接成功';
  if (/ERR_CERT|CERT_|certificate|SSL|TLS/i.test(s)) return '网站的证书验证没有通过，已停止读取';
  if (/sandbox/i.test(s)) return '当前是演示环境，没有实际打开浏览器';
  if (/site_busy/i.test(s)) return '专用 Chrome 里另一个任务正在用这个网站';
  if (/agentDelegatedToUser|control.*lost|user.*control/i.test(s)) return '浏览器已交给你操作，自动读取已停止';
  if (/Target.*closed|page.*closed|browser.*closed|ECONNREFUSED.*127\.0\.0\.1/i.test(s)) return '专用 Chrome 的连接断了或页面被关闭了';
  if (/Execution context|Cannot find context/i.test(s)) return '读取时页面跳转了，尚未取得完整正文';
  if (/timeout|timed out|abort|超时/i.test(s)) return '网页在等待时间内没有加载完';
  if (/ENOTFOUND|ERR_NAME|ECONN|fetch failed|网络|没抓到/i.test(s)) return '暂时连不上这个招聘页面';
  if (/登录|session_expired|authwall|assisted_browser_only/i.test(s)) return '这个页面要求登录后才能读取';
  if (/404|410|不存在/i.test(s)) return '这个招聘页面已经不存在或链接失效';
  if (/403|429|挡爬虫|拒绝/i.test(s)) return '网站拒绝了这次自动读取';
  if (/没有正文|正文太短|page_text_too_short/i.test(s)) return '页面打开了，但没有读到完整岗位正文';
  return '读取程序中途出错，尚未取得可核实的岗位内容';
}

export const companyNextSteps = url => [
  ...(url ? [{ label: '自己打开招聘页查看；如需登录或验证，在专用 Chrome 里完成', href: url }] : []),
  { label: '在对话里补充另一个招聘页或具体岗位链接，再让 Radar 读取', href: '#talk' },
];

// 旧记录只翻译已知的内部错误，不捏造“试过浏览器”，也不篡改旧任务状态。
export function readableCompanyReceipt(r) {
  if (!r || !/needs_browser_extraction/.test(r.content || '')) return r;
  const url = r.url || String(r.content).match(/https?:\/\/[^\s；]+/)?.[0] || null;
  const reason = companyReadReason(r.content);
  return { ...r, content: `找 ${r.company || '这家公司'} 的岗位没完成：${reason}。可以在对话里把招聘页链接再发给 Radar，或自己打开查看。`, reason, errors: (r.errors || []).map(e => /needs_browser_extraction/.test(e) ? companyReadReason(e) : e), next_steps: companyNextSteps(url), attempts: r.attempts || [{ at: null, action: '读取招聘页', url, status: 'failed', summary: reason }] };
}
