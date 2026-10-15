// 连接手机（/api/phone，契约见桌面版方案附录 F）。bin/serve.mjs 只认这个入口；实现在 lib/phone/：
//   crypto.mjs  端到端加密（只用 WebCrypto；手机网页用的是同一份）      qr.mjs   配对二维码 PNG（本机生成）
//   link.mjs    电脑到中转的连接（只往外连）                            api.mjs  手机能做的四件事
//   service.mjs 配对、已配对的手机、把手机的请求交给 api.mjs（第一版的四件事）或 gateway.mjs（第二阶段：手机上跑工作台自己的页面）
//   gateway.mjs 手机网关：白名单、口令不出 Mac、一次性确认令牌、限速、访问记录、页面代码包、分块上传
//   push.mjs    新消息提醒：这台 Mac 自己发 Web Push（VAPID、RFC 8291 加密、订阅、什么时候推），不经过中转
// 中转在 relay/phone/（Cloudflare Worker offercrew-phone，负责人自己部署，见 relay/phone/DEPLOY.md）。
// 演示 / 沙盒模式下 available 一律是 false、pair_start 答 409；中转没设置或连不上时也是 false，reason 是一句中文，界面照抄。
// （唯一的例外是测试和本机开发：沙盒里把 OFFERCREW_PHONE_RELAY 指向 127.0.0.1 上的中转，东西出不了这台电脑。）
import { PhoneService, REASONS } from './phone/service.mjs';
import { setPhoneSource, phoneLink } from './phone-status.mjs';

export { REASONS as PHONE_REASONS };
export const PHONE_REASON = REASONS.sandbox;
let service = null;
// 起服务时把「连没连上、配过几台」交给 lib/phone-status.mjs（挡路大事、System 的回答读那一句，不往上引这里）。
const make = opts => { const s = new PhoneService(opts); setPhoneSource(() => ({ link: s.link?.state || 'off', paired: s.devices().length })); return s; };
export const phoneService = (opts) => (service ||= make(opts));
// 测试用：换一个新的服务（比如换了环境变量、换了假的 WebSocket）。
export function resetPhone(opts) { service?.stop(); service = make(opts); return service; }

export const phoneView = () => phoneService().view();
// 配过几台手机、和中转连没连上：读的人从 lib/phone-status.mjs 引；这里转出去给老的引法。
export { phoneLink };
export const phoneAction = body => phoneService().action(body);
export const phoneQr = id => phoneService().qr(String(id || ''));
// 工作台启动后调用：deps 是手机请求要用的几样东西（inbox、center、answer、talk、handoff），见 lib/phone/api.mjs。
export const startPhone = deps => phoneService().start(deps);
export const stopPhone = () => service?.stop();
// 工作台有更新（SSE 那个定时器发 update 的同一刻）：推给开着页面、订阅了更新的手机。
export const phoneUpdate = () => service?.pushUpdate() || 0;
