// FAD — ежедневный отчёт по сменам в Telegram
// Запускается по расписанию (cron) каждую минуту. Шлёт отчёт получателям,
// у которых заданное ими время (по Минску, UTC+3) совпадает с текущим.
//
// Секреты/переменные окружения (задаются в Supabase):
//   TG_BOT_TOKEN                 — токен вашего Telegram-бота
//   SUPABASE_URL                 — подставляется автоматически
//   SUPABASE_SERVICE_ROLE_KEY    — подставляется автоматически
//
// Развёртывание см. в telegram-setup.md

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STUDIOS = [
  { id: "masherova",  name: "Машерова",  dot: "🔵" },
  { id: "kuibysheva", name: "Куйбышева", dot: "🟡" },
  { id: "tolbuhina",  name: "Толбухина", dot: "🟠" },
];

const MON = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const DOW = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];

// Сдвигаем на +3 часа и читаем через getUTC* — получаем «минское» локальное время
function minskNow(): Date { return new Date(Date.now() + 3 * 3600 * 1000); }
function hhmm(d: Date): string {
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function fmtDate(d: Date): string { return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} (${DOW[d.getUTCDay()]})`; }

function num(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }
function money(n: number): string { return (Math.round(n * 100) / 100).toLocaleString("ru-RU"); }

function shortName(full?: string): string {
  if (!full) return "—";
  const p = full.trim().split(/\s+/);
  if (p.length >= 2) return p[0] + " " + p.slice(1).map((x) => x[0].toUpperCase() + ".").join("");
  return full;
}

function metrics(p: any) {
  const inc = (p.changes || []).filter((c: any) => c.type === "in").reduce((a: number, c: any) => a + num(c.amount), 0);
  const out = (p.changes || []).filter((c: any) => c.type !== "in").reduce((a: number, c: any) => a + num(c.amount), 0);
  const st = num(p.cashStart);
  const end = p.cashEnd != null ? num(p.cashEnd) : 0;
  const day = p.cashEnd != null ? end - st - inc + out : 0;
  const card = num(p.cashless), qr = num(p.allsports), ep = num(p.epos);
  return { day, card, qr, ep, rev: day + card + qr + ep };
}

function buildMessage(now: Date, byStudio: Record<string, any>): string {
  const lines: string[] = [`📊 Отчёт за ${fmtDate(now)}`];
  let totRev = 0, totCash = 0, totCashless = 0;
  for (const s of STUDIOS) {
    const p = byStudio[s.id];
    if (!p) { lines.push(`\n${s.dot} ${s.name} — филиал не работал`); continue; }
    const m = metrics(p);
    totRev += m.rev; totCash += m.day; totCashless += m.card + m.qr + m.ep;
    const notClosed = p.status !== "closed" ? " (смена не закрыта)" : "";
    let block = `\n${s.dot} ${s.name} — ${shortName(p.filledBy)}${notClosed}\n` +
      `💰 Выручка: ${money(m.rev)} BYN\n` +
      `нал ${money(m.day)} · картой ${money(m.card)} · QR ${money(m.qr)} · EPOS ${money(m.ep)}\n` +
      `👥 Пришло ${num(p.newCame)} · купили ${num(p.newBought)} · продлили ${num(p.renewed)}`;
    const comm: string[] = [];
    if (p.comments && String(p.comments).trim()) comm.push(String(p.comments).trim());
    (p.newList || []).forEach((x: any) => { if (x.note && String(x.note).trim()) comm.push("• " + String(x.note).trim() + (x.bought ? " (купил абонемент)" : "")); });
    (p.notRenewList || []).forEach((x: any) => { if (x.note && String(x.note).trim()) comm.push("• не продлил: " + String(x.note).trim()); });
    if (p.interNote && String(p.interNote).trim()) comm.push("между сменами: " + String(p.interNote).trim());
    block += "\n💬 " + (comm.length ? comm.join("\n") : "—");
    lines.push(block);
  }
  lines.push(`\n━━━━━━\nИтого выручка: ${money(totRev)} BYN\nНаличными ${money(totCash)} · Безнал ${money(totCashless)}`);
  return lines.join("\n");
}

async function sendTg(token: string, chatId: string, text: string): Promise<boolean> {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return r.ok;
}

Deno.serve(async (_req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = Deno.env.get("TG_BOT_TOKEN");
  if (!url || !key || !token) return new Response("env missing", { status: 500 });

  const sb = createClient(url, key);
  const now = minskNow();
  const timeNow = hhmm(now);
  const date = isoDate(now);

  const { data: setRow } = await sb.from("app_settings").select("data").eq("id", 1).single();
  const tg = (setRow?.data?.telegram) || {};
  const recips = tg.recipients || {};
  const due = Object.entries(recips).filter(([, c]: [string, any]) =>
    c && c.enabled && c.chatId && (c.time || "23:00") === timeNow
  );
  if (!due.length) return new Response(JSON.stringify({ ok: true, timeNow, due: 0 }), { headers: { "Content-Type": "application/json" } });

  const { data: reps } = await sb.from("reports").select("studio,payload").eq("report_date", date);
  const byStudio: Record<string, any> = {};
  (reps || []).forEach((r: any) => { byStudio[r.studio] = r.payload; });

  const msg = buildMessage(now, byStudio);
  const results: any[] = [];
  for (const [login, c] of due as [string, any][]) {
    // защита от повторной отправки: вставка в tg_log; если уже есть — пропускаем
    const { error: insErr } = await sb.from("tg_log").insert({ login, sent_date: date });
    if (insErr) { results.push({ login, skipped: "already sent today" }); continue; }
    const ok = await sendTg(token, String(c.chatId), msg);
    results.push({ login, sent: ok });
  }
  return new Response(JSON.stringify({ ok: true, timeNow, date, results }), { headers: { "Content-Type": "application/json" } });
});
