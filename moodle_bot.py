"""
Телеграм-бот, который следит за курсами Moodle нескольких академических групп
и присылает каждому подписчику уведомления только по курсам его группы.

Один запуск = один проход (его делает GitHub Actions раз в CHECK_EVERY_MIN минут):
  1. забираем у Telegram накопившиеся сообщения (getUpdates): /start — показать
     клавиатуру с группами, нажатие кнопки группы или команда /<ключ> из меню —
     подписаться, /courses — список курсов с отключением ненужных,
     /deadlines — ближайшие дедлайны, /stop — отписаться;
  2. для каждой группы из groups.json заходим в Moodle её токеном,
     сравниваем курсы с прошлым снимком и рассылаем изменения подписчикам группы,
     собираем дедлайны заданий и тестов и напоминаем о них за сутки и за 3 часа;
  3. сохраняем state.json (workflow коммитит его обратно в репозиторий).

Переменные окружения:
  TELEGRAM_BOT_TOKEN   — токен бота от @BotFather (обязательно)
  MOODLE_URL           — адрес Moodle без слэша в конце
  GROUPS_FILE          — путь к конфигу групп (по умолчанию groups.json)
  STATE_FILE           — путь к файлу состояния (по умолчанию state.json)
  ADMIN_CHAT_ID        — необязательно: куда писать, если токен группы перестал работать
  RELAY_URL, BOT_SYNC_SECRET — необязательно: адрес Cloudflare Worker (папка worker/)
                         и общий секрет с ним. Если заданы, на сообщения мгновенно
                         отвечает Worker (webhook), а этот скрипт забирает у него
                         подписчиков и отдаёт ему курсы и дедлайны.
  <token_env группы>   — Moodle-токен каждой группы, имя переменной задаётся в groups.json
"""

import difflib
import hashlib
import html
import io
import json
import logging
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree

import requests

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MOODLE_URL = os.getenv("MOODLE_URL") or "https://on2026.econ.msu.ru"
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID", "").strip()
# Как часто внешний cron-job запускает workflow — только для текстов бота
CHECK_EVERY_MIN = int(os.getenv("CHECK_EVERY_MIN", "5"))
RELAY_URL = os.getenv("RELAY_URL", "").strip().rstrip("/")
BOT_SYNC_SECRET = os.getenv("BOT_SYNC_SECRET", "").strip()
GROUPS_FILE = os.getenv("GROUPS_FILE", os.path.join(BASE_DIR, "groups.json"))
STATE_FILE = os.getenv("STATE_FILE", os.path.join(BASE_DIR, "state.json"))

# Старый state.json (до групп) был снимком курсов, видимых через MOODLE_TOKEN.
# При миграции он достаётся группам с этим token_env, чтобы не потерять изменения.
LEGACY_TOKEN_ENV = "MOODLE_TOKEN"

CALLBACK_PREFIX = "g:"

# Ключи групп, которые переименовали в groups.json: старый -> новый.
# Подписки и снимки курсов переезжают на новый ключ при загрузке state.json.
RENAMED_GROUPS = {"my-group": "m104"}

# Команды бота: ключи групп не должны с ними совпадать.
RESERVED_COMMANDS = {"start", "stop", "courses", "deadlines", "search", "settings",
                     "stats", "broadcast", "calendar", "id", "remind", "reminders", "works"}
BTN_COURSES = "📚 Мои курсы"
BTN_DEADLINES = "⏰ Дедлайны"

# Напоминания о дедлайнах: за сколько секунд до срока. Каждый подписчик выбирает
# свои окна в «⚙️ Настройках» (хранятся в Worker); по умолчанию — сутки и 3 часа.
REMINDER_WINDOWS = [3 * 86400, 86400, 3 * 3600, 3600]
DEFAULT_REMINDERS = [86400, 3 * 3600]

# Файлы в чат: Telegram принимает от бота документы до 50 МБ.
MAX_FILE_BYTES = 49 * 1024 * 1024
MAX_FILES_PER_COURSE = 10  # за один запуск, чтобы не завалить чат

# Сводка: у кого она включена, сообщения о новых файлах копятся и приходят одним
# сообщением при первой проверке после DIGEST_HOUR по Москве (файлы — ссылками).
DIGEST_HOUR = 20

# кнопка под уведомлениями о материалах: Worker заводит напоминание на завтра 10:00
REMIND_TOMORROW = {"inline_keyboard": [[{"text": "🔔 Напомнить завтра", "callback_data": "rt"}]]}

# «Что изменилось в файле»: для каждого файла храним хэши страниц/слайдов/абзацев.
# Для файлов, которые лежали в Moodle до этой функции, отпечатки набираются
# постепенно — не больше BACKFILL_* за запуск, чтобы не нагружать Moodle.
BACKFILL_FILES = 8
BACKFILL_BYTES = 60 * 1024 * 1024
BACKFILL_SECONDS = 90
DEADLINES_LIST_DAYS = 14  # сколько дней вперёд показывать в /deadlines

MSK = timezone(timedelta(hours=3))  # время МГУ, без перехода на летнее
WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("moodle_bot")


class MoodleError(Exception):
    pass


class TelegramError(Exception):
    def __init__(self, status, description):
        super().__init__(f"{status}: {description}")
        self.status = status
        self.description = description or ""


# ---------------------------- Конфиг групп ----------------------------

def load_groups():
    """groups.json -> {ключ группы: {"title", "token_env", "courses": [int]}}."""
    with open(GROUPS_FILE, encoding="utf-8") as f:
        raw = json.load(f)["groups"]

    groups = {}
    for key, g in raw.items():
        if not re.fullmatch(r"[a-z0-9_]{1,32}", key) or key in RESERVED_COMMANDS:
            raise ValueError(f"Ключ группы {key!r} должен быть латиницей a-z, 0-9, _ "
                             "(он же команда в меню бота)")
        if not g.get("token_env"):
            raise ValueError(f"У группы {key!r} не указан token_env")
        groups[key] = {
            "title": g.get("title") or key,
            "token_env": g["token_env"],
            # пустой список = все курсы, на которые записан владелец токена
            "courses": [int(c) for c in g.get("courses", [])],
        }
    if not groups:
        raise ValueError("В groups.json нет ни одной группы")
    return groups


# ---------------------------- Moodle ----------------------------------

def moodle(token, function, **params):
    """Один запрос к официальному API Moodle."""
    data = {
        "wstoken": token,
        "wsfunction": function,
        "moodlewsrestformat": "json",
    }
    data.update(params)
    # токен отправляем в теле запроса, а не в ссылке
    r = requests.post(f"{MOODLE_URL}/webservice/rest/server.php", data=data, timeout=30)
    r.raise_for_status()
    result = r.json()
    if isinstance(result, dict) and "exception" in result:
        raise MoodleError(f"{result.get('errorcode')}: {result.get('message')}")
    return result


def get_snapshot(token, course_id):
    """Текущее содержимое курса: ({id материала: {название, ссылка, файлы}},
    {id материала: {файл: {url, size}}, "_info": {...}}) — второе нужно, чтобы скачать
    файл, а "_info" (все модули с типом и разделом, включая подписи) — для поиска
    контрольных, экзаменов и т. п."""
    sections = moodle(token, "core_course_get_contents", courseid=course_id)
    snapshot, meta = {}, {}
    info = meta["_info"] = {"modules": [], "sections": []}
    for section in sections:
        info["sections"].append({"num": section.get("section", 0), "name": section.get("name") or ""})
        for m in section.get("modules", []):
            text = m.get("name", "")
            if m.get("modname") == "label":  # у подписи текст — в description (HTML)
                text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.get("description") or text))).strip()
                text = re.sub(r"\s+([,.;:!?)])", r"\1", text)
            info["modules"].append({"id": str(m["id"]), "mod": m.get("modname", ""), "text": text[:300],
                                    "url": m.get("url", ""), "section": section.get("section", 0)})
            if m.get("modname") == "label":  # в уведомлениях о материалах подписи не нужны
                continue
            files = {}
            for f in m.get("contents", []) or []:
                if f.get("type") == "file":
                    key = f.get("filepath", "/") + f.get("filename", "")
                    files[key] = f.get("timemodified", 0)
                    meta.setdefault(str(m["id"]), {})[key] = {
                        "url": f.get("fileurl", ""), "size": f.get("filesize", 0)}
            snapshot[str(m["id"])] = {
                "name": m.get("name", "Без названия"),
                "url": m.get("url", ""),
                "files": files,
            }
    return snapshot, meta


def find_changes(old, new):
    """Сравнивает старое и новое состояние курса, возвращает список строк."""
    changes = []
    for mid, m in new.items():
        link = html.escape(m["url"], quote=True)
        title = html.escape(m["name"])
        name_html = f'<a href="{link}">{title}</a>' if m["url"] else title

        if mid not in old:
            line = f"🆕 Новый материал: {name_html}"
            if m["files"]:
                names = ", ".join(html.escape(k.lstrip("/")) for k in m["files"])
                line += f"\n    файлы: {names}"
            changes.append(line)
            continue

        old_files = old[mid]["files"]
        for key, modified in m["files"].items():
            shown = html.escape(key.lstrip("/"))
            if key not in old_files:
                changes.append(f"📎 Новый файл «{shown}» в материале {name_html}")
            elif modified != old_files[key]:
                changes.append(f"✏️ Обновлён файл «{shown}» в материале {name_html}")
    return changes


def changed_files(old, new):
    """[(id материала, файл)] — новые и обновлённые файлы (их пришлём документами)."""
    result = []
    for mid, m in new.items():
        old_files = old.get(mid, {}).get("files", {})
        for key, modified in m["files"].items():
            if old_files.get(key) != modified:
                result.append((mid, key))
    return result


# ---------------------------- Что изменилось в файле -------------------

def short_hash(text):
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:10]


def _xml_texts(xml_bytes, unit_tag, text_tag):
    """Тексты блоков (абзацев/слайда) из XML офисного файла, без лишних зависимостей."""
    root = ElementTree.fromstring(xml_bytes)
    blocks = []
    for el in root.iter():
        if el.tag.endswith("}" + unit_tag):
            blocks.append("".join(t.text or "" for t in el.iter() if t.tag.endswith("}" + text_tag)))
    return blocks


def fingerprint(name, content):
    """Отпечаток файла: {"k": вид, "h": [хэши частей], "s": размер} и тексты частей
    (тексты не храним — только для цитаты в сообщении)."""
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    texts = None
    try:
        if ext == "pdf":
            from pypdf import PdfReader
            texts = []
            for page in PdfReader(io.BytesIO(content)).pages:
                t = (page.extract_text() or "").strip()
                if not t:  # скан: сравниваем содержимое страницы как есть
                    data = page.get_contents()
                    t = "raw:" + hashlib.sha256(data.get_data() if data else b"").hexdigest()
                texts.append(t)
        elif ext == "pptx":
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                slides = sorted((n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                                key=lambda n: int(re.findall(r"\d+", n)[0]))
                texts = [" ".join(_xml_texts(z.read(n), "p", "t")).strip() for n in slides]
        elif ext == "docx":
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                texts = [t.strip() for t in _xml_texts(z.read("word/document.xml"), "p", "t") if t.strip()]
    except Exception as e:  # битый/зашифрованный файл — сравним целиком
        log.info("Не удалось разобрать %s: %s", name, e)
        texts = None
    if texts is None:
        return {"k": "bin", "h": [short_hash(hashlib.sha256(content).hexdigest())], "s": len(content)}, None
    kind = {"pdf": "pdf", "pptx": "pptx", "docx": "docx"}[ext]
    return {"k": kind, "h": [short_hash(t) for t in texts], "s": len(content)}, texts


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return one
    return few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many


def ranges(nums):
    out, start, prev = [], None, None
    for n in nums:
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append(f"{start}–{prev}" if prev > start else str(start))
            start = prev = n
    if start is not None:
        out.append(f"{start}–{prev}" if prev > start else str(start))
    return ", ".join(out)


def fmt_size(n):
    return f"{n / 1024 / 1024:.1f} МБ" if n >= 1024 * 1024 else f"{max(1, n // 1024)} КБ"


def describe_diff(old, new, texts):
    """Человеческое описание разницы двух отпечатков (или None, если сказать нечего)."""
    if old.get("h") == new["h"]:
        return "содержимое не изменилось — файл просто перезалили"
    if new["k"] == "bin" or old.get("k") != new["k"]:
        if not old.get("s"):
            return None
        if fmt_size(old["s"]) == fmt_size(new["s"]):
            return "содержимое изменилось, размер прежний"
        return f"размер {fmt_size(old['s'])} → {fmt_size(new['s'])}"

    changed, added, removed = [], [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old["h"], new["h"], autojunk=False).get_opcodes():
        if tag == "replace":
            # общая часть — изменённые; лишнее в новом — добавленные, в старом — удалённые
            common = min(i2 - i1, j2 - j1)
            changed += range(j1 + 1, j1 + common + 1)
            added += range(j1 + common + 1, j2 + 1)
            removed += range(i1 + common + 1, i2 + 1)
        elif tag == "insert":
            added += range(j1 + 1, j2 + 1)
        elif tag == "delete":
            removed += range(i1 + 1, i2 + 1)

    parts = []
    # глагол в роде и числе: (один м.р., одна ж.р., несколько)
    verbs = {"ch": ("изменён", "изменена", "изменены"), "add": ("добавлен", "добавлена", "добавлены"),
             "rm": ("удалён", "удалена", "удалены")}
    for nums, v in ((changed, "ch"), (added, "add"), (removed, "rm")):
        if not nums:
            continue
        n = len(nums)
        if new["k"] == "docx":  # номера абзацев ничего не скажут — только количество
            verb = verbs[v][0] if n % 10 == 1 and n % 100 != 11 else verbs[v][2]
            parts.append(f"{verb} {n} {plural(n, 'абзац', 'абзаца', 'абзацев')}")
        elif new["k"] == "pdf":
            parts.append(f"{verbs[v][1] if n == 1 else verbs[v][2]} {'страница' if n == 1 else 'страницы'} {ranges(nums)}")
        else:
            parts.append(f"{verbs[v][0] if n == 1 else verbs[v][2]} {'слайд' if n == 1 else 'слайды'} {ranges(nums)}")
    if not parts:
        return None
    result = ", ".join(parts)
    # цитата первого изменённого/добавленного места
    first = (changed or added or [None])[0]
    if texts and first and first <= len(texts) and not texts[first - 1].startswith("raw:"):
        quote = re.sub(r"\s+", " ", texts[first - 1]).strip()
        if quote:
            result += f"\n      «{html.escape(quote[:120])}{'…' if len(quote) > 120 else ''}»"
    return result


class FileFetcher:
    """Скачивает файлы курса из Moodle не больше одного раза за запуск."""

    def __init__(self, token, meta):
        self.token, self.meta, self.cache = token, meta, {}

    def info(self, mid, key):
        return self.meta.get(mid, {}).get(key)

    def get(self, mid, key):
        if (mid, key) in self.cache:
            return self.cache[(mid, key)]
        info, content = self.info(mid, key), None
        if info and info["url"] and info["size"] <= MAX_FILE_BYTES:
            try:
                r = requests.get(info["url"], params={"token": self.token}, timeout=120)
                r.raise_for_status()
                if "application/json" in r.headers.get("content-type", ""):
                    log.warning("Moodle не отдал файл %s: %s", key, r.text[:200])
                elif len(r.content) <= MAX_FILE_BYTES:
                    content = r.content
            except requests.RequestException as e:
                log.warning("Не удалось скачать %s: %s", key, e)
        self.cache[(mid, key)] = content
        return content


# ---------------------------- Telegram --------------------------------

def tg(method, files=None, **params):
    """Вызов Bot API. При 429 ждёт и повторяет, остальные ошибки -> TelegramError.
    files — для загрузки документа (multipart), тогда params уходят полями формы."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}"
    for _ in range(3):
        if files:
            r = requests.post(url, data=params, files=files, timeout=120)
        else:
            r = requests.post(url, json=params, timeout=30)
        try:
            data = r.json()
        except ValueError:
            r.raise_for_status()
            raise TelegramError(r.status_code, "не JSON-ответ")
        if data.get("ok"):
            return data["result"]
        if r.status_code == 429:
            wait = data.get("parameters", {}).get("retry_after", 5)
            log.warning("Telegram просит подождать %s с", wait)
            time.sleep(wait + 1)
            continue
        raise TelegramError(r.status_code, data.get("description"))
    raise TelegramError(429, "слишком много запросов")


def split_message(text, limit=4000):
    parts = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        if cut == -1:
            cut = limit
        parts.append(text[:cut])
        text = text[cut:].lstrip("\n")
    parts.append(text)
    return parts


def send_message(chat_id, text, html_mode=True, **extra):
    if html_mode:
        extra["parse_mode"] = "HTML"
    for part in split_message(text):
        tg("sendMessage", chat_id=chat_id, text=part, disable_web_page_preview=True, **extra)
        time.sleep(0.05)  # лимит Telegram ~30 сообщений в секунду


def mask(chat_id):
    """chat_id в логах: репозиторий публичный, а логи Actions видны всем."""
    c = str(chat_id)
    return "…" + c[-3:] if len(c) > 3 else c


def chat_is_gone(err):
    """Пользователь заблокировал бота / чат удалён — подписку можно снять."""
    d = err.description.lower()
    return err.status == 403 or "chat not found" in d or "user is deactivated" in d


# ----------------------------- Состояние ------------------------------

def empty_state():
    return {
        "version": 2,
        "telegram_offset": 0,
        "subscribers": {},   # chat_id (строкой) -> ключ группы
        "snapshots": {},     # ключ группы -> {id курса: снимок}
        "group_errors": {},  # ключ группы -> последняя ошибка (чтобы не спамить админа)
        "course_names": {},  # ключ группы -> {id курса: название}
        "deadlines": {},     # ключ группы -> [{id, course, name, due, url, kind}]
        "reminders_sent": {},  # ключ группы -> {id:срок:окно: срок}
        "muted": {},         # chat_id -> [id курсов, по которым не присылать ничего]
        "prefs": {},         # chat_id -> {"r": окна напоминаний (с), "f": файлы, "s": сводка}
        "done": {},          # chat_id -> [id дедлайнов, отмеченных «✅ Сдал»]
        "digest": {},        # chat_id -> [накопленные для сводки сообщения]
        "digest_day": "",    # дата (МСК), за которую сводка уже разослана
        "custom": {},        # chat_id -> [{id, due, text}] — свои напоминания из Worker
        "fired": {},         # id своего напоминания -> срок (уже отправлено)
        "fingerprints": {},  # группа -> курс -> "id материала|файл" -> {k, h, s, t}
        "assessments": {},   # группа -> [{c, k, n, u, d, h, s}] — контрольные, экзамены, зачёты...
    }


def read_raw_state():
    """Состояние хранится в Cloudflare KV (через Worker), чтобы репозиторий мог быть
    публичным: в нём chat_id подписчиков. Если в Worker его ещё нет — берём локальный
    state.json (переезд со старой схемы). Если Worker недоступен — падаем: с пустым
    состоянием бот разослал бы повторные напоминания."""
    if relay_enabled():
        r = requests.get(RELAY_URL + "/api/state", timeout=60,
                         headers={"Authorization": f"Bearer {BOT_SYNC_SECRET}"})
        r.raise_for_status()
        raw = r.json()
        if raw is not None:
            log.info("Состояние загружено из Worker (%d КБ)", len(r.content) // 1024)
            return raw
        log.info("В Worker состояния ещё нет — беру локальный state.json")
    if not os.path.exists(STATE_FILE):
        return None
    with open(STATE_FILE, encoding="utf-8") as f:
        return json.load(f)


def state_hash(state):
    return hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


LOADED_STATE_HASH = None  # хэш состояния сразу после загрузки — чтобы не писать то же самое


def flush_state(state):
    """Сохраняет состояние в Worker, только если оно изменилось за запуск (лимит KV —
    1000 записей в сутки). Возвращает размер в байтах или 0, если писать не пришлось."""
    if state_hash(state) == LOADED_STATE_HASH:
        log.info("Состояние не изменилось — в Worker не пишу")
        return 0
    body = json.dumps(state, ensure_ascii=False).encode()
    r = requests.put(RELAY_URL + "/api/state", data=body, timeout=60,
                     headers={"Authorization": f"Bearer {BOT_SYNC_SECRET}",
                              "content-type": "application/json"})
    r.raise_for_status()
    log.info("Состояние сохранено в Worker (%d КБ)", len(body) // 1024)
    return len(body)


def load_state(groups):
    raw = read_raw_state()
    if raw is None:
        return empty_state()
    if raw.get("version") == 2:
        state = empty_state()
        state.update(raw)
        for old, new in RENAMED_GROUPS.items():
            for section in ("snapshots", "group_errors"):
                if old in state[section] and new not in state[section]:
                    state[section][new] = state[section].pop(old)
            for chat_id, key in state["subscribers"].items():
                if key == old:
                    state["subscribers"][chat_id] = new
        return state

    # Старый формат: {id курса: снимок}
    log.info("Перевожу state.json в новый формат")
    state = empty_state()
    for key, g in groups.items():
        if g["token_env"] == LEGACY_TOKEN_ENV:
            state["snapshots"][key] = {
                cid: snap for cid, snap in raw.items()
                if not g["courses"] or int(cid) in g["courses"]
            }
    return state


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_FILE)


# ----------------------- Команды и кнопки ------------------------------
#
# Без Worker бот просыпается раз в CHECK_EVERY_MIN минут, поэтому выбор группы сделан так, чтобы
# нажатие срабатывало сразу на стороне Telegram, без ответа бота:
#   - меню команд (/m104, /e207, ...) видно ещё до /start — его ставит setMyCommands;
#   - обычная (reply) клавиатура с названиями групп: нажатие сразу отправляет
#     сообщение, а группа привязывается при следующем запуске.

def relay_enabled():
    return bool(RELAY_URL and BOT_SYNC_SECRET)


def setup_bot_profile(groups, state):
    """Меню команд и описание бота. Отправляем в Telegram, только если что-то изменилось."""
    commands = [{"command": "start", "description": "Выбрать группу"}]
    commands += [{"command": key, "description": f"Группа {g['title']}"} for key, g in groups.items()]
    commands += [
        {"command": "courses", "description": "Мои курсы и отключение ненужных"},
        {"command": "deadlines", "description": "Ближайшие дедлайны"},
        {"command": "works", "description": "Контрольные, экзамены, зачёты по курсам"},
        {"command": "search", "description": "Поиск по материалам курсов"},
        {"command": "settings", "description": "Напоминания, файлы, сводка"},
        {"command": "calendar", "description": "Дедлайны в календаре телефона"},
        {"command": "remind", "description": "Своё напоминание: /remind завтра 10:00 текст"},
        {"command": "reminders", "description": "Мои напоминания"},
        {"command": "stop", "description": "Отписаться от уведомлений"},
    ]
    description = (
        "Присылаю новые и обновлённые файлы из курсов Moodle вашей группы, напоминаю "
        "о дедлайнах, ищу материалы по курсам и добавляю сроки в календарь.\n\n"
        "Нажмите «Начать» и выберите группу на клавиатуре или в меню. "
    )
    if relay_enabled():
        description += f"Бот отвечает сразу, а Moodle проверяет каждые {CHECK_EVERY_MIN} минут."
    else:
        description += (f"Бот читает сообщения раз в {CHECK_EVERY_MIN} минут, поэтому "
                        "подтверждение придёт не сразу — выбор при этом уже сохранён.")
    short = "Новые файлы, дедлайны и поиск по Moodle вашей группы. Выберите группу в меню."

    signature = json.dumps([commands, description, short], ensure_ascii=False, sort_keys=True)
    if state.get("bot_profile") == signature:
        return
    try:
        tg("setMyCommands", commands=commands)
        tg("setMyDescription", description=description)
        tg("setMyShortDescription", short_description=short)
    except (TelegramError, requests.RequestException) as e:
        log.warning("Не удалось обновить меню/описание бота: %s", e)
        return
    state["bot_profile"] = signature
    log.info("Меню команд и описание бота обновлены")


def groups_keyboard(groups, current=None):
    buttons = [{"text": ("✅ " if key == current else "") + g["title"]}
               for key, g in groups.items()]
    rows = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
    rows.append([{"text": BTN_COURSES}, {"text": BTN_DEADLINES}])
    return {"keyboard": rows, "resize_keyboard": True, "is_persistent": True,
            "input_field_placeholder": "Выберите группу"}


def find_group(text, groups):
    """Ключ группы по тексту кнопки («✅ М104»), команде (/m104) или названию, набранному вручную."""
    t = text.replace("✅", "").strip().lower()
    if t.startswith("/"):
        t = t[1:].split("@")[0]
        return t if t in groups else None
    for key, g in groups.items():
        if t == g["title"].strip().lower():
            return key
    return None


def subscribe(chat_id, key, groups, state):
    if state["subscribers"].get(chat_id) != key:
        state["muted"].pop(chat_id, None)  # у другой группы другие курсы
    state["subscribers"][chat_id] = key
    log.info("Чат %s выбрал группу %s", mask(chat_id), key)
    send_message(
        chat_id,
        f"✅ Группа <b>{html.escape(groups[key]['title'])}</b> выбрана.\n"
        "Буду присылать новые и обновлённые файлы из её курсов и напоминать "
        f"о дедлайнах (проверка каждые {CHECK_EVERY_MIN} минут).\n\n"
        f"{BTN_COURSES} — список курсов, ненужные можно отключить.\n"
        "Сменить группу — кнопкой внизу, /stop — отписаться.",
        reply_markup=groups_keyboard(groups, key),
    )


def fmt_time(ts):
    d = datetime.fromtimestamp(ts, MSK)
    return f"{WEEKDAYS[d.weekday()]} {d:%d.%m %H:%M}"


def fmt_left(seconds):
    if seconds >= 2 * 86400:
        return f"{int(seconds // 86400)} дн."
    if seconds >= 3600:
        return f"{int(seconds // 3600)} ч"
    return f"{max(1, int(seconds // 60))} мин"


def user_reminders(state, chat_id):
    p = state["prefs"].get(chat_id, {})
    return p["r"] if p.get("r") is not None else DEFAULT_REMINDERS


def user_wants_files(state, chat_id):
    return state["prefs"].get(chat_id, {}).get("f", True)


def user_wants_digest(state, chat_id):
    return bool(state["prefs"].get(chat_id, {}).get("s"))


def is_done(state, chat_id, deadline_id):
    return deadline_id in state["done"].get(chat_id, [])


def is_muted(state, chat_id, course_id):
    return str(course_id) in state["muted"].get(chat_id, [])


def deadline_line(d, state, key, now):
    course = state["course_names"].get(key, {}).get(d["course"], f"Курс {d['course']}")
    name = html.escape(d["name"])
    link = f'<a href="{html.escape(d["url"], quote=True)}">{name}</a>' if d.get("url") else name
    return (f"• {d.get('kind', 'Задание')} {link}\n"
            f"   {html.escape(course)}\n"
            f"   до <b>{fmt_time(d['due'])}</b> (осталось {fmt_left(d['due'] - now)})")


def courses_text(chat_id, key, groups, state):
    names = state["course_names"].get(key)
    title = html.escape(groups[key]["title"])
    if not names:
        return (f"Курсы группы <b>{title}</b> появятся после ближайшей проверки Moodle "
                f"(до {CHECK_EVERY_MIN} минут). Тогда нажмите «Мои курсы» ещё раз.")
    lines = [f"📚 Курсы группы <b>{title}</b>:\n"]
    for cid, name in sorted(names.items(), key=lambda x: x[1]):
        if is_muted(state, chat_id, cid):
            lines.append(f"🔕 {html.escape(name)}\n      включить: /on_{cid}")
        else:
            lines.append(f"🔔 {html.escape(name)}\n      отключить: /off_{cid}")
    lines.append("\nНажмите команду под курсом, чтобы отключить или включить по нему "
                 "уведомления о файлах и дедлайнах. Изменение применится при следующей "
                 f"проверке (до {CHECK_EVERY_MIN} минут).")
    return "\n".join(lines)


def deadlines_text(chat_id, key, groups, state):
    now = time.time()
    horizon = now + DEADLINES_LIST_DAYS * 86400
    items = sorted(
        (d for d in state["deadlines"].get(key, [])
         if now < d["due"] <= horizon and not is_muted(state, chat_id, d["course"])),
        key=lambda d: d["due"],
    )
    if not items:
        return f"⏰ Дедлайнов на ближайшие {DEADLINES_LIST_DAYS} дней нет."
    return (f"⏰ Дедлайны на ближайшие {DEADLINES_LIST_DAYS} дней:\n\n"
            + "\n\n".join(deadline_line(d, state, key, now) for d in items))


def toggle_course(chat_id, key, course_id, mute, groups, state):
    if course_id not in state["course_names"].get(key, {}):
        send_message(chat_id, "Такого курса нет в вашей группе. Список: /courses")
        return
    muted = set(state["muted"].get(chat_id, []))
    (muted.add if mute else muted.discard)(course_id)
    if muted:
        state["muted"][chat_id] = sorted(muted)
    else:
        state["muted"].pop(chat_id, None)
    send_message(chat_id, courses_text(chat_id, key, groups, state))


def handle_message(msg, groups, state):
    chat_id = str(msg["chat"]["id"])
    text = (msg.get("text") or "").strip()
    command = text.split()[0].split("@")[0].lower() if text.startswith("/") else ""
    current = state["subscribers"].get(chat_id)

    if command == "/start":
        intro = "Выберите свою группу на клавиатуре внизу — буду присылать новые файлы из её курсов Moodle."
        if current in groups:
            intro = (f"Сейчас вы подписаны на группу <b>{html.escape(groups[current]['title'])}</b>.\n"
                     "Чтобы сменить группу, нажмите другую кнопку внизу. /stop — отписаться.")
        send_message(chat_id, intro, reply_markup=groups_keyboard(groups, current))
    elif command in ("/courses", "/deadlines") or text in (BTN_COURSES, BTN_DEADLINES):
        if current not in groups:
            send_message(chat_id, "Сначала выберите группу на клавиатуре внизу или в меню.",
                         reply_markup=groups_keyboard(groups))
        elif command == "/courses" or text == BTN_COURSES:
            send_message(chat_id, courses_text(chat_id, current, groups, state))
        else:
            send_message(chat_id, deadlines_text(chat_id, current, groups, state))
    elif (m := re.fullmatch(r"/(on|off)_(\d+)", command)):
        if current not in groups:
            send_message(chat_id, "Сначала выберите группу: /start")
        else:
            toggle_course(chat_id, current, m.group(2), m.group(1) == "off", groups, state)
    elif command == "/stop":
        state["muted"].pop(chat_id, None)
        if state["subscribers"].pop(chat_id, None):
            send_message(chat_id, "Вы отписаны от уведомлений. /start — подписаться снова.",
                         reply_markup={"remove_keyboard": True})
        else:
            send_message(chat_id, "Вы и так не подписаны. /start — выбрать группу.")
    elif (key := find_group(text, groups)):
        subscribe(chat_id, key, groups, state)
    elif msg["chat"].get("type") == "private":
        send_message(chat_id, "Не понял. Выберите группу на клавиатуре внизу или нажмите /start.",
                     reply_markup=groups_keyboard(groups, current))


def handle_callback(cq, groups, state):
    """Inline-кнопки из старых сообщений бота: тоже понимаем, но дальше — обычная клавиатура."""
    data = cq.get("data") or ""
    msg = cq.get("message")
    key = data[len(CALLBACK_PREFIX):] if data.startswith(CALLBACK_PREFIX) else None
    key = RENAMED_GROUPS.get(key, key)

    try:
        # кнопка могла быть нажата несколько минут назад: Telegram ответит «query is too old»
        tg("answerCallbackQuery", callback_query_id=cq["id"],
           text="Готово" if key in groups else "Выберите группу заново: /start")
    except TelegramError as e:
        log.info("answerCallbackQuery: %s", e)

    if msg and key in groups:
        subscribe(str(msg["chat"]["id"]), key, groups, state)


def process_updates(groups, state):
    """Забирает все накопившиеся апдейты. offset сохраняется в state."""
    handled = 0
    while True:
        updates = tg("getUpdates", offset=state["telegram_offset"], timeout=0, limit=100,
                     allowed_updates=["message", "callback_query"])
        if not updates:
            break
        for upd in updates:
            state["telegram_offset"] = upd["update_id"] + 1
            try:
                if "message" in upd:
                    handle_message(upd["message"], groups, state)
                elif "callback_query" in upd:
                    handle_callback(upd["callback_query"], groups, state)
            except (TelegramError, requests.RequestException) as e:
                log.warning("Не удалось обработать апдейт %s: %s", upd["update_id"], e)
            handled += 1
        save_state(state)
    log.info("Обработано апдейтов Telegram: %d", handled)


# ------------------------------ Ретранслятор (Cloudflare Worker) ------

def relay(method, path, body=None):
    r = requests.request(method, RELAY_URL + path, json=body, timeout=30,
                         headers={"Authorization": f"Bearer {BOT_SYNC_SECRET}"})
    r.raise_for_status()
    return r.json()


def sync_telegram(groups, state):
    """Получение команд: getUpdates (без Worker) или подписчики из Worker (с ним)."""
    webhook = tg("getWebhookInfo").get("url", "")

    if not relay_enabled():
        if webhook:
            log.info("Worker не настроен, отключаю webhook и читаю сообщения сам")
            tg("deleteWebhook")
        process_updates(groups, state)
        return

    want = RELAY_URL + "/telegram"
    if webhook != want:
        # Worker должен отвечать и знать группы ещё до того, как к нему пойдут сообщения
        relay("GET", "/api/subscribers")
        state.pop("relay_catalog", None)
        push_to_relay(groups, state)
        if not webhook:
            process_updates(groups, state)  # дочитываем то, что пришло до webhook

    # Подписки, собранные до Worker, переносим один раз (только отсутствующие там).
    # Пока перенос не удался, список из Worker не берём — иначе потеряем подписчиков.
    if not state.get("relay_migrated"):
        if state["subscribers"]:
            res = relay("POST", "/api/subscribers", {"add": {
                chat: {"g": g, "m": state["muted"].get(chat, [])}
                for chat, g in state["subscribers"].items()
            }})
            log.info("Перенесено подписок в Worker: %s", res.get("added"))
        state["relay_migrated"] = True
        save_state(state)

    if webhook != want:
        # в secret_token Telegram пускает только A-Z a-z 0-9 _ -, поэтому шлём SHA-256
        # от BOT_SYNC_SECRET; Worker проверяет заголовок тем же способом
        token = hashlib.sha256(BOT_SYNC_SECRET.encode()).hexdigest()
        tg("setWebhook", url=want, secret_token=token,
           allowed_updates=["message", "callback_query"])
        log.info("Webhook установлен: сообщения теперь принимает Worker")

    # список перечитываем, только если в Worker что-то поменялось (KV: 1000 list в сутки)
    resp = relay("GET", "/api/subscribers?since=" + requests.utils.quote(state.get("subs_version", "")))
    if resp.get("unchanged"):
        log.info("Подписчики не менялись (%d)", len(state["subscribers"]))
    elif "subs" not in resp:  # Worker старой версии (ещё не развернулся) — прежний формат
        apply_subscribers(state, resp)
    else:
        apply_subscribers(state, resp["subs"])
        state["subs_version"] = resp["version"]
        log.info("Подписчиков из Worker: %d", len(state["subscribers"]))

    send_custom_reminders(state)

    # рассылки /broadcast, которые Worker не успел отправить сам (много получателей)
    for b in relay("POST", "/api/broadcasts/take"):
        chats = [c for c, g in state["subscribers"].items()
                 if not b.get("group") or g == b["group"]]
        for chat_id in chats:
            try:
                send_message(chat_id, b["text"], html_mode=False)
            except (TelegramError, requests.RequestException) as e:
                log.warning("Рассылка в %s не ушла: %s", mask(chat_id), e)
        log.info("Рассылка отправлена: %d получателей", len(chats))


def apply_subscribers(state, subs):
    state["subscribers"] = {chat: s["group"] for chat, s in subs.items() if s.get("group")}
    state["muted"] = {chat: s["muted"] for chat, s in subs.items() if s.get("muted")}
    state["prefs"] = {}
    for chat, s in subs.items():
        p = {}
        if s.get("reminders") is not None:
            p["r"] = [int(w) for w in s["reminders"]]
        if s.get("files") is not None:
            p["f"] = bool(s["files"])
        if s.get("digest"):
            p["s"] = True
        if p:
            state["prefs"][chat] = p
    state["done"] = {chat: s["done"] for chat, s in subs.items() if s.get("done")}
    state["custom"] = {chat: s["custom"] for chat, s in subs.items() if s.get("custom")}


def send_custom_reminders(state):
    """Свои напоминания (/remind): Worker их хранит, а присылает бот при проверке —
    с точностью до интервала cron-job. Отправленные запоминаем в state["fired"]."""
    now = time.time()
    fired = state.setdefault("fired", {})
    for rid in [r for r, due in fired.items() if due < now - 3 * 86400]:
        del fired[rid]
    for chat_id, items in state.get("custom", {}).items():
        if chat_id not in state["subscribers"]:
            continue
        for r in items:
            if r["due"] > now or r["id"] in fired:
                continue
            fired[r["id"]] = r["due"]
            if now - r["due"] > 6 * 3600:  # бот долго не работал — старое уже не актуально
                continue
            broadcast([chat_id], f"🔔 <b>Напоминание</b>\n\n{html.escape(r['text'])}", state)


def push_to_relay(groups, state):
    """Отдаёт Worker группы, курсы и дедлайны (только если что-то изменилось)."""
    if GONE_CHATS:
        relay("POST", "/api/subscribers", {"remove": sorted(GONE_CHATS)})
        GONE_CHATS.clear()
    catalog = {
        "groups": [{"key": k, "title": g["title"]} for k, g in groups.items()],
        "course_names": {k: state["course_names"].get(k, {}) for k in groups},
        "deadlines": {k: state["deadlines"].get(k, []) for k in groups},
        "admin": ADMIN_CHAT_ID,  # /stats и /broadcast в Worker — только этому чату
        "check_every": CHECK_EVERY_MIN,
    }
    signature = hashlib.sha256(
        json.dumps(catalog, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if state.get("relay_catalog") != signature:
        relay("PUT", "/api/catalog", catalog)
        state["relay_catalog"] = signature
        log.info("Каталог курсов и дедлайнов отправлен в Worker")

    # индекс материалов для поиска — отдельным ключом на группу, только при изменениях
    sent_index = state.setdefault("relay_index", {})
    for key in groups:
        index = [
            {"c": cid, "n": m["name"], "u": m["url"],
             "f": [f.lstrip("/") for f in m["files"]]}
            for cid, course in sorted(state["snapshots"].get(key, {}).items())
            for mid, m in sorted(course.items())
        ]
        sig = hashlib.sha256(json.dumps(index, ensure_ascii=False).encode()).hexdigest()
        if sent_index.get(key) != sig:
            relay("PUT", f"/api/index/{key}", index)
            sent_index[key] = sig
            log.info("Индекс поиска группы %s: %d материалов", key, len(index))

    # контрольные, экзамены, зачёты — для кнопки «📝 Контрольные»
    sent_works = state.setdefault("relay_works", {})
    for key in groups:
        works = state["assessments"].get(key, [])
        sig = hashlib.sha256(json.dumps(works, ensure_ascii=False).encode()).hexdigest()
        if sent_works.get(key) != sig:
            relay("PUT", f"/api/works/{key}", works)
            sent_works[key] = sig
            log.info("Контрольные группы %s: %d", key, len(works))


# ------------------------------ Moodle-проверка -----------------------

def notify_admin(text):
    if not ADMIN_CHAT_ID:
        return
    try:
        send_message(ADMIN_CHAT_ID, text)
    except (TelegramError, requests.RequestException) as e:
        log.warning("Не удалось написать админу: %s", e)


GONE_CHATS = set()  # чаты, заблокировавшие бота за этот запуск


def broadcast(chat_ids, text, state, **extra):
    """Рассылает текст. True, если хотя бы одному ушло (или некому отправлять)."""
    if not chat_ids:
        return True
    delivered = False
    for chat_id in chat_ids:
        try:
            send_message(chat_id, text, **extra)
            delivered = True
        except TelegramError as e:
            if chat_is_gone(e):
                log.info("Чат %s недоступен (%s), снимаю подписку", mask(chat_id), e)
                state["subscribers"].pop(chat_id, None)
                state["muted"].pop(chat_id, None)
                GONE_CHATS.add(chat_id)
                delivered = True
            else:
                log.warning("Не удалось отправить в %s: %s", mask(chat_id), e)
        except requests.RequestException as e:
            log.warning("Сеть при отправке в %s: %s", mask(chat_id), e)
    return delivered


def get_deadlines(token, course_ids, old, dated=None):
    """Задания и тесты со сроком сдачи в будущем. Если API не отдал какой-то вид —
    оставляем прошлый список этого вида (токен может не иметь прав на функцию).
    dated (если передан) заполняется {cmid: срок} для всех заданий и тестов."""
    now = time.time()
    params = {f"courseids[{i}]": cid for i, cid in enumerate(course_ids)}
    items, failed = [], set()
    dated = {} if dated is None else dated

    try:
        for course in moodle(token, "mod_assign_get_assignments", **params).get("courses", []):
            for a in course.get("assignments", []):
                if a.get("duedate"):
                    dated[str(a["cmid"])] = a["duedate"]
                    items.append({"id": f"assign:{a['id']}", "kind": "Задание",
                                  "course": str(course["id"]), "name": a.get("name", "Задание"),
                                  "due": a["duedate"],
                                  "url": f"{MOODLE_URL}/mod/assign/view.php?id={a['cmid']}"})
    except (MoodleError, requests.RequestException, ValueError, KeyError) as e:
        log.warning("Задания не получены: %s", e)
        failed.add("assign")

    try:
        for q in moodle(token, "mod_quiz_get_quizzes_by_courses", **params).get("quizzes", []):
            if q.get("timeopen") or q.get("timeclose"):  # для контрольных важнее, когда тест открывается
                dated[str(q["coursemodule"])] = q.get("timeopen") or q["timeclose"]
            if q.get("timeclose"):
                items.append({"id": f"quiz:{q['id']}", "kind": "Тест",
                              "course": str(q["course"]), "name": q.get("name", "Тест"),
                              "due": q["timeclose"],
                              "url": f"{MOODLE_URL}/mod/quiz/view.php?id={q['coursemodule']}"})
    except (MoodleError, requests.RequestException, ValueError, KeyError) as e:
        log.warning("Тесты не получены: %s", e)
        failed.add("quiz")

    items += [d for d in old if d["id"].split(":")[0] in failed]
    allowed = {str(c) for c in course_ids}
    return [d for d in items if d["due"] > now and d["course"] in allowed]


# ---------------------------- Контрольные, экзамены, зачёты -------------

# порядок важен: первое совпадение определяет вид (пересдача экзамена — пересдача)
ASSESSMENT_KINDS = [
    ("retake", r"пересдач"),
    ("exam", r"экзамен|\bэкз\b"),
    ("credit", r"зачет"),
    ("colloq", r"коллоквиум"),
    ("mkr", r"микро\s*-?\s*контрольн|микроконтр|\bмкр\b"),
    ("kr", r"контрольн|\bк/р\b|\bкр\s*-?\s*№?\s*\d"),
    ("sr", r"самостоятельн|\bс/р\b|\bср\s*№?\s*\d"),
    ("test", r"\bтест"),
    ("hw", r"домашн|\bдз\b|\bд/з\b"),
    ("essay", r"эссе|реферат|курсов\w* работ|проектн\w* работ|групповой проект"),
]
MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"]


def classify(text):
    t = text.lower().replace("ё", "е")
    for kind, pattern in ASSESSMENT_KINDS:
        if re.search(pattern, t):
            return kind
    return None


def date_in_text(text, now):
    """Дата из текста: «14.11», «14.11.2026», «14 ноября», с временем «в 10:30», если есть.
    Возвращает (unix-время, есть ли время) или (None, False). Год без указания — ближайший."""
    t = text.lower().replace("ё", "е")
    m = re.search(r"(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d.])", t)
    day = month = year = None
    if m and 1 <= int(m.group(2)) <= 12:
        day, month = int(m.group(1)), int(m.group(2))
        year = int(m.group(3)) if m.group(3) else None
        if year and year < 100:
            year += 2000
    else:
        months = "|".join("ма[яй]" if p == "ма" else p for p in MONTHS)  # «ма» — только май/мая
        m = re.search(r"(?<!\d)(\d{1,2})\s+(" + months + r")[а-я]*", t)
        if m:
            day, month = int(m.group(1)), next(i for i, p in enumerate(MONTHS, 1) if m.group(2).startswith(p))
    if not day or not 1 <= day <= 31:
        return None, False
    tm = re.search(r"(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)", t)
    hh, mm = (int(tm.group(1)), int(tm.group(2))) if tm else (0, 0)
    today = datetime.fromtimestamp(now, MSK)
    # год не указан — ближайший будущий (или недавно прошедший: «результаты контрольной 14.10»)
    for y in ([year] if year else [today.year, today.year + 1, today.year - 1]):
        try:
            when = datetime(y, month, day, hh, mm, tzinfo=MSK).timestamp()
        except ValueError:
            return None, False
        if year or -60 * 86400 < when - now < 320 * 86400:
            return int(when), bool(tm)
    return None, False


def find_assessments(cid, info, dated, now):
    """Работы курса: модули и разделы, по названию похожие на контрольные, экзамены,
    зачёты и т. п., плюс все задания и тесты. Дата — из Moodle (срок задания/открытие
    теста), иначе из текста. [{c, k, n, u, d, h, s}]"""
    items, seen = [], set()
    sections = {s["num"]: s["name"] for s in info.get("sections", [])}

    def add(kind, name, url, source, mid=None):
        name = re.sub(r"\s+", " ", name).strip()[:150]
        key = (kind, name.lower())
        if not name or key in seen:
            return
        seen.add(key)
        due, has_time = (dated[mid], True) if mid in dated else date_in_text(name, now)
        items.append({"c": cid, "k": kind, "n": name, "u": url, "d": due, "h": has_time, "s": source})

    for num, name in sections.items():
        kind = classify(name)
        if kind and num:
            add(kind, name, f"{MOODLE_URL}/course/view.php?id={cid}#section-{num}", "раздел")
    for m in info.get("modules", []):
        if m["mod"] == "forum":
            continue
        kind = classify(m["text"])
        if not kind and m["mod"] == "quiz":
            kind = "test"
        elif not kind and m["mod"] == "assign":
            kind = "hw"
        if kind:
            source = {"label": "объявление", "quiz": "тест", "assign": "задание"}.get(m["mod"], "материал")
            add(kind, m["text"], m["url"] or f"{MOODLE_URL}/course/view.php?id={cid}#section-{m['section']}",
                source, m["id"])
    items.sort(key=lambda x: (x["d"] is None, x["d"] or 0))
    return items


def send_reminders(key, state):
    """Напоминания о дедлайнах. Для каждого окна (3 дня, сутки, 3 ч, 1 ч) дедлайн
    «срабатывает» один раз; подписчик получает его, если выбрал хотя бы одно из
    сработавших окон. Если срок поставили за 2 часа, сработают сразу 3 дня, сутки
    и 3 часа — придёт одно сообщение."""
    now = time.time()
    sent = state["reminders_sent"].setdefault(key, {})
    for k in [k for k, due in sent.items() if due <= now]:
        del sent[k]

    triggered = []  # (дедлайн, множество сработавших окон)
    for d in state["deadlines"].get(key, []):
        left = d["due"] - now
        if left <= 0:
            continue
        fresh = {w for w in REMINDER_WINDOWS
                 if left <= w and f"{d['id']}:{d['due']}:{w}" not in sent}
        if not fresh:
            continue
        for w in fresh:
            sent[f"{d['id']}:{d['due']}:{w}"] = d["due"]
        triggered.append((d, fresh))

    if not triggered:
        return
    triggered.sort(key=lambda x: x[0]["due"])
    for chat_id, g in list(state["subscribers"].items()):
        if g != key:
            continue
        windows = set(user_reminders(state, chat_id))
        mine = [d for d, fresh in triggered
                if fresh & windows and not is_muted(state, chat_id, d["course"])
                and not is_done(state, chat_id, d["id"])]
        if not mine:
            continue
        text = "⏰ <b>Скоро дедлайн</b>\n\n" + "\n\n".join(
            deadline_line(d, state, key, now) for d in mine)
        # «✅ Сдал» обрабатывает Worker: больше не напоминать об этом задании
        buttons = [[{"text": f"✅ Сдал: {d['name'][:40]}", "callback_data": f"d:{d['id']}"}]
                   for d in mine[:10]]
        broadcast([chat_id], text, state, reply_markup={"inline_keyboard": buttons})
    log.info("Группа %s: сработавших напоминаний о дедлайнах: %d", key, len(triggered))


def send_files(fetcher, course_name, files, chat_ids, state):
    """Присылает новые/обновлённые файлы документами. Каждый файл загружается
    в Telegram один раз, остальным уходит по file_id."""
    chat_ids = [c for c in chat_ids if user_wants_files(state, c)]
    if not chat_ids:
        return
    for mid, key in files[:MAX_FILES_PER_COURSE]:
        name = key.lstrip("/").split("/")[-1] or "file"
        info = fetcher.info(mid, key)
        if info and info["size"] > MAX_FILE_BYTES:
            log.info("Файл %s больше 50 МБ — только ссылка", name)
            continue
        content = fetcher.get(mid, key)
        if content is None:
            continue

        caption = f"📎 {html.escape(name)}\n{course_name}"[:1000]
        file_id = None
        for chat_id in chat_ids:
            try:
                if file_id:
                    tg("sendDocument", chat_id=chat_id, document=file_id,
                       caption=caption, parse_mode="HTML")
                else:
                    res = tg("sendDocument", files={"document": (name, content)},
                             chat_id=chat_id, caption=caption, parse_mode="HTML")
                    file_id = res["document"]["file_id"]
            except TelegramError as e:
                if chat_is_gone(e):
                    state["subscribers"].pop(chat_id, None)
                    state["muted"].pop(chat_id, None)
                    GONE_CHATS.add(chat_id)
                else:
                    log.warning("Не удалось отправить файл %s в %s: %s", name, mask(chat_id), e)
            except (requests.RequestException, KeyError) as e:
                log.warning("Не удалось отправить файл %s в %s: %s", name, mask(chat_id), e)
            time.sleep(0.05)


def update_prints(course_prints, snapshot, fetcher, backfill):
    """Обновляет отпечатки файлов курса: для изменённых — из уже скачанного,
    для ещё не известных — догоняющим сбором в пределах бюджета запуска."""
    alive = set()
    for mid, m in snapshot.items():
        for fkey, modified in m["files"].items():
            pid = f"{mid}|{fkey}"
            alive.add(pid)
            fp = course_prints.get(pid)
            if fp and fp.get("t") == modified:
                continue
            # изменившийся файл обновляем всегда, ещё не известный — в пределах бюджета
            if not fp and (mid, fkey) not in fetcher.cache:
                info = fetcher.info(mid, fkey) or {}
                if (backfill["files"] <= 0 or time.time() > backfill["until"]
                        or info.get("size", 0) > backfill["bytes"]):
                    continue
                backfill["files"] -= 1
                backfill["bytes"] -= info.get("size", 0)
            content = fetcher.get(mid, fkey)
            if content is None:
                continue
            new_fp, _ = fingerprint(fkey, content)
            new_fp["t"] = modified
            course_prints[pid] = new_fp
    for pid in [p for p in course_prints if p not in alive]:
        del course_prints[pid]


def check_group(key, group, state):
    token = os.getenv(group["token_env"], "").strip()
    if not token:
        raise MoodleError(f"не задан секрет {group['token_env']}")

    user_id = moodle(token, "core_webservice_get_site_info")["userid"]
    enrolled = {c["id"]: c for c in moodle(token, "core_enrol_get_users_courses", userid=user_id)}

    course_ids = group["courses"] or sorted(enrolled)
    for cid in course_ids:
        if cid not in enrolled:
            log.warning("Группа %s: владелец токена не записан на курс %s", key, cid)

    state["course_names"][key] = {
        str(cid): enrolled.get(cid, {}).get("fullname") or f"Курс {cid}" for cid in course_ids
    }

    snapshots = state["snapshots"].setdefault(key, {})
    prints = state["fingerprints"].setdefault(key, {})
    infos = {}  # id курса -> модули и разделы (для поиска контрольных)
    backfill = {"files": BACKFILL_FILES, "bytes": BACKFILL_BYTES, "until": time.time() + BACKFILL_SECONDS}
    # курсы, убранные из конфига, забываем
    for old_cid in list(snapshots):
        if int(old_cid) not in course_ids:
            del snapshots[old_cid]

    for cid in course_ids:
        scid = str(cid)
        course_name = html.escape(enrolled.get(cid, {}).get("fullname") or f"Курс {cid}")
        try:
            new, meta = get_snapshot(token, cid)
        except (MoodleError, requests.RequestException, ValueError) as e:
            log.warning("Группа %s: не удалось получить курс %s: %s", key, cid, e)
            continue

        infos[scid] = meta.pop("_info", {})
        fetcher = FileFetcher(token, meta)
        course_prints = prints.setdefault(scid, {})

        # новый курс в конфиге: просто запоминаем, без уведомлений
        if scid not in snapshots:
            snapshots[scid] = new
            update_prints(course_prints, new, fetcher, backfill)
            continue

        old_snapshot = snapshots[scid]
        changes = find_changes(old_snapshot, new)
        if changes:
            # что именно поменялось в обновлённых файлах (по сохранённым отпечаткам)
            details = []
            for mid, fkey in changed_files(old_snapshot, new):
                if fkey not in old_snapshot.get(mid, {}).get("files", {}):
                    continue  # новый файл — сравнивать не с чем
                old_fp = course_prints.get(f"{mid}|{fkey}")
                content = fetcher.get(mid, fkey) if old_fp else None
                if content is None:
                    continue
                new_fp, texts = fingerprint(fkey, content)
                diff = describe_diff(old_fp, new_fp, texts)
                if diff:
                    details.append(f"• «{html.escape(fkey.lstrip('/'))}»: {diff}")
            if details:
                changes.append("\n🔍 <b>Что изменилось:</b>\n" + "\n".join(details))
            subscribers = [c for c, g in state["subscribers"].items()
                           if g == key and not is_muted(state, c, cid)]
            text = f"<b>{course_name}</b>\n\n" + "\n".join(changes)
            # у кого включена сводка — копим до вечера, остальным сразу
            for c in [c for c in subscribers if user_wants_digest(state, c)]:
                state["digest"].setdefault(c, []).append(text)
            subscribers = [c for c in subscribers if not user_wants_digest(state, c)]
            if not broadcast(subscribers, text, state, reply_markup=REMIND_TOMORROW):
                # не доставили никому — оставим старый снимок и попробуем в следующий раз
                continue
            log.info("Группа %s, курс %s: %d изменений, подписчиков %d",
                     key, cid, len(changes), len(subscribers))
            send_files(fetcher, course_name, changed_files(old_snapshot, new), subscribers, state)
        snapshots[scid] = new
        update_prints(course_prints, new, fetcher, backfill)

    dated = {}
    state["deadlines"][key] = get_deadlines(token, course_ids, state["deadlines"].get(key, []), dated)
    # контрольные/экзамены: курсы, которые не удалось получить сейчас, берём из прошлого раза
    old_works = {}
    for w in state["assessments"].get(key, []):
        old_works.setdefault(w["c"], []).append(w)
    now = time.time()
    state["assessments"][key] = [
        w for cid in map(str, course_ids)
        for w in (find_assessments(cid, infos[cid], dated, now) if cid in infos else old_works.get(cid, []))
    ]
    send_reminders(key, state)


def send_digests(state):
    """Сводка: после DIGEST_HOUR по Москве — накопленное одним сообщением.
    Тем, кто выключил сводку, накопленное отправляем сразу."""
    now = datetime.now(MSK)
    today = now.strftime("%Y-%m-%d")
    evening = now.hour >= DIGEST_HOUR and state.get("digest_day") != today
    for chat_id, items in list(state["digest"].items()):
        if chat_id not in state["subscribers"]:
            del state["digest"][chat_id]
            continue
        if not items or (user_wants_digest(state, chat_id) and not evening):
            continue
        title = f"🗞 <b>Сводка за {now:%d.%m}</b>" if user_wants_digest(state, chat_id) \
            else "🗞 <b>Накопленные изменения</b>"
        if broadcast([chat_id], title + "\n\n" + "\n\n".join(items), state, reply_markup=REMIND_TOMORROW):
            state["digest"].pop(chat_id, None)
    if evening:
        state["digest_day"] = today


def check_moodle(groups, state):
    # группы, удалённые из конфига, забываем
    for section in ("snapshots", "course_names", "deadlines", "reminders_sent", "fingerprints", "assessments"):
        for key in list(state[section]):
            if key not in groups:
                del state[section][key]

    for key, group in groups.items():
        try:
            check_group(key, group, state)
            error = None
        except (MoodleError, requests.RequestException, ValueError, KeyError) as e:
            error = str(e)
            log.error("Группа %s: %s", key, error)

        # админу пишем только при смене статуса, а не на каждой проверке
        previous = state["group_errors"].get(key)
        if error != previous:
            title = html.escape(group["title"])
            if error:
                notify_admin(f"⚠️ Группа <b>{title}</b>: {html.escape(error)}")
                state["group_errors"][key] = error
            else:
                notify_admin(f"✅ Группа <b>{title}</b> снова проверяется")
                state["group_errors"].pop(key, None)
        save_state(state)

    send_digests(state)
    save_state(state)


# ------------------------------ Главное -------------------------------

def main():
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("Не задан секрет TELEGRAM_BOT_TOKEN")
    global LOADED_STATE_HASH
    groups = load_groups()
    state = load_state(groups)
    LOADED_STATE_HASH = state_hash(state)
    try:
        run(groups, state)  # в конце сам сохраняет состояние в Worker
    except Exception:
        # запуск упал посередине — сохраняем, чтобы уже разосланное не повторилось
        if relay_enabled():
            save_state(state)
            flush_state(state)
        raise


def run(groups, state):
    # подписки удалённых групп снимаем
    for chat_id, key in list(state["subscribers"].items()):
        if key not in groups:
            del state["subscribers"][chat_id]
            state["muted"].pop(chat_id, None)

    setup_bot_profile(groups, state)
    sync_error = None
    try:
        sync_telegram(groups, state)
    except (TelegramError, requests.RequestException, ValueError, KeyError) as e:
        # без свежих подписок проживём (останутся прошлые), Moodle всё равно проверим
        sync_error = f"{type(e).__name__}: {e}"
        log.error("Не удалось получить сообщения/подписчиков: %s", e)
    save_state(state)

    check_moodle(groups, state)
    save_state(state)

    if relay_enabled():
        push_error = None
        try:
            push_to_relay(groups, state)
        except (requests.RequestException, ValueError) as e:
            push_error = f"{type(e).__name__}: {e}"
            log.error("Не удалось отправить данные в Worker: %s", e)
        save_state(state)
        # итог запуска виден на <RELAY_URL>/status — без доступа к логам Actions
        try:
            state_bytes = flush_state(state)  # 0 — состояние не менялось
        except (requests.RequestException, ValueError) as e:
            state_bytes = None
            log.error("Не удалось сохранить состояние в Worker: %s", e)
        try:
            relay("POST", "/api/report", {
                "state_bytes": state_bytes,
                "ts": int(time.time()),  # по нему сторож в Worker видит, что проверки идут
                "time": datetime.now(MSK).strftime("%d.%m %H:%M:%S МСК"),
                "sync_error": sync_error,
                "push_error": push_error,
                "group_errors": state["group_errors"],
                "subscribers": len(state["subscribers"]),
                "relay_migrated": bool(state.get("relay_migrated")),
            })
        except (requests.RequestException, ValueError) as e:
            log.warning("Не удалось отправить отчёт в Worker: %s", e)
    log.info("Готово. Групп: %d, подписчиков: %d", len(groups), len(state["subscribers"]))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log.exception("Запуск завершился ошибкой")
        sys.exit(1)
