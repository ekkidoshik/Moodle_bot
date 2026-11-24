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
// s: сводка в 20:00}, "done:<chat_id>" = {d: [id сданных дедлайнов]}, "watchdog",
// "subs_version" — метка последнего изменения подписчиков: бот перечитывает список
// (KV list — 1000 в сутки бесплатно), только когда метка сменилась.
// (дублируется в metadata, чтобы список подписчиков читался одним list без get).
// Секреты Worker: TELEGRAM_BOT_TOKEN, BOT_SYNC_SECRET (его SHA-256 — secret_token webhook).

const BTN_COURSES = "📚 Мои курсы";
const BTN_DEADLINES = "⏰ Дедлайны";
const BTN_SAVED = "⭐ Избранное";
const BTN_SETTINGS = "⚙️ Настройки";
const BTN_APP = "🎓 Мини-приложение";
const BTN_SUPPORT = "💬 Поддержка";
const OLD_BTN_SUPPORT = "💬 Связаться с поддержкой";
const UPLOAD_PROMPT = "Выберите группы, затем нажмите «Разослать файл».";
const LEGACY_STUDENT_FILE_PROMPT = "Прикрепите документ ответом на это сообщение. Можно добавить подпись к файлу. После этого выберите группы для рассылки.";
const PREVIOUS_STUDENT_FILE_PROMPT = "Прикрепите файл через скрепку и выберите «Файл». Можно добавить подпись. После отправки бот предложит выбрать группы.";
const FILE_PICKER_INSTRUCTIONS = "Нажмите скрепку → «Файл» → «Файлы» (или «Обзор») и выберите документ в приложении «Файлы». Не выбирайте его в разделе «Недавние» Telegram.";
const STUDENT_FILE_PROMPT = `${FILE_PICKER_INSTRUCTIONS}\n\nМожно добавить подпись. После отправки бот предложит выбрать группы.`;
const STUDENT_GROUP_PROMPT = "Выберите группы, затем нажмите «На проверку». Файл увидит администратор.";
const REVIEW_PROMPT = "Файл на модерации. Проверьте документ и группы перед рассылкой.";
const SUPPORT_PROMPT = "Напишите в поддержку ответом на это сообщение. Здесь можно задать вопрос или попросить добавить именно вашу группу в бота.";
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

    if ((request.method === "GET" && url.pathname.startsWith("/mini-api/")) ||
        (request.method === "POST" && ["/mini-api/group", "/mini-api/support", "/mini-api/favorites", "/mini-api/file"].includes(url.pathname)) ||
        (request.method === "DELETE" && url.pathname === "/mini-api/favorites")) {
      return miniAppData(request, url, env);
    }

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

    if (request.method === "POST" && ["/telegram", "/telegram/support"].includes(url.pathname)) {
      const supportOnly = url.pathname === "/telegram/support";
      if (supportOnly && !env.SUPPORT_BOT_TOKEN) return new Response("not found", { status: 404 });
      const secret = supportOnly ? await supportWebhookToken(env) : await webhookToken(env);
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        if (supportOnly) {
          const catalog = await getCatalog(env);
          const msg = update.message;
          if (msg?.chat.type === "private" && catalog && isAdmin(catalog, String(msg.chat.id))) {
            await handleSupportReply(msg, env, env.SUPPORT_BOT_TOKEN);
          }
        } else {
          await handleUpdate(update, env, url.origin);
        }
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
        // без KV list (их 1000 в сутки): число подписчиков — из отчёта бота
        subscribers_in_worker: ((await env.BOT_KV.get("report", "json")) || {}).subscribers ?? null,
        last_bot_run: await env.BOT_KV.get("report", "json"),
        bot_description: ((await tg(env, "getMyDescription", {})).result || {}).description || null,
        bot_short_description: ((await tg(env, "getMyShortDescription", {})).result || {}).short_description || null,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.BOT_SYNC_SECRET.trim()}`) {
        return new Response("forbidden", { status: 403 });
      }
      if (request.method === "GET" && url.pathname === "/api/main-keyboard") {
        return json(mainKeyboard());
      }
      if (request.method === "GET" && url.pathname === "/api/subscribers") {
        const since = url.searchParams ? url.searchParams.get("since") : null;
        if (since === null) return json(await listSubscribers(env)); // старый формат
        const version = (await env.BOT_KV.get("subs_version")) || "0";
        if (since === version) return json({ version, unchanged: true });
        return json({ version, subs: await listSubscribers(env) });
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
        if (body.remove && body.remove.length) await touchSubs(env);
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
        // KV бесплатно — 1000 записей в сутки, а отчёт приходит каждые несколько минут:
        // пишем, если что-то поменялось или сохранённому отчёту больше 20 минут (сторожу хватит)
        const report = await request.json();
        const prev = await env.BOT_KV.get("report", "json");
        const strip = (r) => JSON.stringify({ ...r, ts: 0, time: "", state_bytes: 0 });
        const fresh = prev && prev.ts && report.ts - prev.ts < 20 * 60;
        if (!(prev && fresh && strip(prev) === strip(report))) {
          await env.BOT_KV.put("report", JSON.stringify(report));
        }
        return json({ ok: true });
      }
      // индекс поиска — храним как пришёл, без разбора (экономим CPU)
      const upload = url.pathname.match(/^\/api\/(index)\/([a-z0-9_]+)$/);
      if (request.method === "PUT" && upload) {
        await env.BOT_KV.put(`${upload[1]}:${upload[2]}`, await request.text());
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/broadcasts/take") {
        const queue = (await env.BOT_KV.get("broadcasts", "json")) || [];
        if (queue.length) await env.BOT_KV.delete("broadcasts");
        return json(queue);
      }
      if (request.method === "GET" && url.pathname === "/api/file-requests") {
        const { keys } = await env.BOT_KV.list({ prefix: "file-request:", limit: 3 });
        const jobs = await Promise.all(keys.map(async ({ name }) => ({
          id: name.slice("file-request:".length), job: await env.BOT_KV.get(name, "json"),
        })));
        return json(jobs.filter(({ job }) => job));
      }
      const fileRequest = url.pathname.match(/^\/api\/file-requests\/([0-9a-f-]+)$/);
      if (request.method === "DELETE" && fileRequest) {
        await env.BOT_KV.delete(`file-request:${fileRequest[1]}`);
        return json({ ok: true });
      }
      if (request.method === "PUT" && url.pathname === "/api/catalog") {
        await env.BOT_KV.put("catalog", await request.text());
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

function supportWebhookToken(env) {
  return sha256hex(`support-webhook:${env.BOT_SYNC_SECRET.trim()}`);
}

// Токен прежней (длинной) ссылки на календарь — оставлен, чтобы старые подписки не сломались
async function calendarToken(env, group) {
  return (await sha256hex(`${env.BOT_SYNC_SECRET.trim()}:calendar:${group}`)).slice(0, 20);
}

// ------------------------------ Хранилище ------------------------------

function json(data) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

async function telegramMiniUser(header, token) {
  if (!header?.startsWith("tma ") || !token) return null;
  const params = new URLSearchParams(header.slice(4));
  const hash = params.get("hash");
  const age = Date.now() / 1000 - Number(params.get("auth_date"));
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(age) || age < -60 || age > 3600) return null;
  params.delete("hash");
  if (new Set(params.keys()).size !== params.size) return null;
  params.sort();
  const encoder = new TextEncoder();
  const hmac = { name: "HMAC", hash: "SHA-256" };
  const base = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), hmac, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", base, encoder.encode(token));
  const key = await crypto.subtle.importKey("raw", secret, hmac, false, ["verify"]);
  const signature = Uint8Array.from(hash.match(/../g), (hex) => parseInt(hex, 16));
  const data = Array.from(params, ([name, value]) => `${name}=${value}`).join("\n");
  if (!await crypto.subtle.verify("HMAC", key, signature, encoder.encode(data))) return null;
  try {
    const user = JSON.parse(params.get("user"));
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}

async function miniAppData(request, url, env) {
  const respond = (data, status = 200) => Response.json(data, {
    status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
  const user = await telegramMiniUser(request.headers.get("Authorization"), env.TELEGRAM_BOT_TOKEN);
  if (!user) return respond({ error: "Откройте мини-приложение заново из Telegram." }, 401);
  const chatId = String(user.id);
  const route = url.pathname.slice("/mini-api/".length);
  if (route === "favorites" && request.method !== "POST") {
    const prefix = `saved:${chatId}:`;
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!/^(?:m|assign|quiz):\d+$/.test(id || "")) return respond({ error: "Материал не найден." }, 400);
      await env.BOT_KV.delete(prefix + id);
      return respond({ ok: true });
    }
    const cursor = url.searchParams.get("cursor") || undefined;
    const page = await env.BOT_KV.list({ prefix, cursor, limit: 24 });
    const items = await Promise.all(page.keys.map(async ({ name, metadata }) => {
      const item = metadata || await env.BOT_KV.get(name, "json");
      return item && { id: name.slice(prefix.length), name: item.n, url: item.u,
        course: item.course, files: item.files || [] };
    }));
    return respond({ items: items.filter(Boolean), cursor: page.list_complete ? null : page.cursor });
  }
  const [catalog, previous] = await Promise.all([getCatalog(env), getSub(env, chatId)]);
  if (!catalog) return respond({ error: "Каталог Moodle ещё загружается." }, 503);
  const body = request.method === "POST" ? await request.json().catch(() => null) : null;
  if (route === "support" && request.method === "POST") {
    if (body?.uploadAccess === true) {
      const prompt = await requestStudentFile(env, chatId);
      return prompt.ok ? respond({ ok: true }) :
        respond({ error: "Откройте чат Moodle-бота и отправьте /submit_file." }, 502);
    }
    const message = typeof body?.text === "string" ? body.text.trim() : "";
    if (!message || message.length > 3500) return respond({ error: "Введите сообщение до 3500 символов." }, 400);
    const ok = await forwardSupport(env, catalog, previous, chatId, Date.now(), message);
    return ok ? respond({ ok: true }) : respond({ error: "Не удалось отправить сообщение. Попробуйте позже." }, 502);
  }
  if (route === "favorites" && request.method === "POST") {
    if (!catalog.groups.some((g) => g.key === previous?.g)) return respond({ error: "Сначала выберите группу." }, 403);
    if (typeof body?.id !== "string" || !/^m:\d+$/.test(body.id)) return respond({ error: "Материал не найден." }, 400);
    return await saveItem(env, catalog, chatId, previous.g, body.id)
      ? respond({ ok: true }) : respond({ error: "Материал недоступен." }, 404);
  }
  if (route === "file" && request.method === "POST") {
    const group = catalog.groups.find((g) => g.key === previous?.g);
    if (!group) return respond({ error: "Сначала выберите группу." }, 403);
    if (typeof body?.id !== "string" || !/^m:\d+$/.test(body.id) || typeof body.path !== "string") {
      return respond({ error: "Файл не найден." }, 400);
    }
    const index = (await env.BOT_KV.get(`index:${group.key}`, "json")) || [];
    const material = index.find((m) => m.id === body.id.slice(2) &&
      Object.hasOwn(catalog.course_names[group.key] || {}, m.c) && m.f?.includes(body.path));
    if (!material) return respond({ error: "Файл недоступен. Обновите список материалов." }, 404);
    return await queueFile(env, chatId, group.key, material, body.path)
      ? respond({ ok: true }) : respond({ error: "Не удалось запросить файл. Попробуйте позже." }, 503);
  }
  let sub = previous;
  if (request.method === "POST") {
    if (!catalog.groups.some((g) => g.key === body?.group)) {
      return respond({ error: "Выберите группу из списка." }, 400);
    }
    if (previous?.g !== body.group) {
      sub = { ...previous, g: body.group, m: [] };
      await putSub(env, chatId, sub);
    }
  }
  const group = catalog.groups.find((g) => g.key === sub?.g);
  const profile = { firstName: user.first_name, group: group?.title ?? null,
    groupKey: group?.key ?? null, groups: catalog.groups.map(({ key, title }) => ({ key, title })) };
  if (!group) return route === "overview"
    ? respond({ ...profile, courses: [], deadlines: [] }) : respond({ error: "Сначала выберите группу." }, 403);

  const names = catalog.course_names[group.key] || {};
  if (route === "overview" || request.method === "POST") {
    const done = new Set(await getDone(env, chatId));
    const now = Date.now() / 1000;
    const courses = Object.entries(names).map(([id, name]) => ({ id, name, muted: (sub.m || []).includes(id) }));
    const deadlines = (catalog.deadlines[group.key] || [])
      .filter((d) => d.due > now && !done.has(d.id) && !(sub.m || []).includes(d.course) && Object.hasOwn(names, d.course))
      .map(({ name, course, kind, due, url }) => ({ name, course, kind, due, url }))
      .sort((a, b) => a.due - b.due);
    return respond({ ...profile, courses, deadlines });
  }
  if (route !== "materials") return respond({ error: "Страница не найдена." }, 404);
  const course = url.searchParams.get("course");
  if (course && !Object.hasOwn(names, course)) return respond({ error: "Курс недоступен." }, 404);
  const words = norm((url.searchParams.get("q") || "").trim().slice(0, 120)).split(/\s+/).filter(Boolean);
  if (!course && !words.length) return respond({ items: [], more: false });
  const index = (await env.BOT_KV.get(`index:${group.key}`, "json")) || [];
  const items = index.filter((m) => Object.hasOwn(names, m.c) && (!course || m.c === course) &&
    (!words.length || words.every((word) => norm([m.n, ...(m.f || [])].join(" ")).includes(word))))
    .sort((a, b) => (b.t || 0) - (a.t || 0));
  const page = Math.max(0, Math.min(1000, parseInt(url.searchParams.get("page"), 10) || 0));
  const offset = page * 24;
  return respond({
    items: items.slice(offset, offset + 24).map((m) => ({ id: `m:${m.id}`, name: m.n, url: m.u,
      course: names[m.c], files: m.f || [] })),
    more: items.length > offset + 24,
  });
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
  await touchSubs(env);
}

async function touchSubs(env) {
  // время внутри запроса Worker «заморожено» — добавляем случайную часть, чтобы метка менялась всегда
  await env.BOT_KV.put("subs_version", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  if (!ids.length) await env.BOT_KV.delete(`done:${chatId}`);
  else await env.BOT_KV.put(`done:${chatId}`, JSON.stringify({ d: ids }), { metadata: { d: ids } });
  await touchSubs(env);
}

// ------------------------------ Telegram -------------------------------

async function tg(env, method, body, token = env.TELEGRAM_BOT_TOKEN) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
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
  const buttons = catalog.groups.map((g) => ({
    text: (g.key === current ? "✅ " : "") + g.title,
    callback_data: `g:${g.key}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: BTN_COURSES }, { text: BTN_DEADLINES }],
      [{ text: BTN_SETTINGS }, { text: BTN_SAVED }],
      [{ text: BTN_SUPPORT }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

// как часто бот проверяет Moodle — приходит из каталога (CHECK_EVERY_MIN в moodle_bot.py)
function checkEvery(catalog) {
  return (catalog && catalog.check_every) || 5;
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

function courseButtonLabel(name, otherNames) {
  const chars = Array.from(name);
  if (chars.length <= 34) return name;
  const similar = otherNames.filter((other) =>
    other !== name && other.startsWith(chars.slice(0, 18).join("")) && other.endsWith(chars.slice(-15).join("")));
  if (similar.length) {
    const shared = chars.findIndex((_, i) => similar.every((other) => Array.from(other)[i] !== chars[i]));
    if (shared >= 0) {
      const start = Math.max(10, shared - 5);
      return `${chars.slice(0, 10).join("").trimEnd()}…${chars.slice(start, start + 22).join("").trim()}${start + 22 < chars.length ? "…" : ""}`;
    }
  }
  return `${chars.slice(0, 18).join("").trimEnd()}…${chars.slice(-15).join("").trimStart()}`;
}

function showCourses(env, chatId, catalog, key, muted, page = 0) {
  const courses = Object.entries(catalog.course_names[key] || {})
    .sort((a, b) => a[1].localeCompare(b[1], "ru") || Number(a[0]) - Number(b[0]));
  const group = esc(groupTitle(catalog, key));
  if (!courses.length) {
    return send(env, chatId, `Курсы группы <b>${group}</b> появятся после ближайшей проверки Moodle (до ${checkEvery(catalog)} минут).`);
  }

  const pageSize = 5;
  const last = Math.ceil(courses.length / pageSize) - 1;
  const current = Math.min(page, last);
  const offset = current * pageSize;
  const shown = courses.slice(offset, offset + pageSize);
  const names = shown.map(([, name]) => `• ${esc(name)}`);
  const titles = shown.map(([, name]) => name);
  const rows = shown.map(([cid, name]) => [
    { text: `📂 ${courseButtonLabel(name, titles)}`, callback_data: `course:${cid}:${current}` },
    { text: muted.includes(cid) ? "🔕" : "🔔", callback_data: `c:${cid}` },
  ]);
  const nav = [];
  if (current > 0) nav.push({ text: "← Назад", callback_data: `courses:${current - 1}` });
  if (current < last) nav.push({ text: "Далее →", callback_data: `courses:${current + 1}` });
  if (nav.length) rows.push(nav);
  const pageLabel = last ? ` · ${current + 1}/${last + 1}` : "";
  return send(env, chatId, `📚 Курсы группы <b>${group}</b>${pageLabel}\n\n${names.join("\n\n")}\n\n` +
    "Нажмите название, чтобы открыть курс. Колокольчик рядом управляет уведомлениями.",
    { reply_markup: { inline_keyboard: rows } });
}

function doneButton(d, isDone) {
  return [{ text: `${isDone ? "↩️ Не сдал" : "✅ Сдал"}: ${d.name.slice(0, 40)}`, callback_data: `d:${d.id}` }];
}

function saveButton(id) {
  return { text: "⭐ Сохранить", callback_data: `sv:${id}` };
}

function itemLink(item) {
  const name = esc(item.n.slice(0, 100));
  return /^https?:\/\//i.test(item.u || "") ? `<a href="${esc(item.u)}">${name}</a>` : name;
}

function courseMaterialRows(materials, coursesPage) {
  return materials.filter((m) => m.id && (m.u || m.f?.length)).map((m) => [
    ...(m.f?.length ? [{ text: `📎 ${m.n.slice(0, 40)}`, callback_data: `files:${m.c}:${m.id}:0:${coursesPage}` }] : []),
    ...(m.u ? [{ ...saveButton(`m:${m.id}`), text: m.f?.length ? "⭐" : `⭐ ${m.n.slice(0, 40)}` }] : []),
  ]);
}

function courseMaterialLine(material) {
  return material.f?.length ? esc(material.n.slice(0, 100)) : itemLink(material);
}

async function courseMaterials(env, catalog, key, chatId, cid, page, filter, coursesPage) {
  const index = (await env.BOT_KV.get(`index:${key}`, "json")) || [];
  const query = { ktp: "ктп", brs: "брс" }[filter];
  const materials = index.filter((m) => m.c === cid &&
    (!query || norm([m.n, ...(m.f || [])].join(" ")).includes(query)))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  const pageSize = 8;
  const last = Math.max(0, Math.ceil(materials.length / pageSize) - 1);
  const current = Math.min(page, last);
  const shown = materials.slice(current * pageSize, (current + 1) * pageSize);
  const title = query ? query.toUpperCase() : "Все материалы";
  const name = esc(catalog.course_names[key][cid].slice(0, 180));
  const lines = shown.map((m) => {
    const filenames = (m.f || []).slice(0, 2).map((file) => esc(file.slice(0, 85)));
    return `• ${courseMaterialLine(m)}` + (filenames.length ? `\n   📎 ${filenames.join(", ")}` : "");
  });
  const rows = courseMaterialRows(shown, coursesPage);
  const nav = [];
  if (current > 0) nav.push({ text: "← Назад", callback_data: `materials:${cid}:${filter}:${current - 1}:${coursesPage}` });
  if (current < last) nav.push({ text: "Далее →", callback_data: `materials:${cid}:${filter}:${current + 1}:${coursesPage}` });
  if (nav.length) rows.push(nav);
  rows.push([
    { text: "Все", callback_data: `materials:${cid}:all:0:${coursesPage}` },
    { text: "КТП", callback_data: `materials:${cid}:ktp:0:${coursesPage}` },
    { text: "БРС", callback_data: `materials:${cid}:brs:0:${coursesPage}` },
  ], [{ text: "К папке курса", callback_data: `course:${cid}:${coursesPage}` }]);
  return send(env, chatId, `📂 <b>${name} · ${title}</b> · ${current + 1}/${last + 1}\n\n` +
    (lines.join("\n\n") || "Материалы не найдены."), { reply_markup: { inline_keyboard: rows } });
}

async function courseFolder(env, catalog, key, chatId, cid, coursesPage) {
  const name = (catalog.course_names[key] || {})[cid];
  const base = catalog.moodle_url || "https://on2026.econ.msu.ru";
  const [index, done] = await Promise.all([
    env.BOT_KV.get(`index:${key}`, "json"),
    getDone(env, chatId),
  ]);
  const deadlines = (catalog.deadlines[key] || [])
    .filter((d) => d.course === cid && d.due > Date.now() / 1000 && !done.includes(d.id))
    .sort((a, b) => a.due - b.due).slice(0, 5);
  const materials = (index || []).filter((m) => m.c === cid)
    .sort((a, b) => (b.t || 0) - (a.t || 0) || Number(b.id || 0) - Number(a.id || 0))
    .slice(0, 5);
  const deadlineLines = deadlines.map((d) => `• ${itemLink({ n: d.name, u: d.url })} · ${fmtTime(d.due)}`);
  const materialLines = materials.map((m) => `• ${courseMaterialLine(m)}`);
  const text = [
    `📂 <b>${esc(name.slice(0, 180))}</b>`,
    `<b>Ближайшие дедлайны</b>\n${deadlineLines.join("\n") || "Нет несданных дедлайнов"}`,
    `<b>Последние материалы</b>\n${materialLines.join("\n") || "Материалов пока нет"}`,
  ].join("\n\n");
  const rows = [
    [{ text: "Открыть курс в Moodle", url: `${base}/course/view.php?id=${cid}` }],
    ...deadlines.map((d) => [{ ...saveButton(d.id), text: `⭐ ${d.name.slice(0, 40)}` }]),
    [{ text: "Все материалы", callback_data: `materials:${cid}:all:0:${coursesPage}` }],
    ...courseMaterialRows(materials, coursesPage),
    [{ text: "← Назад к курсам", callback_data: `courses:${coursesPage}` }],
  ];
  return send(env, chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function savedMessage(env, chatId, page) {
  const prefix = `saved:${chatId}:`;
  const { keys } = await env.BOT_KV.list({ prefix });
  if (!keys.length) {
    return send(env, chatId, "⭐ Избранное пусто. Нажмите ⭐ под уведомлением или в папке курса, чтобы сохранить ссылку.");
  }
  const pageSize = 8;
  const lastPage = Math.ceil(keys.length / pageSize) - 1;
  const current = Math.min(page, lastPage);
  const items = await Promise.all(keys.slice(current * pageSize, (current + 1) * pageSize)
    .map(async ({ name, metadata }) => ({ name, item: metadata || await env.BOT_KV.get(name, "json") })));
  const available = items.filter(({ item }) => item);
  const lines = available.map(({ item }) => `• ${itemLink(item)}\n  ${esc(item.course.slice(0, 100))}`);
  const rows = available.map(({ name, item }) => [
    { text: `✕ ${item.n.slice(0, 40)}`, callback_data: `rm:${name.slice(prefix.length)}` },
  ]);
  const nav = [];
  if (current) nav.push({ text: "← Назад", callback_data: `saved:${current - 1}` });
  if (current < lastPage) nav.push({ text: "Далее →", callback_data: `saved:${current + 1}` });
  if (nav.length) rows.push(nav);
  return send(env, chatId, `⭐ <b>Избранное</b> · ${current + 1}/${lastPage + 1}\n\n${lines.join("\n\n")}`,
    { reply_markup: { inline_keyboard: rows } });
}

async function saveItem(env, catalog, chatId, key, id) {
  const names = catalog.course_names[key] || {};
  let item;
  if (id.startsWith("m:")) {
    const index = (await env.BOT_KV.get(`index:${key}`, "json")) || [];
    item = index.find((m) => m.id === id.slice(2));
  } else {
    const deadline = (catalog.deadlines[key] || []).find((d) => d.id === id);
    if (deadline) item = { n: deadline.name, u: deadline.url, c: deadline.course };
  }
  if (!item || !names[item.c] || !/^https?:\/\//i.test(item.u || "")) return false;
  const storageKey = `saved:${chatId}:${id}`;
  if (await env.BOT_KV.get(storageKey)) return true;
  const metadata = { n: item.n.slice(0, 150), u: item.u, course: names[item.c].slice(0, 100) };
  if (item.f?.length) metadata.files = item.f.slice(0, 3).map((file) => file.slice(0, 120));
  const value = JSON.stringify(metadata);
  const options = new TextEncoder().encode(value).length <= 1024 ? { metadata } : {};
  await env.BOT_KV.put(storageKey, value, options);
  return true;
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
    markup: { inline_keyboard: items.slice(0, 10).map((d) => [...doneButton(d, done.includes(d.id)), saveButton(d.id)]) },
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
    "🗞 Сводка — ссылки одним сообщением в 20:00. Если включены «Файлы в чат», вложения приходят сразу. " +
    "Напоминания о дедлайнах приходят как обычно.");
}

function settingsKeyboard(sub) {
  const r = reminders(sub);
  const btn = ([sec, label]) => ({ text: `${r.includes(sec) ? "✅" : "▫️"} ${label}`, callback_data: `r:${sec}` });
  return {
    inline_keyboard: [
      [{ text: "Сменить группу", callback_data: "choose_group" }],
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

async function sendSearch(env, chatId, catalog, key, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return send(env, chatId, "🔎 Напишите, что найти, например: <code>/search лекция 5</code> — или просто отправьте слово сообщением.");
  }
  const index = (await env.BOT_KV.get(`index:${key}`, "json")) || [];
  const names = catalog.course_names[key] || {};
  const found = index.filter((m) => {
    const hay = norm(`${m.n} ${(m.f || []).join(" ")} ${names[m.c] || ""}`);
    return words.every((w) => hay.includes(w));
  });
  if (!found.length) return send(env, chatId, `🔎 По запросу «${esc(query.trim().slice(0, 120))}» ничего не нашлось.`);
  const results = found.slice(0, SEARCH_LIMIT);
  const rows = [];
  const lines = results.map((m, i) => {
    const title = courseMaterialLine(m);
    const files = (m.f || []).filter((f) => words.some((w) => norm(f).includes(w)));
    const shown = (files.length ? files : m.f || []).slice(0, 1);
    if (shown.length) rows.push([{
      text: `📎 ${i + 1}. ${(m.f.length === 1 ? shown[0].split("/").pop() : m.n).slice(0, 42)}`,
      callback_data: `files:${m.c}:${m.id}:0`,
    }]);
    return `${i + 1}. ${title}\n   ${esc((names[m.c] || `Курс ${m.c}`).slice(0, 72))}` +
      (shown.length ? `\n   📎 ${esc(shown[0].slice(0, 64))}` : "");
  });
  const more = found.length > SEARCH_LIMIT ? `\n\nПоказаны первые ${SEARCH_LIMIT} из ${found.length} — уточните запрос.` : "";
  const hint = rows.length ? "\n\nНажмите 📎, чтобы получить файл в Telegram." : "";
  return send(env, chatId, `🔎 Нашлось ${found.length}:\n\n` + lines.join("\n\n") + more + hint,
    rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
}

async function queueFile(env, chatId, group, material, path) {
  try {
    await env.BOT_KV.put(`file-request:${crypto.randomUUID()}`, JSON.stringify({
      chat: chatId, group, cid: material.c, mid: material.id, path,
    }), { expirationTtl: 3600 });
    return true;
  } catch (e) {
    console.log("Не удалось записать запрос на файл:", e.message);
    return false;
  }
}

function isAdmin(catalog, chatId) {
  return !!(catalog.admin && String(catalog.admin).trim() === chatId);
}

function supportMenu(env, chatId) {
  return send(env, chatId, "💬 <b>Поддержка</b>\nВыберите действие.", {
    reply_markup: { inline_keyboard: [
      [{ text: "Написать в поддержку", callback_data: "support_write" }],
      [{ text: "Предложить файл для публикации", callback_data: "support_upload" }],
    ] },
  });
}

function supportPrompt(env, chatId) {
  return send(env, chatId, SUPPORT_PROMPT, {
    reply_markup: { force_reply: true, input_field_placeholder: "Сообщение для поддержки" },
  });
}

function replyFromBot(msg, token) {
  const reply = msg.reply_to_message;
  return reply && String(reply.from?.id) === token.split(":")[0] ? reply.text : undefined;
}

async function supportSignature(env, reference) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BOT_SYNC_SECRET.trim()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`support-reply:${reference}`));
  return Array.from(new Uint8Array(mac).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function submitSupport(msg, catalog, env) {
  const chatId = String(msg.chat.id);
  const text = msg.text?.trim();
  if (!text || text.length > 3500) {
    await send(env, chatId, "Поддержка принимает текст до 3500 символов.");
    return supportPrompt(env, chatId);
  }
  const sub = await getSub(env, chatId);
  const ok = await forwardSupport(env, catalog, sub, chatId, msg.message_id, text);
  return send(env, chatId, ok ? "Сообщение отправлено в поддержку." :
    "Не удалось отправить сообщение в поддержку. Попробуйте позже.");
}

async function forwardSupport(env, catalog, sub, chatId, messageId, text) {
  const admin = String(catalog?.admin || "").trim();
  if (!admin) return false;
  const group = sub ? groupTitle(catalog, sub.g).slice(0, 150) : "группа не выбрана";
  const reference = `${chatId}:${messageId}`;
  const signature = await supportSignature(env, reference);
  const body = {
    chat_id: admin,
    text: `Обращение #${reference}:${signature}\nГруппа: ${group}\nОтветьте на это сообщение, чтобы написать студенту.\n\n${text}`,
    link_preview_options: { is_disabled: true },
  };
  let delivered = env.SUPPORT_BOT_TOKEN && await tg(env, "sendMessage", body, env.SUPPORT_BOT_TOKEN);
  if (!delivered?.ok) delivered = await tg(env, "sendMessage", body);
  return delivered.ok;
}

async function handleSupportReply(msg, env, token) {
  const notice = replyFromBot(msg, token) || "";
  const route = notice.match(/^Обращение #(\d{1,16}:\d{1,16}):([a-f0-9]{32})\n/);
  if (!route || await supportSignature(env, route[1]) !== route[2]) return false;
  const admin = String(msg.chat.id);
  const text = msg.text?.trim();
  if (!text || text.length > 4000) {
    await tg(env, "sendMessage", { chat_id: admin, text: "Введите текст ответа до 4000 символов." }, token);
    return true;
  }
  const delivered = await tg(env, "sendMessage", {
    chat_id: route[1].split(":")[0], text: `💬 Ответ поддержки\n\n${text}`,
    link_preview_options: { is_disabled: true },
  });
  await tg(env, "sendMessage", {
    chat_id: admin, text: delivered.ok ? "Ответ отправлен." : "Не удалось доставить ответ студенту.",
  }, token);
  return true;
}

async function setupSupportWebhook(env, chatId, origin) {
  const token = env.SUPPORT_BOT_TOKEN;
  if (!token || token.split(":")[0] === env.TELEGRAM_BOT_TOKEN.split(":")[0]) {
    return send(env, chatId, "Задайте отдельный токен SUPPORT_BOT_TOKEN в Cloudflare Worker.");
  }
  const set = await tg(env, "setWebhook", {
    url: `${origin}/telegram/support`,
    secret_token: await supportWebhookToken(env),
    allowed_updates: ["message"],
  }, token);
  if (!set.ok) return send(env, chatId, "Не удалось подключить бота поддержки. Проверьте его токен.");
  const probe = await tg(env, "sendMessage", {
    chat_id: chatId, text: "Бот поддержки подключён. Здесь будут обращения студентов.",
  }, token);
  return send(env, chatId, probe.ok ? "Отдельный бот поддержки подключён." :
    "Webhook подключён. Нажмите «Начать» у отдельного бота и повторите /support_setup.");
}

async function statsText(env, catalog) {
  const subs = await listSubscribers(env);
  const all = Object.values(subs);
  const lines = catalog.groups.map((g) => {
    const mine = all.filter((s) => s.group === g.key);
    const noFiles = mine.filter((s) => s.files === false).length;
    return `• <b>${esc(g.title)}</b>: ${mine.length}` +
      (noFiles ? `, без файлов: ${noFiles}` : "");
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
  const keys = catalog.groups.map((g) => g.key);
  const requested = first.split(",");
  const multiple = requested.length > 1 &&
    (requested.some((key) => keys.includes(key)) || requested.every((key) => /^[a-z0-9_]+$/.test(key)));
  if (multiple && requested.some((key) => !keys.includes(key))) {
    return send(env, chatId, "Проверьте ключи групп и укажите их через запятую без пробелов.");
  }
  const group = multiple ? [...new Set(requested)] : keys.includes(first) ? first : null;
  const body = (group ? rest.slice(first.length) : rest).trim();
  if (!body) {
    return send(env, chatId,
      "Использование:\n<code>/broadcast текст</code> — всем подписчикам\n" +
      `<code>/broadcast m104,m105 текст</code> — выбранным группам (ключи: ${esc(keys.join(", "))})`);
  }
  return broadcastToSubscribers(env, catalog, chatId, group, body);
}

async function broadcastToSubscribers(env, catalog, chatId, group, body, options = {}) {
  const subs = await listSubscribers(env);
  const groups = Array.isArray(group) ? group : group ? [group] : [];
  const targets = Object.entries(subs).filter(([, s]) => !groups.length || groups.includes(s.group)).map(([c]) => c);
  const whom = groups.length ? groups.map((key) => esc(groupTitle(catalog, key))).join(", ") : "всем";
  const { document, ...messageOptions } = options;
  if (targets.length <= DIRECT_BROADCAST_LIMIT) {
    let ok = 0;
    for (const c of targets) {
      const r = document
        ? await tg(env, "sendDocument", { chat_id: c, document, caption: body })
        : await tg(env, "sendMessage", { chat_id: c, text: body, disable_web_page_preview: true, ...messageOptions });
      if (r.ok) ok++;
    }
    return send(env, chatId, `📣 Отправлено ${whom}: ${ok} из ${targets.length}.`);
  }
  const queue = (await env.BOT_KV.get("broadcasts", "json")) || [];
  queue.push({ group: typeof group === "string" ? group : null,
    ...(Array.isArray(group) ? { groups } : {}), text: body, ...options });
  await env.BOT_KV.put("broadcasts", JSON.stringify(queue));
  return send(env, chatId, `📣 Получателей ${targets.length} (${whom}) — разошлю при ближайшей проверке, в течение ${checkEvery(catalog)} минут.`);
}

function uploadKeyboard(catalog, selected = [], action = "Разослать файл", cancel = "Отмена") {
  const buttons = catalog.groups.map(({ key, title }) => ({
    text: `${selected.includes(key) ? "✅ " : "▫️ "}${title}`, callback_data: `upload_group:${key}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: action, callback_data: "upload_send" },
    { text: cancel, callback_data: "upload_cancel" }]);
  return { inline_keyboard: rows };
}

function requestStudentFile(env, chatId) {
  return send(env, chatId, STUDENT_FILE_PROMPT, { reply_markup: { force_reply: true } });
}

async function sendFileForReview(env, catalog, source, student, selected) {
  const admin = String(catalog.admin || "").trim();
  if (!admin) return false;
  const document = await tg(env, "sendDocument", {
    chat_id: admin, document: source.document.file_id, caption: source.caption || "",
  });
  if (!document.ok) return false;
  const review = await send(env, admin, `${REVIEW_PROMPT}\nОтправитель: ${student}`, {
    reply_parameters: { message_id: document.result.message_id },
    reply_markup: uploadKeyboard(catalog, selected, "Одобрить и разослать", "Отклонить"),
  });
  return review.ok;
}

// ------------------------------ Обработка ------------------------------

async function handleUpdate(update, env, origin) {
  const catalog = await getCatalog(env);
  if (update.message) return handleMessage(update.message, catalog, env, origin);
  if (update.callback_query) return handleCallback(update.callback_query, catalog, env);
}

async function subscribe(env, chatId, key, catalog, sub) {
  // у другой группы другие курсы — отключённые сбрасываем
  const muted = sub && sub.g === key ? sub.m : [];
  await putSub(env, chatId, { ...(sub || {}), g: key, m: muted });
  return send(env, chatId,
    `✅ Группа <b>${esc(groupTitle(catalog, key))}</b> выбрана.\n` +
    "Буду присылать новые и обновлённые файлы из её курсов и напоминать о дедлайнах за сутки и за 3 часа.\n\n" +
    `${BTN_COURSES} — список курсов, ненужные можно отключить.\n` +
    `${BTN_SETTINGS} — когда напоминать о дедлайнах и присылать ли файлы.\n` +
    "🔎 Чтобы найти материал, просто напишите слово, например «лекция 5».\n" +
    "Сменить группу можно в настройках. /stop — отписаться.",
    { reply_markup: mainKeyboard() });
}

async function handleMessage(msg, catalog, env, origin) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";

  if (msg.chat.type === "private" && command === "/menu") {
    return send(env, chatId, "Меню бота", { reply_markup: mainKeyboard() });
  }

  if (msg.chat.type === "private" && (command === "/app" || text === BTN_APP)) {
    return send(env, chatId, "Курсы, дедлайны и материалы в одном месте.", {
      reply_markup: { inline_keyboard: [[{ text: "Открыть мини-приложение", web_app: { url: `${origin}/app/` } }]] },
    });
  }

  if (msg.chat.type === "private" && command === "/submit_file") {
    return requestStudentFile(env, chatId);
  }
  const admin = msg.chat.type === "private" && catalog && isAdmin(catalog, chatId);
  const prompt = msg.chat.type === "private" ? replyFromBot(msg, env.TELEGRAM_BOT_TOKEN) : null;
  const studentFileReply = [STUDENT_FILE_PROMPT, PREVIOUS_STUDENT_FILE_PROMPT, LEGACY_STUDENT_FILE_PROMPT].includes(prompt);
  if (msg.chat.type === "private" && msg.document?.file_id && (!admin || studentFileReply)) {
    if (!catalog?.groups?.length) return send(env, chatId, "Группы пока недоступны. Попробуйте позже.");
    return send(env, chatId, STUDENT_GROUP_PROMPT, {
      reply_parameters: { message_id: msg.message_id },
      reply_markup: uploadKeyboard(catalog, [], "На проверку"),
    });
  }
  if (!command && (studentFileReply || (msg.chat.type === "private" && msg.photo?.length))) {
    return send(env, chatId, FILE_PICKER_INSTRUCTIONS);
  }

  if (admin) {
    if (command === "/upload") return send(env, chatId, "Пришлите документ, затем выберите группы для рассылки. К файлу можно добавить подпись.");
    if (command === "/refresh_keyboard") {
      return broadcastToSubscribers(env, catalog, chatId, null,
        "Меню бота обновилось. Теперь в нём есть кнопка «Поддержка».",
        { reply_markup: mainKeyboard(), disable_notification: true });
    }
    if (command === "/support_setup") return setupSupportWebhook(env, chatId, origin);
    if (await handleSupportReply(msg, env, env.TELEGRAM_BOT_TOKEN)) return;
    if (msg.document?.file_id && catalog.groups.length) {
      return send(env, chatId, UPLOAD_PROMPT, {
        reply_parameters: { message_id: msg.message_id },
        reply_markup: uploadKeyboard(catalog),
      });
    }
  }
  if (msg.chat.type === "private" && (command === "/support" || text === BTN_SUPPORT || text === OLD_BTN_SUPPORT)) {
    return supportMenu(env, chatId);
  }
  if (command !== "/start" && prompt === SUPPORT_PROMPT) {
    return submitSupport(msg, catalog, env);
  }

  if (!catalog || !catalog.groups || !catalog.groups.length) {
    return send(env, chatId, "Бот ещё настраивается. Попробуйте через несколько минут.");
  }
  const sub = await getSub(env, chatId);
  const current = sub && catalog.groups.some((g) => g.key === sub.g) ? sub.g : null;
  const muted = current ? sub.m || [] : [];
  let m;

  if (command === "/start") {
    if (!current) {
      return send(env, chatId, "Выберите свою группу. Буду присылать новые материалы Moodle и напоминать о дедлайнах.",
        { reply_markup: { inline_keyboard: [
          ...groupsKeyboard(catalog, null).inline_keyboard,
          [{ text: BTN_SUPPORT, callback_data: "support" }],
        ] } });
    }
    return send(env, chatId,
      `Сейчас вы подписаны на группу <b>${esc(groupTitle(catalog, current))}</b>. Сменить группу можно в настройках.`,
      { reply_markup: mainKeyboard() });
  }
  if (command === "/courses" || command === "/deadlines" || text === BTN_COURSES || text === BTN_DEADLINES) {
    if (!current) return send(env, chatId, "Сначала выберите группу через /start.");
    if (command === "/courses" || text === BTN_COURSES) {
      return showCourses(env, chatId, catalog, current, muted);
    }
    const dm = deadlinesMessage(catalog, current, muted, await getDone(env, chatId));
    return send(env, chatId, dm.text, dm.markup ? { reply_markup: dm.markup } : {});
  }
  if (command === "/saved" || text === BTN_SAVED) return savedMessage(env, chatId, 0);
  if (command === "/settings" || text === BTN_SETTINGS) {
    if (!current) return send(env, chatId, "Сначала выберите группу: /start");
    return send(env, chatId, settingsText(), { reply_markup: settingsKeyboard(sub) });
  }
  if (command === "/search") {
    if (!current) return send(env, chatId, "Сначала выберите группу: /start");
    return sendSearch(env, chatId, catalog, current, text.replace(/^\/search(@\S+)?/i, ""));
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
    return showCourses(env, chatId, catalog, current, next);
  }
  if (command === "/stop") {
    if (sub) {
      await env.BOT_KV.delete(`sub:${chatId}`);
      await env.BOT_KV.delete(`done:${chatId}`);
      await touchSubs(env);
      return send(env, chatId, "Вы отписаны от уведомлений. /start — подписаться снова.",
        { reply_markup: { remove_keyboard: true } });
    }
    return send(env, chatId, "Вы и так не подписаны. /start — выбрать группу.");
  }
  const key = findGroup(text, catalog);
  if (current && key) {
    return send(env, chatId, "Сменить группу можно в настройках.", { reply_markup: mainKeyboard() });
  }
  // любой другой текст от подписчика — поиск по материалам
  if (current && text && !text.startsWith("/") && msg.chat.type === "private") {
    return sendSearch(env, chatId, catalog, current, text);
  }
  if (msg.chat.type === "private") {
    return send(env, chatId, current ? "Откройте меню бота." : "Сначала выберите группу через /start.",
      current ? { reply_markup: mainKeyboard() } : {});
  }
}

async function handleCallback(cq, catalog, env) {
  const data = cq.data || "";
  const msg = cq.message;
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (data === "support" && msg?.chat.type === "private") {
    await answer();
    return supportMenu(env, String(msg.chat.id));
  }
  if ((data === "support_write" || data === "support_upload") && msg?.chat.type === "private") {
    await answer();
    const chatId = String(msg.chat.id);
    const sent = data === "support_write" ? await supportPrompt(env, chatId) : await requestStudentFile(env, chatId);
    if (sent.ok) await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    return sent;
  }
  if (!catalog || !msg) return answer("Бот ещё настраивается");

  const chatId = String(msg.chat.id);
  const sub = await getSub(env, chatId);
  if (data.startsWith("upload_")) {
    if (msg.chat.type !== "private" || String(cq.from?.id) !== chatId) return answer();
    const source = msg.reply_to_message;
    const studentSubmission = msg.text === STUDENT_GROUP_PROMPT;
    const reviewOwner = msg.text?.startsWith(REVIEW_PROMPT + "\n")
      ? msg.text.match(/\nОтправитель: (\d+)$/)?.[1] : null;
    if (!studentSubmission && !isAdmin(catalog, chatId)) return answer("Одобрить файл может только администратор.");
    const sourceId = reviewOwner ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : chatId;
    if ((!studentSubmission && !reviewOwner && msg.text !== UPLOAD_PROMPT) ||
        !source?.document?.file_id || String(source.from?.id) !== sourceId) {
      return answer("Файл недоступен. Пришлите его заново.");
    }
    const selected = (msg.reply_markup?.inline_keyboard || []).flat()
      .filter((button) => button.callback_data?.startsWith("upload_group:") && button.text.startsWith("✅ "))
      .map((button) => button.callback_data.slice("upload_group:".length))
      .filter((key) => catalog.groups.some((group) => group.key === key));
    const edit = (reply_markup) => tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup });
    if (data.startsWith("upload_group:")) {
      const key = data.slice("upload_group:".length);
      if (!catalog.groups.some((group) => group.key === key)) return answer("Группа больше недоступна.");
      await answer();
      return edit(uploadKeyboard(catalog, selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key],
        studentSubmission ? "На проверку" : reviewOwner ? "Одобрить и разослать" : "Разослать файл",
        reviewOwner ? "Отклонить" : "Отмена"));
    }
    if (data === "upload_send" && !selected.length) return answer("Выберите хотя бы одну группу.");
    if (data !== "upload_send" && data !== "upload_cancel") return answer();
    await answer();
    const locked = await edit({ inline_keyboard: [] });
    if (!locked.ok) return;
    if (data === "upload_cancel") {
      if (reviewOwner) {
        await send(env, reviewOwner, "Администратор отклонил файл. Если хотите уточнить причину, напишите в поддержку.");
        return send(env, chatId, "Файл отклонён.");
      }
      return send(env, chatId, "Отменено.", sub ? { reply_markup: mainKeyboard() } : {});
    }
    if (studentSubmission) {
      if (await sendFileForReview(env, catalog, source, chatId, selected)) {
        return send(env, chatId, "Файл передан администратору. Если он его одобрит, бот разошлёт документ выбранным группам.",
          sub ? { reply_markup: mainKeyboard() } : {});
      }
      await edit(msg.reply_markup);
      return send(env, chatId, "Не удалось передать файл на проверку. Попробуйте ещё раз.");
    }
    return broadcastToSubscribers(env, catalog, chatId, selected, source.caption || "", { document: source.document.file_id });
  }
  const replaceMessage = async (replacement) => {
    const sent = await replacement;
    if (sent.ok) {
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    }
    return sent;
  };

  const fileAction = data.match(/^(files|file):(\d+):(\d+):(\d+)(?::(\d+))?$/);
  if (fileAction) {
    const [, action, cid, mid, position, listPage = "0"] = fileAction;
    const group = sub?.g;
    if (!catalog.course_names[group]?.[cid]) return answer("Откройте актуальный список курсов");
    const index = (await env.BOT_KV.get(`index:${group}`, "json")) || [];
    const material = index.find((m) => m.c === cid && m.id === mid);
    const files = material?.f || [];
    const offset = Number(position);
    if (offset >= files.length) return answer("Файл недоступен. Откройте список материалов заново.");
    if (action === "file" || files.length === 1) {
      if (!await queueFile(env, chatId, group, material, files[offset])) {
        return answer("Не удалось запросить файл. Попробуйте позже.");
      }
      await answer();
      return send(env, chatId, "Бот отправит файл в течение 5 минут.");
    }
    const rows = files.slice(offset, offset + 8).map((path, i) => [
      { text: `📎 ${path.split("/").pop().slice(0, 60)}`, callback_data: `file:${cid}:${mid}:${offset + i}` },
    ]);
    const nav = [];
    if (offset > 0) nav.push({ text: "← Назад", callback_data: `files:${cid}:${mid}:${offset - 8}:${listPage}` });
    if (offset + 8 < files.length) nav.push({ text: "Далее →", callback_data: `files:${cid}:${mid}:${offset + 8}:${listPage}` });
    if (nav.length) rows.push(nav);
    rows.push([{ text: "К папке курса", callback_data: `course:${cid}:${listPage}` }]);
    await answer();
    return replaceMessage(send(env, chatId, `📎 <b>${esc(material.n.slice(0, 100))}</b>\nВыберите файл.`,
      { reply_markup: { inline_keyboard: rows } }));
  }

  const coursesPage = data.match(/^courses:(\d+)$/);
  if (coursesPage) {
    const key = sub?.g;
    if (!catalog.groups.some((g) => g.key === key)) return answer("Сначала выберите группу: /start");
    await answer();
    return replaceMessage(showCourses(env, chatId, catalog, key, sub.m || [], Number(coursesPage[1])));
  }

  const folder = data.match(/^course:(\d+)(?::(\d+))?$/);
  if (folder) {
    const key = sub?.g;
    if (!catalog.course_names[key]?.[folder[1]]) return answer("Откройте актуальный список курсов");
    await answer();
    return replaceMessage(courseFolder(env, catalog, key, chatId, folder[1], folder[2] || "0"));
  }
  const materials = data.match(/^materials:(\d+):(all|ktp|brs):(\d+)(?::(\d+))?$/);
  if (materials) {
    const [, cid, filter, page, listPage = "0"] = materials;
    const key = sub?.g;
    if (!catalog.course_names[key]?.[cid]) return answer("Откройте актуальный список курсов");
    await answer();
    return replaceMessage(courseMaterials(env, catalog, key, chatId, cid, Number(page), filter, listPage));
  }
  const save = data.match(/^sv:((?:m|assign|quiz):\d+)$/);
  if (save) {
    if (!sub || !catalog.groups.some((g) => g.key === sub.g)) return answer("Сначала выберите группу: /start");
    const ok = await saveItem(env, catalog, chatId, sub.g, save[1]);
    return answer(ok ? "⭐ Сохранено в избранном" : "Ссылка недоступна в каталоге группы. Если уведомление новое, попробуйте ещё раз через минуту.");
  }
  const page = data.match(/^saved:(\d+)$/);
  if (page) {
    await answer();
    return replaceMessage(savedMessage(env, chatId, Number(page[1])));
  }
  const remove = data.match(/^rm:((?:m|assign|quiz):\d+)$/);
  if (remove) {
    await env.BOT_KV.delete(`saved:${chatId}:${remove[1]}`);
    return answer("Удалено из избранного. Обновить список — /saved");
  }

  if (data === "choose_group") {
    if (!sub || !catalog.groups.some((g) => g.key === sub.g)) return answer("Сначала выберите группу: /start");
    await answer();
    return replaceMessage(send(env, chatId, "Выберите группу.", { reply_markup: groupsKeyboard(catalog, sub.g) }));
  }

  if (data.startsWith("g:")) {
    let key = data.slice(2);
    if (key === "my-group") key = "m104";
    if (!catalog.groups.some((g) => g.key === key)) return answer("Выберите группу заново: /start");
    await answer("Готово");
    return replaceMessage(subscribe(env, chatId, key, catalog, sub));
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
    const rows = msg.reply_markup?.inline_keyboard;
    if (!rows) return;
    const updated = rows.map((row) => row.map((button) => button.callback_data === data
      ? { ...button, text: mute ? "🔕" : "🔔" } : button));
    return tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: updated },
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
      note = next.s ? "🗞 Ссылки на новые файлы — одной сводкой в 20:00" : "Новые файлы — сразу";
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
