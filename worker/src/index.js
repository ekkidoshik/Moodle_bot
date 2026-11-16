// Ретранслятор Telegram-бота на Cloudflare Workers.
//
// Telegram присылает сюда каждое сообщение и нажатие кнопки сразу (webhook),
// поэтому бот отвечает мгновенно: выбор группы, список курсов с отключением
// ненужных, дедлайны, настройки напоминаний и файлов, поиск по материалам, /stop,
// а для администратора (ADMIN_CHAT_ID из каталога) — /stats и /broadcast.
// Ещё: кнопка «✅ Сдал» под напоминаниями, подписка на дедлайны в календаре
// (GET /<группа>.ics, старая ссылка /calendar/<группа>/<токен>.ics тоже работает) и сторож по расписанию (cron в wrangler.toml):
// если бот давно не присылал отчёт о проверке Moodle — пишет администратору.
//
// Проверкой Moodle по-прежнему занимается moodle_bot.py в GitHub Actions:
//   GET  /api/subscribers — забирает подписчиков (группа и отключённые курсы);
//   POST /api/subscribers — {add: {chat: {g, m}}, remove: [chat]}: перенос старых
//                            подписок (только отсутствующих) и снятие недоступных чатов;
//   PUT  /api/catalog     — кладёт группы, названия курсов, дедлайны и chat_id админа;
//   PUT  /api/index/<g>   — индекс материалов группы для поиска;
//   POST /api/broadcasts/take — забирает рассылки, которые Worker не отправил сам;
//   POST /api/report      — итог запуска бота (виден на /status);
//   GET/PUT /api/state    — состояние бота (снимки курсов, отправленные напоминания...).
//
// Хранилище — KV (binding BOT_KV): "catalog", "index:<g>", "broadcasts", "report" и
// "sub:<chat_id>" = {g: группа, m: отключённые курсы, r: окна напоминаний (с), f: файлы,
// s: сводка в 20:00}, "done:<chat_id>" = {d: [id сданных дедлайнов]}, "watchdog"
// (дублируется в metadata, чтобы список подписчиков читался одним list без get).
// Секреты Worker: TELEGRAM_BOT_TOKEN, BOT_SYNC_SECRET (его SHA-256 — secret_token webhook).

const BTN_COURSES = "📚 Мои курсы";
const BTN_DEADLINES = "⏰ Дедлайны";
const BTN_SETTINGS = "⚙️ Настройки";
const REMINDER_OPTIONS = [[259200, "за 3 дня"], [86400, "за сутки"], [10800, "за 3 часа"], [3600, "за 1 час"]];
const DEFAULT_REMINDERS = [86400, 10800];
const SEARCH_LIMIT = 15;
const DIRECT_BROADCAST_LIMIT = 40; // лимит бесплатного Worker — 50 запросов за вызов
const WATCHDOG_MAX_AGE = 3600; // сек без отчёта о проверке Moodle — повод написать админу
let ORIGIN = ""; // адрес этого Worker, нужен для ссылки на календарь
const DEADLINES_LIST_DAYS = 14;
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export default {
  async scheduled(event, env) {
    await watchdog(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    ORIGIN = url.origin;

    // календарь: короткая ссылка /<группа>.ics и прежняя /calendar/<группа>/<токен>.ics
    const short = url.pathname.match(/^\/([a-z0-9_]+)\.ics$/);
    const old = url.pathname.match(/^\/calendar\/([a-z0-9_]+)\/([0-9a-f]+)\.ics$/);
    const calKey = short ? short[1] : old && old[2] === (await calendarToken(env, old[1])) ? old[1] : null;
    if (request.method === "GET" && calKey) {
      const catalog = await getCatalog(env);
      if (!catalog || !catalog.groups.some((g) => g.key === calKey)) return new Response("not found", { status: 404 });
      return new Response(buildIcs(catalog, calKey), {
        headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "max-age=900" },
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookToken(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(update, env);
      } catch (e) {
        console.log("update error", (e && e.stack) || e);
      }
      // всегда 200: иначе Telegram будет присылать то же обновление снова
      return new Response("ok");
    }

    if (request.method === "GET" && url.pathname === "/status") {
      // Диагностика без секретов: доходят ли до Worker сообщения от Telegram
      const info = await tg(env, "getWebhookInfo", {});
      const r = info.result || {};
      const catalog = await getCatalog(env);
      return json({
        bot_token_set: !!env.TELEGRAM_BOT_TOKEN,
        sync_secret_set: !!env.BOT_SYNC_SECRET,
        telegram_ok: !!info.ok,
        telegram_error: info.ok ? null : info.description,
        webhook_points_here: r.url === `${url.origin}/telegram`,
        webhook_set: !!r.url,
        pending_update_count: r.pending_update_count,
        last_error_date: r.last_error_date ? new Date(r.last_error_date * 1000).toISOString() : null,
        last_error_message: r.last_error_message || null,
        catalog_groups: catalog && catalog.groups ? catalog.groups.length : 0,
        subscribers_in_worker: Object.keys(await listSubscribers(env)).length,
        last_bot_run: await env.BOT_KV.get("report", "json"),
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.BOT_SYNC_SECRET.trim()}`) {
        return new Response("forbidden", { status: 403 });
      }
      if (request.method === "GET" && url.pathname === "/api/subscribers") {
        return json(await listSubscribers(env));
      }
      if (request.method === "POST" && url.pathname === "/api/subscribers") {
        const body = await request.json();
        let added = 0;
        for (const [chat, sub] of Object.entries(body.add || {})) {
          if (!(await getSub(env, chat))) {
            await putSub(env, chat, { g: sub.g, m: sub.m || [] });
            added++;
          }
        }
        for (const chat of body.remove || []) await env.BOT_KV.delete(`sub:${chat}`);
        return json({ ok: true, added });
      }
      // состояние бота (бывший state.json): храним как есть, без разбора — экономим CPU
      if (request.method === "GET" && url.pathname === "/api/state") {
        const v = await env.BOT_KV.get("state");
        return new Response(v ?? "null", { headers: { "content-type": "application/json" } });
      }
      if (request.method === "PUT" && url.pathname === "/api/state") {
        await env.BOT_KV.put("state", await request.text());
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/report") {
        await env.BOT_KV.put("report", JSON.stringify(await request.json()));
        return json({ ok: true });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/api/index/")) {
        const key = url.pathname.slice("/api/index/".length);
        await env.BOT_KV.put(`index:${key}`, JSON.stringify(await request.json()));
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/broadcasts/take") {
        const queue = (await env.BOT_KV.get("broadcasts", "json")) || [];
        if (queue.length) await env.BOT_KV.delete("broadcasts");
        return json(queue);
      }
      if (request.method === "PUT" && url.pathname === "/api/catalog") {
        const catalog = await request.json();
        await env.BOT_KV.put("catalog", JSON.stringify(catalog));
        return json({ ok: true });
      }
    }
    return new Response("not found", { status: 404 });
  },
};

// Telegram разрешает в secret_token только A-Z, a-z, 0-9, _ и -, а BOT_SYNC_SECRET
// может содержать что угодно. Поэтому для webhook используем его SHA-256 (hex);
// moodle_bot.py считает так же.
async function sha256hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function webhookToken(env) {
  return sha256hex(env.BOT_SYNC_SECRET.trim());
}

// Токен прежней (длинной) ссылки на календарь — оставлен, чтобы старые подписки не сломались
async function calendarToken(env, group) {
  return (await sha256hex(`${env.BOT_SYNC_SECRET.trim()}:calendar:${group}`)).slice(0, 20);
}

// ------------------------------ Хранилище ------------------------------

function json(data) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

async function getCatalog(env) {
  return await env.BOT_KV.get("catalog", "json");
}

async function getSub(env, chatId) {
  return await env.BOT_KV.get(`sub:${chatId}`, "json");
}

// sub — полный объект подписчика: вызывающий передаёт {...старый, изменения},
// чтобы не потерять настройки.
async function putSub(env, chatId, sub) {
  const value = { g: sub.g, m: [...new Set(sub.m || [])].sort() };
  if (Array.isArray(sub.r)) value.r = [...new Set(sub.r)].sort((a, b) => b - a);
  if (typeof sub.f === "boolean") value.f = sub.f;
  if (sub.s) value.s = true;
  await env.BOT_KV.put(`sub:${chatId}`, JSON.stringify(value), { metadata: value });
}

async function listSubscribers(env) {
  const result = {};
  let cursor;
  do {
    const page = await env.BOT_KV.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const sub = k.metadata || (await env.BOT_KV.get(k.name, "json"));
      if (sub) {
        result[k.name.slice(4)] = {
          group: sub.g, muted: sub.m || [], reminders: sub.r ?? null, files: sub.f ?? null,
          digest: !!sub.s, done: [],
        };
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // отметки «✅ Сдал» — отдельными ключами, чтобы не упереться в 1 КБ metadata подписчика
  do {
    const page = await env.BOT_KV.list({ prefix: "done:", cursor });
    for (const k of page.keys) {
      const chat = k.name.slice(5);
      if (result[chat] && k.metadata) result[chat].done = k.metadata.d || [];
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result;
}

async function getDone(env, chatId) {
  const v = await env.BOT_KV.get(`done:${chatId}`, "json");
  return (v && v.d) || [];
}

async function putDone(env, chatId, ids) {
  if (!ids.length) return env.BOT_KV.delete(`done:${chatId}`);
  const value = { d: ids };
  await env.BOT_KV.put(`done:${chatId}`, JSON.stringify(value), { metadata: value });
}

// ------------------------------ Telegram -------------------------------

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) console.log(`Telegram ${method}: ${data.description}`);
  return data;
}

function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra,
  });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function groupsKeyboard(catalog, current) {
  const buttons = catalog.groups.map((g) => ({ text: (g.key === current ? "✅ " : "") + g.title }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: BTN_COURSES }, { text: BTN_DEADLINES }]);
  rows.push([{ text: BTN_SETTINGS }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: "Выберите группу" };
}

function groupTitle(catalog, key) {
  const g = catalog.groups.find((x) => x.key === key);
  return g ? g.title : key;
}

function findGroup(text, catalog) {
  let t = text.replace(/✅/g, "").trim().toLowerCase();
  if (t.startsWith("/")) {
    t = t.slice(1).split("@")[0];
    return catalog.groups.some((g) => g.key === t) ? t : null;
  }
  const g = catalog.groups.find((x) => x.title.trim().toLowerCase() === t);
  return g ? g.key : null;
}

// ------------------------------ Тексты ---------------------------------

function fmtTime(ts) {
  const d = new Date((ts + 3 * 3600) * 1000); // Москва, UTC+3
  const p = (n) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtLeft(sec) {
  if (sec >= 2 * 86400) return `${Math.floor(sec / 86400)} дн.`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} ч`;
  return `${Math.max(1, Math.floor(sec / 60))} мин`;
}

function coursesKeyboard(catalog, key, muted) {
  const names = catalog.course_names[key] || {};
  const rows = Object.entries(names)
    .sort((a, b) => a[1].localeCompare(b[1], "ru"))
    .map(([cid, name]) => [{ text: `${muted.includes(cid) ? "🔕" : "🔔"} ${name}`, callback_data: `c:${cid}` }]);
  return { inline_keyboard: rows };
}

function coursesText(catalog, key) {
  const names = catalog.course_names[key] || {};
  if (!Object.keys(names).length) {
    return `Курсы группы <b>${esc(groupTitle(catalog, key))}</b> появятся после ближайшей проверки Moodle (до 15 минут).`;
  }
  return (`📚 Курсы группы <b>${esc(groupTitle(catalog, key))}</b>.\n\n` +
    "Нажмите на курс, чтобы отключить 🔕 или включить 🔔 по нему уведомления о файлах и дедлайнах.");
}

function doneButton(d, isDone) {
  return [{ text: `${isDone ? "↩️ Не сдал" : "✅ Сдал"}: ${d.name.slice(0, 40)}`, callback_data: `d:${d.id}` }];
}

function deadlinesMessage(catalog, key, muted, done) {
  const now = Date.now() / 1000;
  const horizon = now + DEADLINES_LIST_DAYS * 86400;
  const names = catalog.course_names[key] || {};
  const items = (catalog.deadlines[key] || [])
    .filter((d) => d.due > now && d.due <= horizon && !muted.includes(d.course))
    .sort((a, b) => a.due - b.due);
  const footer = "\n\n📅 Все дедлайны в календаре телефона: /calendar";
  if (!items.length) return { text: `⏰ Дедлайнов на ближайшие ${DEADLINES_LIST_DAYS} дней нет.` + footer };
  const lines = items.map((d) => {
    const link = d.url ? `<a href="${esc(d.url)}">${esc(d.name)}</a>` : esc(d.name);
    return `${done.includes(d.id) ? "✅" : "•"} ${d.kind || "Задание"} ${link}\n   ${esc(names[d.course] || `Курс ${d.course}`)}\n` +
      `   до <b>${fmtTime(d.due)}</b> (осталось ${fmtLeft(d.due - now)})` + (done.includes(d.id) ? " — сдано" : "");
  });
  return {
    text: `⏰ Дедлайны на ближайшие ${DEADLINES_LIST_DAYS} дней:\n\n` + lines.join("\n\n") +
      "\n\nОтметьте сданное — напоминаний о нём больше не будет." + footer,
    markup: { inline_keyboard: items.slice(0, 10).map((d) => doneButton(d, done.includes(d.id))) },
  };
}

// ------------------------------ Календарь ------------------------------

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function icsFold(line) {
  // строки длиннее 75 байт переносятся (RFC 5545); считаем байты UTF-8
  const enc = new TextEncoder();
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function icsTime(ts) {
  return new Date(ts * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function buildIcs(catalog, key) {
  const names = catalog.course_names[key] || {};
  const now = icsTime(Date.now() / 1000);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//moodle-bot//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(`Дедлайны ${groupTitle(catalog, key)}`)}`, "X-WR-TIMEZONE:Europe/Moscow",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const d of catalog.deadlines[key] || []) {
    lines.push(
      "BEGIN:VEVENT", `UID:${d.id}-${key}@moodle-bot`, `DTSTAMP:${now}`,
      `DTSTART:${icsTime(d.due - 1800)}`, `DTEND:${icsTime(d.due)}`,
      `SUMMARY:${icsEscape(`⏰ ${d.name}`)}`,
      `DESCRIPTION:${icsEscape(`${d.kind || "Задание"} · ${names[d.course] || ""}${d.url ? `\n${d.url}` : ""}`)}`,
    );
    if (d.url) lines.push(`URL:${d.url}`);
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(d.name)}`, "TRIGGER:-PT1H", "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

async function calendarText(env, catalog, key) {
  const link = `${ORIGIN}/${key}.ics`;
  return (`📅 <b>Дедлайны группы ${esc(groupTitle(catalog, key))} в календаре</b>\n\n` +
    `Ссылка для подписки (обновляется сама):\n<code>${link}</code>\n\n` +
    "• <b>Google Календарь</b> (с компьютера): «Другие календари» → «+» → «Добавить по URL».\n" +
    "• <b>iPhone</b>: Настройки → Календарь → Учётные записи → Новая учётная запись → Другое → " +
    "Подписной календарь.");
}

// ------------------------------ Сторож ---------------------------------

async function watchdog(env) {
  const catalog = await getCatalog(env);
  if (!catalog || !catalog.admin) return;
  const report = await env.BOT_KV.get("report", "json");
  if (!report || !report.ts) return; // бот ещё не присылал отчёт со временем
  const stale = Date.now() / 1000 - report.ts > WATCHDOG_MAX_AGE;
  const state = (await env.BOT_KV.get("watchdog", "json")) || { alerted: false };
  if (stale === state.alerted) return;
  await send(env, String(catalog.admin).trim(), stale
    ? `⚠️ Бот не проверял Moodle больше часа (последняя проверка: ${esc(report.time)}). ` +
      "Проверьте cron-job и вкладку Actions в GitHub."
    : `✅ Проверки Moodle снова идут (последняя: ${esc(report.time)}).`);
  await env.BOT_KV.put("watchdog", JSON.stringify({ alerted: stale }));
}

function reminders(sub) {
  return Array.isArray(sub.r) ? sub.r : DEFAULT_REMINDERS;
}

function settingsText() {
  return ("⚙️ <b>Настройки</b>\n\n" +
    "⏰ Когда напоминать о дедлайнах — отметьте нужные варианты (можно несколько или ни одного).\n\n" +
    "📎 Файлы — присылать ли новые и обновлённые файлы прямо в чат (до 50 МБ), а не только ссылкой.\n\n" +
    "🗞 Сводка — вместо отдельных сообщений о новых файлах одно сообщение в 20:00 (файлы в ней — ссылками). " +
    "Напоминания о дедлайнах приходят как обычно.");
}

function settingsKeyboard(sub) {
  const r = reminders(sub);
  const btn = ([sec, label]) => ({ text: `${r.includes(sec) ? "✅" : "▫️"} ${label}`, callback_data: `r:${sec}` });
  return {
    inline_keyboard: [
      [btn(REMINDER_OPTIONS[0]), btn(REMINDER_OPTIONS[1])],
      [btn(REMINDER_OPTIONS[2]), btn(REMINDER_OPTIONS[3])],
      [{ text: `📎 Файлы в чат: ${sub.f === false ? "выкл" : "вкл"}`, callback_data: "f" }],
      [{ text: `🗞 Сводка в 20:00: ${sub.s ? "вкл" : "выкл"}`, callback_data: "s" }],
    ],
  };
}

function norm(s) {
  return String(s).toLowerCase().replace(/ё/g, "е");
}

async function searchText(env, catalog, key, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "🔎 Напишите, что найти, например: <code>/search лекция 5</code> — или просто отправьте слово сообщением.";
  }
  const index = (await env.BOT_KV.get(`index:${key}`, "json")) || [];
  const names = catalog.course_names[key] || {};
  const found = index.filter((m) => {
    const hay = norm(`${m.n} ${(m.f || []).join(" ")} ${names[m.c] || ""}`);
    return words.every((w) => hay.includes(w));
  });
  if (!found.length) return `🔎 По запросу «${esc(query.trim())}» ничего не нашлось.`;
  const lines = found.slice(0, SEARCH_LIMIT).map((m) => {
    const title = m.u ? `<a href="${esc(m.u)}">${esc(m.n)}</a>` : esc(m.n);
    const files = (m.f || []).filter((f) => words.some((w) => norm(f).includes(w)));
    const shown = (files.length ? files : m.f || []).slice(0, 3);
    return `• ${title}\n   ${esc(names[m.c] || `Курс ${m.c}`)}` +
      (shown.length ? `\n   📎 ${shown.map(esc).join(", ")}` : "");
  });
  const more = found.length > SEARCH_LIMIT ? `\n\nПоказаны первые ${SEARCH_LIMIT} из ${found.length} — уточните запрос.` : "";
  return `🔎 Нашлось ${found.length}:\n\n` + lines.join("\n\n") + more;
}

function isAdmin(catalog, chatId) {
  return !!(catalog.admin && String(catalog.admin).trim() === chatId);
}

async function statsText(env, catalog) {
  const subs = await listSubscribers(env);
  const all = Object.values(subs);
  const lines = catalog.groups.map((g) => {
    const mine = all.filter((s) => s.group === g.key);
    const muted = mine.filter((s) => s.muted.length).length;
    const noFiles = mine.filter((s) => s.files === false).length;
    return `• <b>${esc(g.title)}</b>: ${mine.length}` +
      (muted ? `, отключали курсы: ${muted}` : "") + (noFiles ? `, без файлов: ${noFiles}` : "");
  });
  const report = await env.BOT_KV.get("report", "json");
  let run = "Отчётов о запусках ещё нет.";
  if (report) {
    const errs = Object.entries(report.group_errors || {}).map(([k, e]) => `${k}: ${e}`);
    if (report.sync_error) errs.push(`синхронизация: ${report.sync_error}`);
    if (report.push_error) errs.push(`отправка в Worker: ${report.push_error}`);
    run = `Последняя проверка Moodle: ${esc(report.time)}\n` +
      (errs.length ? "⚠️ " + errs.map(esc).join("\n⚠️ ") : "✅ без ошибок");
  }
  return `📊 <b>Подписчики</b>: ${all.length}\n` + lines.join("\n") + "\n\n" + run;
}

async function broadcastCommand(env, catalog, chatId, text) {
  const rest = text.replace(/^\/broadcast(@\S+)?\s*/i, "");
  const first = rest.split(/\s+/)[0].toLowerCase();
  const group = catalog.groups.some((g) => g.key === first) ? first : null;
  const body = (group ? rest.slice(first.length) : rest).trim();
  if (!body) {
    const keys = catalog.groups.map((g) => g.key).join(", ");
    return send(env, chatId,
      "Использование:\n<code>/broadcast текст</code> — всем подписчикам\n" +
      `<code>/broadcast m104 текст</code> — одной группе (ключи: ${esc(keys)})`);
  }
  const subs = await listSubscribers(env);
  const targets = Object.entries(subs).filter(([, s]) => !group || s.group === group).map(([c]) => c);
  const whom = group ? `группе ${esc(groupTitle(catalog, group))}` : "всем";
  if (targets.length <= DIRECT_BROADCAST_LIMIT) {
    let ok = 0;
    for (const c of targets) {
      const r = await tg(env, "sendMessage", { chat_id: c, text: body, disable_web_page_preview: true });
      if (r.ok) ok++;
    }
    return send(env, chatId, `📣 Отправлено ${whom}: ${ok} из ${targets.length}.`);
  }
  const queue = (await env.BOT_KV.get("broadcasts", "json")) || [];
  queue.push({ group, text: body });
  await env.BOT_KV.put("broadcasts", JSON.stringify(queue));
  return send(env, chatId, `📣 Получателей ${targets.length} (${whom}) — разошлю при ближайшей проверке, в течение 15 минут.`);
}

// ------------------------------ Обработка ------------------------------

async function handleUpdate(update, env) {
  const catalog = await getCatalog(env);
  if (update.message) return handleMessage(update.message, catalog, env);
  if (update.callback_query) return handleCallback(update.callback_query, catalog, env);
}

async function subscribe(env, chatId, key, catalog, sub) {
  // у другой группы другие курсы — отключённые сбрасываем
  const muted = sub && sub.g === key ? sub.m : [];
  await putSub(env, chatId, { ...(sub || {}), g: key, m: muted });
  await send(env, chatId,
    `✅ Группа <b>${esc(groupTitle(catalog, key))}</b> выбрана.\n` +
    "Буду присылать новые и обновлённые файлы из её курсов и напоминать о дедлайнах за сутки и за 3 часа.\n\n" +
    `${BTN_COURSES} — список курсов, ненужные можно отключить.\n` +
    `${BTN_SETTINGS} — когда напоминать о дедлайнах и присылать ли файлы.\n` +
    "🔎 Чтобы найти материал, просто напишите слово, например «лекция 5».\n" +
    "Сменить группу — кнопкой внизу, /stop — отписаться.",
    { reply_markup: groupsKeyboard(catalog, key) });
}

async function handleMessage(msg, catalog, env) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";

  if (!catalog || !catalog.groups || !catalog.groups.length) {
    return send(env, chatId, "Бот ещё настраивается. Попробуйте через 15 минут.");
  }
  const sub = await getSub(env, chatId);
  const current = sub && catalog.groups.some((g) => g.key === sub.g) ? sub.g : null;
  const muted = current ? sub.m || [] : [];
  let m;

  if (command === "/start") {
    const intro = current
      ? `Сейчас вы подписаны на группу <b>${esc(groupTitle(catalog, current))}</b>.\n` +
        "Чтобы сменить группу, нажмите другую кнопку внизу. /stop — отписаться."
      : "Выберите свою группу на клавиатуре внизу — буду присылать новые файлы из её курсов Moodle и напоминать о дедлайнах.";
    return send(env, chatId, intro, { reply_markup: groupsKeyboard(catalog, current) });
  }
  if (command === "/courses" || command === "/deadlines" || text === BTN_COURSES || text === BTN_DEADLINES) {
    if (!current) {
      return send(env, chatId, "Сначала выберите группу на клавиатуре внизу или в меню.",
        { reply_markup: groupsKeyboard(catalog, null) });
    }
    if (command === "/courses" || text === BTN_COURSES) {
      return send(env, chatId, coursesText(catalog, current), { reply_markup: coursesKeyboard(catalog, current, muted) });
    }
    const dm = deadlinesMessage(catalog, current, muted, await getDone(env, chatId));
    return send(env, chatId, dm.text, dm.markup ? { reply_markup: dm.markup } : {});
  }
  if (command === "/settings" || text === BTN_SETTINGS) {
    if (!current) return send(env, chatId, "Сначала выберите группу: /start");
    return send(env, chatId, settingsText(), { reply_markup: settingsKeyboard(sub) });
  }
  if (command === "/search") {
    if (!current) return send(env, chatId, "Сначала выберите группу: /start");
    return send(env, chatId, await searchText(env, catalog, current, text.replace(/^\/search(@\S+)?/i, "")));
  }
  if (command === "/calendar") {
    if (!current) return send(env, chatId, "Сначала выберите группу: /start");
    return send(env, chatId, await calendarText(env, catalog, current));
  }
  if (command === "/id") {
    return send(env, chatId, `Ваш chat_id: <code>${chatId}</code>`);
  }
  if ((command === "/stats" || command === "/broadcast") && isAdmin(catalog, chatId)) {
    if (command === "/stats") return send(env, chatId, await statsText(env, catalog));
    return broadcastCommand(env, catalog, chatId, text);
  }
  if ((m = command.match(/^\/(on|off)_(\d+)$/))) {
    if (!current) return send(env, chatId, "Сначала выберите группу: /start");
    const name = (catalog.course_names[current] || {})[m[2]];
    if (!name) return send(env, chatId, "Такого курса нет в вашей группе. Список: /courses");
    const next = m[1] === "off" ? [...muted, m[2]] : muted.filter((c) => c !== m[2]);
    await putSub(env, chatId, { ...sub, g: current, m: next });
    return send(env, chatId, coursesText(catalog, current), { reply_markup: coursesKeyboard(catalog, current, next) });
  }
  if (command === "/stop") {
    if (sub) {
      await env.BOT_KV.delete(`sub:${chatId}`);
      return send(env, chatId, "Вы отписаны от уведомлений. /start — подписаться снова.",
        { reply_markup: { remove_keyboard: true } });
    }
    return send(env, chatId, "Вы и так не подписаны. /start — выбрать группу.");
  }
  const key = findGroup(text, catalog);
  if (key) return subscribe(env, chatId, key, catalog, sub);
  // любой другой текст от подписчика — поиск по материалам
  if (current && text && !text.startsWith("/") && msg.chat.type === "private") {
    return send(env, chatId, await searchText(env, catalog, current, text));
  }
  if (msg.chat.type === "private") {
    return send(env, chatId, "Не понял. Выберите группу на клавиатуре внизу или нажмите /start.",
      { reply_markup: groupsKeyboard(catalog, current) });
  }
}

async function handleCallback(cq, catalog, env) {
  const data = cq.data || "";
  const msg = cq.message;
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (!catalog || !msg) return answer("Бот ещё настраивается");

  const chatId = String(msg.chat.id);
  const sub = await getSub(env, chatId);

  if (data.startsWith("g:")) {
    // inline-кнопки групп из старых сообщений бота
    let key = data.slice(2);
    if (key === "my-group") key = "m104";
    if (!catalog.groups.some((g) => g.key === key)) return answer("Выберите группу заново: /start");
    await answer("Готово");
    return subscribe(env, chatId, key, catalog, sub);
  }

  if (data.startsWith("c:")) {
    const cid = data.slice(2);
    const current = sub && catalog.groups.some((g) => g.key === sub.g) ? sub.g : null;
    const name = current && (catalog.course_names[current] || {})[cid];
    if (!name) return answer("Этот список устарел, откройте «Мои курсы» заново");
    const muted = sub.m || [];
    const mute = !muted.includes(cid);
    const next = mute ? [...muted, cid] : muted.filter((c) => c !== cid);
    await putSub(env, chatId, { ...sub, g: current, m: next });
    await answer(`${mute ? "🔕 Отключено" : "🔔 Включено"}: ${name}`.slice(0, 200));
    return tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: msg.message_id, reply_markup: coursesKeyboard(catalog, current, next),
    });
  }
  if (data.startsWith("d:")) {
    const id = data.slice(2);
    if (!sub || !catalog.groups.some((g) => g.key === sub.g)) return answer("Сначала выберите группу: /start");
    const upcoming = (catalog.deadlines[sub.g] || []).map((d) => d.id);
    const done = (await getDone(env, chatId)).filter((x) => upcoming.includes(x)); // прошедшие забываем
    const nowDone = !done.includes(id);
    await putDone(env, chatId, nowDone ? [...done, id] : done.filter((x) => x !== id));
    await answer(nowDone ? "✅ Отмечено как сдано — напоминаний не будет" : "↩️ Отметка снята");
    // переворачиваем только нажатую кнопку, остальные оставляем как есть
    const kb = (msg.reply_markup && msg.reply_markup.inline_keyboard) || [];
    const flipped = kb.map((row) => row.map((b) => {
      if (b.callback_data !== data) return b;
      const name = b.text.replace(/^(✅ Сдал|↩️ Не сдал): /, "");
      return { text: `${nowDone ? "↩️ Не сдал" : "✅ Сдал"}: ${name}`, callback_data: data };
    }));
    return tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: flipped },
    });
  }

  if (data.startsWith("r:") || data === "f" || data === "s") {
    if (!sub || !catalog.groups.some((g) => g.key === sub.g)) return answer("Сначала выберите группу: /start");
    let next, note;
    if (data === "f") {
      next = { ...sub, f: sub.f === false };
      note = next.f ? "📎 Файлы будут приходить в чат" : "Файлы — только ссылкой";
    } else if (data === "s") {
      next = { ...sub, s: !sub.s };
      note = next.s ? "🗞 Новые файлы — одной сводкой в 20:00" : "Новые файлы — сразу";
    } else {
      const sec = Number(data.slice(2));
      const r = reminders(sub);
      const on = !r.includes(sec);
      next = { ...sub, r: on ? [...r, sec] : r.filter((x) => x !== sec) };
      const label = (REMINDER_OPTIONS.find(([s]) => s === sec) || [0, ""])[1];
      note = `${on ? "✅ Напомню" : "Не напоминать"} ${label}`;
    }
    await putSub(env, chatId, next);
    await answer(note);
    return tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: msg.message_id, reply_markup: settingsKeyboard(next),
    });
  }
  return answer("");
}
