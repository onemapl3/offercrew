// 手机和中转连没连上、配过几台（lib/blockers.mjs 挡路大事、lib/unlock.mjs、System 的回答都读这一句）。
// 手机服务本身在 http 层（lib/phone.mjs 拿着 lib/phone/service.mjs 的那一个实例）：它起服务时把「怎么问」交到这里，
// 下面几层只读这一句，不往上引服务。服务没起就是没配，不为了问一句把它起起来。
let source = null;
export const setPhoneSource = fn => { source = fn; };
export const phoneLink = () => (source ? source() : { link: 'off', paired: 0 });
