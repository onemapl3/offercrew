// 引擎进程（bin/serve.mjs）的看门狗：退出了就按 1、2、4、8、16、30 秒退避重启；两分钟内退出 5 次就停手，
// 由壳把原因和日志路径显示出来（不无限重启、不刷日志）。stop() 是正常退出，不重启。
const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

export function superviseService({ start, now = Date.now, setTimer = setTimeout, onState = () => {} }) {
  let child = null, stopped = false;
  const exits = [];
  const launch = () => {
    child = start();
    onState({ state: 'running', restarts: exits.length });
    child.on('exit', (code, signal) => {
      if (stopped) { onState({ state: 'stopped' }); return; }
      const t = now();
      exits.push(t);
      while (exits.length && t - exits[0] > 120000) exits.shift();
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      if (exits.length >= 5) { onState({ state: 'gave_up', restarts: exits.length, reason }); return; }
      const delay_ms = BACKOFF[Math.min(exits.length - 1, BACKOFF.length - 1)];
      onState({ state: 'restarting', restarts: exits.length, delay_ms, reason });
      setTimer(() => { if (!stopped) launch(); }, delay_ms);
    });
  };
  launch();
  return { stop() { stopped = true; child?.kill('SIGTERM'); } };
}
