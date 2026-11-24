const telegram = window.Telegram?.WebApp;
const view = document.querySelector("#view");
const tabs = document.querySelector("#tabs");
const group = document.querySelector("#group");
const settings = document.querySelector("#settings");
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

async function api(path, params = {}, payload) {
  const query = new URLSearchParams(params);
  const response = await fetch(`/mini-api/${path}?${query}`, {
    method: payload ? "POST" : "GET",
    headers: { Authorization: `tma ${telegram.initData}`,
      ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Не удалось загрузить данные.");
  return data;
}

function deadlineList(deadlines) {
  if (!deadlines.length) return notice("Ближайших дедлайнов нет.");
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
    form);
}

function switchTab(tab) {
  navigation++;
  for (const node of tabs.querySelectorAll("button")) {
    if (node.dataset.tab === tab) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  telegram?.BackButton?.hide();
  window.scrollTo(0, 0);

  if (tab === "settings") {
    if (overview.group) telegram?.BackButton?.show();
    showSettings();
  } else if (tab === "home") {
    view.replaceChildren(
      element("section", "hero", element("p", "eyebrow", "МОЙ MOODLE"),
        heading(overview.firstName ? `Привет, ${overview.firstName}!` : "Учёба под рукой"),
        element("p", "", "Курсы и дедлайны вашей группы")),
      element("div", "summary", stat(overview.courses.length, "Курсы", "courses"),
        stat(overview.deadlines.length, "Дедлайны", "deadlines")),
      section("Ближайшие дедлайны", deadlineList(overview.deadlines.slice(0, 3)),
        button("Все дедлайны", "link-button", () => switchTab("deadlines"))),
      section("Мои курсы", courseList(overview.courses.slice(0, 3)),
        button("Все курсы", "link-button", () => switchTab("courses"))));
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
    if (!items.length && !page) container.append(notice("Материалы не найдены."));
    if (items.length) {
      container.append(element("div", "list", ...items.map((item) =>
        externalRow(item.url, "row", element("strong", "", item.name),
          element("span", "meta", [params.q ? item.course : "", ...item.files].filter(Boolean).join(" · "))))));
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
telegram?.BackButton?.onClick(() => {
  if (!overview?.group || settings.disabled) return;
  switchTab(tabs.querySelector('[aria-current="page"]') ? "courses" : "home");
});

start();
