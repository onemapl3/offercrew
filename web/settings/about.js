// 关于：版本、数据放在哪、官网。
import { esc } from './ui.js';
import { updateBridge, updateNotice, CHECK_UPDATE } from '../desktop.js';
function updateRow(D) {
  const n = updateNotice(D.desktop?.update);
  if (!n?.action) return [];
  return [{ id: 'update', label: n.label, value: esc(n.version), note: n.state === 'error' ? n.detail : '', words: '更新 新版本 升级 下载', action: async () => {
    const up = updateBridge();
    D.h?.toast?.(n.action === 'install' ? '正在重启…' : '开始下载，进度会显示在侧栏');
    try {
      const v = await up?.[n.action]?.();
      if (!v) D.h?.toast?.(n.action === 'install' ? '没能重启，点击再试' : '没能开始下载，点击再试');
      else if (v.check?.text) D.h?.toast?.(v.check.text);
    } catch { D.h?.toast?.(n.action === 'install' ? '没能重启，点击再试' : '没能开始下载，点击再试'); }
    await D.h?.refresh?.();
  } }];
}
export default {
  id: 'about', title: '关于', icon: 'info',
  summary: D => `${D.setup?.version ? D.setup.version + ' · ' : ''}数据存在这台电脑`,
  cards: D => [{ rows: [
    { id: 'version', label: '版本', value: esc(D.setup?.version || '—'), words: 'OfferCrew' },
    // 与侧栏共用更新状态与动作：发现新版可下载，系统接收完成才可以重启。
    ...(D.desktop?.update?.can_check && typeof updateBridge()?.check === 'function' ? [{ id: 'check-update', label: CHECK_UPDATE, value: esc(D.desktop.update.check?.text || ''), words: '更新 新版本 升级 检查', action: async () => { const v = await updateBridge().check(); D.h.toast(v?.check?.text || (v?.ready ? `${v.ready} 已下好` : CHECK_UPDATE)); await D.h.refresh(); } }] : []),
    ...updateRow(D),
    { id: 'data', label: '数据', value: '存在这台电脑', note: '调用模型时，内容会交给所选模型服务商；用 OfferCrew 补给时经过中转，中转不保存正文。登录邮箱用于登录和补给记账。', words: '隐私 本地' },
    { id: 'site', label: '官网', value: 'offercrew.onemaple.cc', href: 'https://offercrew.onemaple.cc', words: '网站 下载 安装包' },
  ] }],
};
