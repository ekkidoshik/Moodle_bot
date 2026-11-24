const telegram = window.Telegram?.WebApp;
const view = document.querySelector("#view");
const tabs = document.querySelector("#tabs");
const group = document.querySelector("#group");
const settings = document.querySelector("#settings");
const favorites = document.querySelector("#favorites");
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
let overview;
let navigation = 0;

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function button(label, className, action) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function heading(title) {
  return element("h1", "", title);
}

function notice(message) {
  return element("p", "notice", message);
}

function emptyState(message, joke) {
  return element("div", "notice", message, element("span", "meme", joke));
}

function section(title, content, action) {
  const header = element("div", "section-head", element("h2", "", title));
  if (action) header.append(action);
  return element("section", "section", header, content);
}

function externalRow(url, className, ...content) {
  if (!/^https:\/\//i.test(url || "")) return element("div", className, ...content);
  const link = element("a", className, ...content);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (telegram?.openLink) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      telegram.openLink(link.href);
    });
  }
  return link;
}

async function api(path, params = {}, payload, method = payload ? "POST" : "GET") {
  const query = new URLSearchParams(params);
  const response = await fetch(`/mini-api/${path}?${query}`, {
    method,
    headers: { Authorization: `tma ${telegram.initData}`,
      ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Не удалось загрузить данные.");
  return data;
}

function deadlineList(deadlines) {
  if (!deadlines.length) return emptyState("Ближайших дедлайнов нет.", "Moodle: сегодня без сюрпризов.");
  return element("div", "list", ...deadlines.map((deadline) => {
    const date = new Date(deadline.due * 1000);
    const course = overview.courses.find((item) => item.id === deadline.course);
    return externalRow(deadline.url, "row", element("div", "date-row",
      element("span", "date", dateFormat.format(date)),
      element("div", "", element("strong", "", deadline.name),
        element("span", "meta", [course?.name, `${timeFormat.format(date)} МСК`].filter(Boolean).join(" · ")))));
  }));
}

function courseList(courses) {
  if (!courses.length) return notice("Курсы появятся после синхронизации с Moodle.");
  return element("div", "list", ...courses.map((course) =>
    button(element("span", "course-row", element("span", "row-icon", "▤"),
      element("span", "", element("strong", "", course.name),
        element("span", "meta", course.muted ? "Уведомления выключены" : "Материалы курса"))),
    "row", () => openCourse(course))));
}

function stat(value, label, target) {
  return button(element("span", "", element("strong", "", String(value)), label), "stat", () => switchTab(target));
}

function applyOverview(data) {
  overview = data;
  group.textContent = data.group || "";
  group.hidden = !data.group;
  tabs.hidden = !data.group;
  settings.hidden = false;
  favorites.hidden = false;
}

function showSupport() {
  const input = element("textarea", "group-select");
  input.id = "support-message";
  input.rows = 5;
  input.maxLength = 3500;
  input.required = true;
  const submit = element("button", "primary more", "Отправить");
  submit.type = "submit";
  const status = element("p", "settings-status");
  status.setAttribute("role", "status");
  const form = element("form", "settings-card", element("label", "group-label", "Сообщение", input), submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || submit.disabled) return;
    input.disabled = submit.disabled = true;
    status.textContent = "Отправляем…";
    try {
      await api("support", {}, { text });
      input.value = "";
      status.textContent = "Сообщение отправлено. Ответ придёт в чат Moodle-бота.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      input.disabled = submit.disabled = false;
    }
  });
  view.replaceChildren(heading("Поддержка"),
    element("p", "settings-intro", "Здесь можно задать вопрос или попросить добавить свою группу в бота."), form);
}

function itemRow(item, meta, action) {
  return element("div", "item-row",
    externalRow(item.url, "row", element("strong", "", item.name), element("span", "meta", meta)), action);
}

function fileActions(item) {
  const files = item.files.map((path) => {
    const label = item.files.length === 1 ? "Получить файл в Telegram" : path;
    const action = button(label, "file-action", async () => {
      action.disabled = true;
      try {
        await api("file", {}, { id: item.id, path });
        status.textContent = "Файл придёт в чат бота. Обычно это занимает до 5 минут.";
        action.textContent = "Запрошено";
      } catch (error) {
        action.disabled = false;
        status.textContent = error.message;
      }
    });
    const status = element("p", "file-status");
    status.setAttribute("role", "status");
    return element("div", "file-option", action, status);
  });
  if (files.length === 1) return files[0];
  return element("details", "file-options", element("summary", "", "Получить файл в Telegram"), ...files);
}

async function showFavorites(container, version, cursor) {
  try {
    const data = await api("favorites", cursor ? { cursor } : {});
    if (navigation !== version) return;
    if (!cursor) container.replaceChildren();
    for (const item of data.items) {
      const remove = button("×", "item-action", async () => {
        remove.disabled = true;
        try {
          await api("favorites", { id: item.id }, undefined, "DELETE");
          row.remove();
          if (!container.children.length) container.append(notice("Избранное пока пусто."));
        } catch (error) {
          remove.disabled = false;
          remove.title = error.message;
          container.append(notice(error.message));
        }
      });
      remove.setAttribute("aria-label", `Убрать из избранного: ${item.name}`);
      const row = itemRow(item, [item.course, ...item.files].filter(Boolean).join(" · "), remove);
      container.append(row);
    }
    if (data.cursor) {
      const next = button("Показать ещё", "primary more", () => {
        next.remove();
        showFavorites(container, version, data.cursor);
      });
      container.append(next);
    } else if (!container.children.length) {
      container.append(notice("Избранное пока пусто. Сохраняйте материалы кнопкой ☆."));
    }
  } catch (error) {
    if (navigation !== version) return;
    if (!cursor) container.replaceChildren();
    container.append(notice(error.message));
  }
}

function showSettings() {
  const select = element("select", "group-select");
  const placeholder = element("option", "", "Выберите группу");
  placeholder.value = "";
  placeholder.disabled = true;
  select.append(placeholder);
  for (const item of overview.groups) {
    const option = element("option", "", item.title);
    option.value = item.key;
    select.append(option);
  }
  select.value = overview.groupKey || "";
  const submit = element("button", "primary more", "Сохранить");
  submit.type = "submit";
  const status = element("p", "settings-status");
  status.setAttribute("role", "status");
  const label = element("label", "group-label", "Учебная группа", select);
  const form = element("form", "settings-card", label, submit, status);
  const updateSubmit = () => { submit.disabled = !select.value || select.value === overview.groupKey; };
  updateSubmit();
  select.addEventListener("change", updateSubmit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    select.disabled = submit.disabled = true;
    settings.disabled = true;
    tabs.inert = true;
    telegram?.BackButton?.hide();
    status.textContent = "Сохраняем группу…";
    try {
      applyOverview(await api("group", {}, { group: select.value }));
      switchTab("home");
    } catch (error) {
      status.textContent = error.message;
      if (overview.group) telegram?.BackButton?.show();
    } finally {
      select.disabled = settings.disabled = tabs.inert = false;
      updateSubmit();
    }
  });
  view.replaceChildren(heading(overview.group ? "Настройки" : "Выберите группу"),
    element("p", "settings-intro", "Курсы, дедлайны и уведомления бота будут относиться к выбранной группе."),
    form, button("Связаться с поддержкой", "row secondary", () => switchTab("support")));
}

function switchTab(tab) {
  navigation++;
  for (const node of tabs.querySelectorAll("button")) {
    if (node.dataset.tab === tab) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  telegram?.BackButton?.hide();
  window.scrollTo(0, 0);

  if (tab === "support" || tab === "favorites") {
    telegram?.BackButton?.show();
    if (tab === "support") {
      showSupport();
    } else {
      const list = element("div", "list", notice("Загружаем избранное…"));
      view.replaceChildren(heading("Избранное"), list);
      showFavorites(list, navigation);
    }
  } else if (tab === "settings") {
    if (overview.group) telegram?.BackButton?.show();
    showSettings();
  } else if (tab === "home") {
    view.replaceChildren(
      element("section", "hero",
        heading(overview.firstName ? `Привет, ${overview.firstName}!` : "Учёба под рукой"),
        element("p", "", "Курсы и дедлайны вашей группы")),
      element("div", "summary", stat(overview.courses.length, "Курсы", "courses"),
        stat(overview.deadlines.length, "Дедлайны", "deadlines")),
      section("Ближайшие дедлайны", deadlineList(overview.deadlines.slice(0, 3)),
        button("Все дедлайны", "link-button", () => switchTab("deadlines"))),
      section("Мои курсы", courseList(overview.courses.slice(0, 3)),
        button("Все курсы", "link-button", () => switchTab("courses"))),
      button("Связаться с поддержкой", "link-button support-link", () => switchTab("support")));
  } else if (tab === "courses") {
    view.replaceChildren(heading("Мои курсы"), courseList(overview.courses));
  } else if (tab === "deadlines") {
    view.replaceChildren(heading("Дедлайны"), deadlineList(overview.deadlines));
  } else {
    const input = element("input", "");
    input.type = "search";
    input.placeholder = "Например, лекция или КТП";
    input.setAttribute("aria-label", "Название материала или файла");
    input.maxLength = 120;
    const submit = element("button", "primary", "Найти");
    submit.type = "submit";
    const form = element("form", "search", input, submit);
    const results = element("div", "");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const q = input.value.trim();
      if (q) showMaterials(results, { q }, ++navigation);
    });
    view.replaceChildren(heading("Поиск материалов"), form, results);
  }
}

function openCourse(course) {
  const version = ++navigation;
  const results = element("div", "");
  window.scrollTo(0, 0);
  telegram?.BackButton?.show();
  view.replaceChildren(button("К списку курсов", "back", () => switchTab("courses")),
    heading(course.name), section("Материалы", results));
  showMaterials(results, { course: course.id }, version);
}

async function showMaterials(container, params, version, page = 0) {
  if (!page) container.replaceChildren(notice("Загружаем материалы…"));
  try {
    const { items, more } = await api("materials", { ...params, page });
    if (version !== navigation) return;
    if (!page) container.replaceChildren();
    if (!items.length && !page) container.append(params.q
      ? emptyState("Материалы не найдены.", "Где-то лежит «финал_точно_финал.pdf».")
      : notice("В этом курсе пока нет материалов."));
    if (items.length) {
      container.append(element("div", "list", ...items.map((item) => {
        const meta = [params.q ? item.course : "", ...item.files].filter(Boolean).join(" · ");
        if (!/^https:\/\//i.test(item.url || "")) {
          return element("article", "material-result", externalRow(item.url, "row",
            element("strong", "", item.name), element("span", "meta", meta)),
          ...(item.files.length ? [fileActions(item)] : []));
        }
        const save = button("☆", "item-action", async () => {
          save.disabled = true;
          try {
            await api("favorites", {}, { id: item.id });
            save.textContent = "★";
            save.setAttribute("aria-label", "В избранном");
          } catch (error) {
            save.disabled = false;
            container.append(notice(error.message));
          }
        });
        save.setAttribute("aria-label", `В избранное: ${item.name}`);
        return element("article", "material-result", itemRow(item, meta, save),
          ...(item.files.length ? [fileActions(item)] : []));
      })));
    }
    if (more) {
      const next = button("Показать ещё", "primary more", async () => {
        next.remove();
        await showMaterials(container, params, version, page + 1);
      });
      container.append(next);
    }
  } catch (error) {
    if (version !== navigation) return;
    if (!page) container.replaceChildren();
    container.append(notice(error.message || "Не удалось загрузить материалы."),
      button("Повторить", "primary more", (event) => {
        if (page) event.currentTarget.remove();
        showMaterials(container, params, version, page);
      }));
  }
}

async function start() {
  telegram?.ready();
  telegram?.expand();
  if (!telegram?.initData) {
    view.replaceChildren(element("section", "hero", heading("Учёба под рукой"),
      element("p", "", "Откройте мини-приложение через команду /app в Telegram-боте Moodle.")));
    return;
  }
  try {
    applyOverview(await api("overview"));
    switchTab(overview.group ? "home" : "settings");
  } catch (error) {
    view.replaceChildren(heading("Не удалось открыть кабинет"), notice(error.message),
      button("Повторить", "primary more", start));
  }
}

tabs.addEventListener("click", (event) => {
  const tab = event.target.closest("button[data-tab]")?.dataset.tab;
  if (tab) switchTab(tab);
});
settings.addEventListener("click", () => switchTab("settings"));
favorites.addEventListener("click", () => switchTab("favorites"));
telegram?.BackButton?.onClick(() => {
  if (!overview || settings.disabled) return;
  switchTab(!overview.group ? "settings" : tabs.querySelector('[aria-current="page"]') ? "courses" : "home");
});

start();
