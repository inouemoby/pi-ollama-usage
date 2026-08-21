import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────
interface UsageData {
  sessionPercent: number;
  sessionResetMs: number;   // epoch ms of next reset
  weeklyPercent: number;
  weeklyResetMs: number;    // epoch ms of next reset
  sessionModels: Record<string, number>;  // model name -> % of total 5h quota
  weeklyModels: Record<string, number>;   // model name -> % of total weekly quota
  _ts: number;
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────
function humanDuration(untilMs: number): string {
  if (untilMs <= 0) return "now";
  const m = Math.floor(untilMs / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

/** Returns severity level: 0=normal, 1=above expected, 2=critical */
function usageSeverity(pct: number, windowMs: number, resetMs: number): number {
  const remainingMs = resetMs - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;

  if (pct > expectedPct * 1.5) return 2;
  if (pct > expectedPct)      return 1;
  return 0;
}

// ─── Fetch ───────────────────────────────────────────────────────
async function fetchRemote(cookie: string): Promise<UsageData> {
  const resp = await fetch("https://ollama.com/settings", {
    headers: { Cookie: cookie, Accept: "text/html" },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const afterSession = html.indexOf('Session usage');
  const sm = afterSession >= 0 ? html.slice(afterSession, afterSession + 300).match(/([\d.]+)%\s*used/) : null;
  const afterWeekly = html.indexOf('Weekly usage');
  const wm = afterWeekly >= 0 ? html.slice(afterWeekly, afterWeekly + 300).match(/([\d.]+)%\s*used/) : null;

  let c = 0, sR = "", wR = "";
  const re = /data-time="([^"]+)"[^>]*>\s*Resets in ([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    c++;
    if (c === 1) sR = m[1];
    if (c === 2) wR = m[1];
  }

  // ── Per-model segments inside the session (5h) meter ──
  // Segment width is relative to the *used* portion of the bar, so:
  //   model's share of total quota = sessionPercent × segmentWidth / 100
  const sessionModels: Record<string, number> = {};
  if (sm) {
    const sp = parseFloat(sm[1]);
    // 与页面上 5h 百分比显示的小数位数一致 (页面显示 "2.8%" → 1 位, "12%" → 0 位)
    const decimals = (sm[1].split(".")[1] || "").length;
    const trackIdx = html.indexOf('aria-label="Session usage');
    const weeklyTrackIdx = html.indexOf('aria-label="Weekly usage');
    const segEnd = weeklyTrackIdx > trackIdx ? weeklyTrackIdx : html.length;
    if (trackIdx >= 0) {
      const region = html.slice(trackIdx, segEnd);
      const btnRe = /<button\b[\s\S]*?<\/button>/g;
      let b: RegExpExecArray | null;
      while ((b = btnRe.exec(region)) !== null) {
        const block = b[0];
        if (!block.includes("data-usage-segment")) continue;
        const segW = block.match(/style="[^"]*width:\s*([\d.]+)%/);
        const segM = block.match(/data-model="([^"]+)"/);
        if (segW && segM) {
          sessionModels[segM[1]] = +(sp * parseFloat(segW[1]) / 100).toFixed(decimals);
        }
      }
    }
  }

  // ── Per-model segments inside the weekly meter ──
  // 同上: 模型占 weekly 总配额 = weeklyPercent × segmentWidth / 100
  const weeklyModels: Record<string, number> = {};
  if (wm) {
    const wp = parseFloat(wm[1]);
    const wDecimals = (wm[1].split(".")[1] || "").length;
    const wTrackIdx = html.indexOf('aria-label="Weekly usage');
    if (wTrackIdx >= 0) {
      // weekly meter 是页面最后一个 meter,解析到其后的 "Resets in" 为止
      const wEndIdx = html.indexOf("Resets in", wTrackIdx);
      const wRegion = html.slice(wTrackIdx, wEndIdx > wTrackIdx ? wEndIdx : html.length);
      const btnRe = /<button\b[\s\S]*?<\/button>/g;
      let b: RegExpExecArray | null;
      while ((b = btnRe.exec(wRegion)) !== null) {
        const block = b[0];
        if (!block.includes("data-usage-segment")) continue;
        const segW = block.match(/style="[^"]*width:\s*([\d.]+)%/);
        const segM = block.match(/data-model="([^"]+)"/);
        if (segW && segM) {
          weeklyModels[segM[1]] = +(wp * parseFloat(segW[1]) / 100).toFixed(wDecimals);
        }
      }
    }
  }

  return {
    sessionPercent: sm ? parseFloat(sm[1]) : -1,
    sessionResetMs: new Date(sR).getTime(),
    weeklyPercent: wm ? parseFloat(wm[1]) : -1,
    weeklyResetMs: new Date(wR).getTime(),
    sessionModels,
    weeklyModels,
    _ts: Date.now(),
  };
}

// ─── Main ────────────────────────────────────────────────────────
// ─── Settings Storage ────────────────────────────────────────────
const SETTINGS_KEY = "ollamaCloud";

function getSettingsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return resolve(home, ".pi", "agent", "settings.json");
}

function readSettings(): Record<string, any> {
  try {
    const path = getSettingsPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch { return {}; }
}

function writeSettings(data: Record<string, any>) {
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function readCookie(): string {
  return readSettings()[SETTINGS_KEY]?.cookie ?? "";
}

function saveCookie(cookie: string) {
  const settings = readSettings();
  settings[SETTINGS_KEY] = { ...(settings[SETTINGS_KEY] || {}), cookie };
  writeSettings(settings);
}

function clearCookie() {
  const settings = readSettings();
  settings[SETTINGS_KEY] = { ...(settings[SETTINGS_KEY] || {}), cookie: "" };
  writeSettings(settings);
}

export default function (pi: ExtensionAPI) {
  let cookie = "";
  let usage: UsageData | null = null;
  const CACHE_MS = 60_000;
  const IDLE_REFRESH_MS = 5 * 60 * 1000;  // 闲时定时刷新: 5 分钟
  let footerOn = false;
  let _tui: any = null;
  let thinkingLevel = "off";
  let latestCtx: any = null;              // 最近一次事件拿到的 ctx,供定时器使用
  let agentBusy = false;                  // agent 生成中 = true,定时刷新只在闲时执行
  let idleTimer: ReturnType<typeof setInterval> | null = null;



  async function getUsage(): Promise<UsageData> {
    if (!cookie) throw new Error("Not logged in. Run /ollama-login.");
    if (usage && Date.now() - usage._ts < CACHE_MS) return usage;
    usage = await fetchRemote(cookie);
    return usage;
  }

  function isOllama(ctx: any) { return ctx.model?.provider === "ollama-cloud"; }
  function trigger() { if (_tui) setTimeout(() => _tui.requestRender?.(), 0); }

  // ── Refresh ─────────────────────────────────────────────────
  async function refresh(ctx: any) {
    if (!cookie) return;
    if (!isOllama(ctx)) {
      if (usage) { usage = null; toggleFooter(ctx); }
      return;
    }
    try { await getUsage(); trigger(); } catch { /* silent */ }
  }

  // ── Footer ──────────────────────────────────────────────────
  function toggleFooter(ctx: any) {
    if (isOllama(ctx) && cookie) {
      if (!footerOn) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
      }
    }
  }

  function buildFooter(ctx: any) {
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());
      return {
        dispose: () => { unsub(); _tui = null; },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ────────────────────────────────
          // Token counts
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tr += u.cacheRead; tw += u.cacheWrite;
              tc += u.cost.total;
            }
          }
          const parts: string[] = [];
          if (ti) parts.push(`↑${formatTokens(ti)}`);
          if (to) parts.push(`↓${formatTokens(to)}`);
          if (tr) parts.push(`R${formatTokens(tr)}`);
          if (tw) parts.push(`W${formatTokens(tw)}`);
          if (tc) parts.push(`$${tc.toFixed(3)}`);

          // Context %
          const cu = ctx.getContextUsage();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // Ollama usage (exclamation marks for severity, no color)
          let usageFull = "", usageNoWkModel = "", usageIdx = -1;
          if (usage && usage.sessionPercent >= 0 && usage.weeklyPercent >= 0) {
            const sSev = usageSeverity(usage.sessionPercent, FIVE_HOUR_MS, usage.sessionResetMs);
            const wSev = usageSeverity(usage.weeklyPercent, WEEK_MS, usage.weeklyResetMs);
            const sFlag = sSev === 2 ? "!!" : sSev === 1 ? "!" : "";
            const wFlag = wSev === 2 ? "!!" : wSev === 1 ? "!" : "";
            // Current model's share of the *total* quotas, e.g. "5h:2.8%(1.2%) Wk:17.4%(0.5%)"
            const curId = ctx.model?.id ?? "";
            const findPct = (models: Record<string, number>) => {
              for (const [name, pct] of Object.entries(models || {})) {
                if (curId === name || curId.startsWith(name) || name.startsWith(curId)) return pct;
              }
              return undefined;
            };
            const sPct = findPct(usage.sessionModels);
            const wPct = findPct(usage.weeklyModels);
            const sSuffix = sPct !== undefined ? `(${sPct}%)` : "";
            const wSuffix = wPct !== undefined ? `(${wPct}%)` : "";
            usageFull = `${sFlag}5h:${usage.sessionPercent}%${sSuffix} ${wFlag}Wk:${usage.weeklyPercent}%${wSuffix}`;
            usageNoWkModel = `${sFlag}5h:${usage.sessionPercent}%${sSuffix} ${wFlag}Wk:${usage.weeklyPercent}%`;
            usageIdx = parts.length;
            parts.push(usageFull);
          }

          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          // 宽度不足时的降级顺序:
          //   ① 先去掉提供商前缀 "(ollama) "
          //   ② 还不够 → 去掉 weekly 的模型括号 "(x%)"
          const withProv = `(ollama) ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
            right = withProv;
          }
          if (usageIdx >= 0 && usageNoWkModel !== usageFull &&
              visibleWidth(left) + 2 + visibleWidth(right) > width) {
            parts[usageIdx] = usageNoWkModel;
            left = parts.join(" ");
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);

          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  // ── Idle timer (每 5 分钟闲时刷新) ───────────────────────
  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(async () => {
      if (agentBusy) return;                    // 生成中,跳过本轮
      if (!cookie) return;
      const ctx = latestCtx;
      if (!ctx || !isOllama(ctx)) return;       // 只在 ollama-cloud 模型下刷新
      try { await getUsage(); trigger(); } catch { /* silent */ }
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();               // 不阻止进程退出
  }

  function stopIdleTimer() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    // Load cookie from settings.json
    cookie = readCookie();
    if (!cookie) cookie = process.env.OLLAMA_CLOUD_SESSION ?? "";
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;                            // 强制重建 footer,确保闭包捕获新 ctx
    toggleFooter(ctx);
    if (cookie) refresh(ctx);
    startIdleTimer();
  });

  pi.on("session_shutdown", async () => { stopIdleTimer(); });

  pi.on("agent_start", async (_e, ctx) => { latestCtx = ctx; agentBusy = true; });
  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (cookie) refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => { latestCtx = ctx; toggleFooter(ctx); if (cookie) refresh(ctx); });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = event.level || "off"; trigger(); });

  // ── /ollama ────────────────────────────────────────────────
  pi.registerCommand("ollama", {
    description: "Show Ollama Cloud usage",
    handler: async (_args, ctx) => {
      try {
        const d = await getUsage();
        const bar = (pct: number) =>
          "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
        ctx.ui.notify(
          [
            "══ Ollama Cloud Usage ══",
            `5h  ${bar(d.sessionPercent)}  ${d.sessionPercent}% used  (${(100 - d.sessionPercent).toFixed(1)}% left)  resets ${humanDuration(d.sessionResetMs - Date.now())}`,
            `Wk  ${bar(d.weeklyPercent)}  ${d.weeklyPercent}% used  (${(100 - d.weeklyPercent).toFixed(1)}% left)  resets ${humanDuration(d.weeklyResetMs - Date.now())}`,
          ].join("\n"),
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`Ollama: ${err.message}`, "error");
      }
    },
  });

  // ── /ollama-login ──────────────────────────────────────────
  pi.registerCommand("ollama-login", {
    description: "Set cookies: /ollama-login <aid> <__Secure-session>  (no args = interactive)",
    handler: async (args, ctx) => {
      const t = (args ?? "").trim();
      if (t) {
        const p = t.split(/\s+/);
        if (p.length < 2) {
          ctx.ui.notify("Need both: /ollama-login <aid> <__Secure-session>\nOr no args for step-by-step.", "error");
          return;
        }
        cookie = `aid=${p[0]}; __Secure-session=${p[1]}`;
      } else {
        const a = await ctx.ui.input("Ollama Login — aid value:");
        if (!a?.trim()) return ctx.ui.notify("Cancelled.", "warning");
        const s = await ctx.ui.input("Ollama Login — __Secure-session value:");
        if (!s?.trim()) return ctx.ui.notify("Cancelled.", "warning");
        cookie = `aid=${a.trim()}; __Secure-session=${s.trim()}`;
      }
      saveCookie(cookie); usage = null; toggleFooter(ctx);
      ctx.ui.notify("✓ Ollama session saved!", "success");
      refresh(ctx);
    },
  });

  // ── /ollama-logout ─────────────────────────────────────────
  pi.registerCommand("ollama-logout", {
    description: "Clear session",
    handler: async (_args, ctx) => {
      cookie = ""; usage = null;
      clearCookie();
      ctx.ui.setFooter(undefined as any);
      footerOn = false; _tui = null;
      ctx.ui.notify("✓ Ollama session cleared", "success");
    },
  });

  // ── ollama_usage tool ──────────────────────────────────────
  pi.registerTool({
    name: "ollama_usage",
    label: "Ollama Usage",
    description: "Get current Ollama Cloud usage.",
    parameters: Type.Object({}),
    async execute(_id: any, _p: any, _s: any, _up: any, ctx: any) {
      try {
        const d = await getUsage();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              fiveHour: { used: d.sessionPercent, remaining: +(100 - d.sessionPercent).toFixed(1), resetsIn: humanDuration(d.sessionResetMs - Date.now()) },
              weekly: { used: d.weeklyPercent, remaining: +(100 - d.weeklyPercent).toFixed(1), resetsIn: humanDuration(d.weeklyResetMs - Date.now()) },
            }, null, 2),
          }],
          details: {
            fiveHour: { used: d.sessionPercent, remaining: +(100 - d.sessionPercent).toFixed(1), resetsIn: humanDuration(d.sessionResetMs - Date.now()) },
            weekly: { used: d.weeklyPercent, remaining: +(100 - d.weeklyPercent).toFixed(1), resetsIn: humanDuration(d.weeklyResetMs - Date.now()) },
          },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    },
  });
}
