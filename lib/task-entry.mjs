// 对话、旧指令与收件箱共用的引擎交办入口；不经可选本机 AI 队列。
import { makeCard, saveCards } from './cards.mjs';
export function queueEngineTask({ text, owner = 'patch', from = { by: 'you' }, leads = [], links = {}, now = Date.now() }) {
  const card = makeCard({ kind: 'ask', title: text, owner, from, leads, links, auto: true, now });
  card.requirement = String(text || '').trim();
  saveCards([card]);
  return card;
}
