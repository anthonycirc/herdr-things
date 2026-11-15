// Things 3 to-dos in a Herdr panel, read from the Things app through AppleScript (JXA).
// Click the box to complete, the title to open it in Things, the header to pick which list to show.
//
// Block props (all optional):
//   list     list shown until one is picked: inbox, today, upcoming, anytime, someday   default "today"
//   refresh  seconds between reads (>= 15)                                             default 60
//   key      keeps the picked list apart when several panels are shown
//
// Commands: things.refresh, things.menu. The panel takes the keyboard from pane.go (ctrl-h).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, theme, props, shared, setShared, openOverlay, closeOverlay, nextCommand, run } from "herdr";

const DEFAULT_REFRESH_S = 60;
const PERMISSION_HINT = "System Settings → Privacy & Security → Automation: allow Herdr to control Things3.";

// Built-in lists by id: their names follow the app's language.
const PRESETS = [
  { kind: "list", id: "TMInboxListSource", label: "Inbox", name: "inbox" },
  { kind: "list", id: "TMTodayListSource", label: "Today", name: "today" },
  { kind: "list", id: "TMCalendarListSource", label: "Upcoming", name: "upcoming" },
  { kind: "list", id: "TMNextListSource", label: "Anytime", name: "anytime" },
  { kind: "list", id: "TMSomedayListSource", label: "Someday", name: "someday" },
];

// Runs inside osascript with argv: list <list|project|area|tag> <id or tag name>, search <text>,
// sources, complete <id>. Prints JSON. Things isn't launched: a closed app answers { closed: true }.
const SCRIPT = String.raw`
function run(argv) {
  const [cmd, a, b] = argv;
  const app = Application("Things3");
  if (!app.running()) return JSON.stringify({ closed: true });
  // Projects are to-dos too: leave them out by id.
  const projectIds = new Set(app.projects.id());
  const open = (ref) => {
    const id = ref.id(), name = ref.name(), status = ref.status();
    const due = ref.dueDate(), proj = ref.project(), area = ref.area();
    const out = [];
    for (let i = 0; i < id.length; i++) {
      if (status[i] !== "open" || projectIds.has(id[i])) continue;
      const deadline = due[i] ? due[i].getFullYear() + "-" + String(due[i].getMonth() + 1).padStart(2, "0") + "-" + String(due[i].getDate()).padStart(2, "0") : null;
      out.push({ id: id[i], name: name[i], deadline, parent: proj[i] ? proj[i].name() : area[i] ? area[i].name() : null });
    }
    return out;
  };
  if (cmd === "list") {
    const src = a === "list" ? app.lists.byId(b) : a === "project" ? app.projects.byId(b) : a === "area" ? app.areas.byId(b) : app.tags.byName(b);
    return JSON.stringify({ tasks: open(src.toDos) });
  }
  if (cmd === "search") {
    const q = a.toLowerCase(), seen = new Set(), tasks = [];
    for (const l of ["TMInboxListSource", "TMTodayListSource", "TMCalendarListSource", "TMNextListSource", "TMSomedayListSource"]) {
      for (const t of open(app.lists.byId(l).toDos)) {
        if (seen.has(t.id) || !t.name.toLowerCase().includes(q)) continue;
        seen.add(t.id);
        tasks.push(t);
      }
    }
    return JSON.stringify({ tasks });
  }
  if (cmd === "sources") {
    const aname = app.areas.name(), pid = app.projects.id(), pname = app.projects.name(), pstatus = app.projects.status();
    return JSON.stringify({
      areas: app.areas.id().map((id, i) => ({ id, name: aname[i] })),
      projects: pid.flatMap((id, i) => (pstatus[i] === "open" ? [{ id, name: pname[i] }] : [])),
      tags: app.tags.name(),
    });
  }
  if (cmd === "complete") {
    app.toDos.byId(a).status = "completed";
    return JSON.stringify({ ok: true });
  }
  throw new Error("unknown command " + cmd);
}
`;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// "2026-11-20" → "Nov 20". Herdr's toLocaleDateString ignores its options, so the month is spelled here.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}`;

const config = () => {
  const p = props() ?? {};
  return {
    list: PRESETS.find((v) => v.name === p.list) ?? PRESETS[1],
    refresh: Math.max(15, Number(p.refresh) || DEFAULT_REFRESH_S) * 1000,
    key: `things.view.${p.key || "default"}`,
  };
};

// The picked list, else the block's default list.
const currentView = (key = config().key) => shared(key) ?? config().list;

const viewKey = (v) => v?.query ?? v?.id ?? v?.name;
const sameView = (a, b) => a?.kind === b?.kind && viewKey(a) === viewKey(b);

const listArgs = (view) =>
  view.kind === "search" ? ["search", view.query]
  : view.kind === "tag" ? ["list", "tag", view.name]
  : ["list", view.kind, view.id];

// osascript errors read "execution error: Error: Error: <message> (<code>)".
const cleanError = (s) => s.replace(/^.*?execution error:\s*(Error:\s*)*/s, "").trim();

// Text from the user or from Things only ever travels as argv after a command word (list, search,
// complete), never inside the script: osascript stops reading options there, and no shell runs.
// -1743: Herdr isn't allowed to send Apple events to Things. -2700/-10814: Things isn't installed.
async function things(args) {
  const r = await exec("osascript", ["-l", "JavaScript", "-e", SCRIPT, ...args], { timeout: 20000 });
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim() || `osascript exited ${r.code}`;
    const err = new Error(cleanError(msg));
    err.denied = /-1743\b/.test(msg);
    err.missing = /-10814\b|can.t be found|introuvable/i.test(msg);
    throw err;
  }
  const out = JSON.parse(r.stdout);
  if (out.closed) {
    const err = new Error("Things isn't open.");
    err.closed = true;
    throw err;
  }
  return out;
}

const openInThings = (id) => exec("open", [`things:///show?id=${encodeURIComponent(id)}`]).catch(() => {});

export default class Things extends View {
  init(_props, cx) {
    if (props()?.menu) return this.initMenu(cx);
    this.tasks = [];
    this.error = null;
    this.hint = null;
    this.loading = true;
    this.refreshing = false;
    this.again = false;
    this.pending = new Set();
    this.hovered = null;
    this.sel = 0;
    this.handle = cx.focus_handle();
    this.listScroll = ScrollHandle.new();
    cx.timer.every(config().refresh, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (c === "menu") this.openMenu("dialog");
        // pane.go landed here, or a popup over the panel closed.
        else if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
    this.refresh(cx);
  }

  refresh(cx) {
    // One read at a time; a request during a read runs once it ends.
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const view = currentView();
      try {
        this.tasks = (await things(listArgs(view))).tasks ?? [];
        this.loadedView = view;
        this.error = null;
        this.hint = null;
      } catch (e) {
        this.error = e.missing ? "Things 3 isn't installed." : String(e?.message ?? e);
        this.hint = e.denied ? PERMISSION_HINT : null;
        // Rows of another list, or of a closed app, would read as this one's.
        if (e.closed || !sameView(view, this.loadedView)) this.tasks = [];
        this.loadedView = view;
      }
      this.loading = false;
      this.refreshing = false;
      this.updated = new Date();
      if (this.again) {
        this.again = false;
        this.refresh(cx);
      }
      cx.notify();
    });
  }

  complete(task, cx) {
    if (this.pending.has(task.id)) return;
    this.pending.add(task.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await things(["complete", task.id]);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.pending.delete(task.id);
      this.refresh(cx);
    });
  }

  // A popup at the pointer from a click; a dialog from a key or command, which has no pointer.
  openMenu(kind = "popup") {
    openOverlay({ mod: "things", kind, width: 280, height: 440, props: { menu: true, key: config().key } });
  }

  // j/k move, x completes, Enter opens, r refreshes, / or m picks a list, l or Esc goes back.
  panelKey(e, cx) {
    const k = e.key;
    const n = this.tasks.length;
    const move = (to) => {
      this.sel = Math.max(0, Math.min(n - 1, to));
      this.listScroll.scroll_to_item(this.sel);
    };
    const task = this.tasks[this.sel];
    if (e.modifiers?.control || e.modifiers?.platform) return;
    if (k === "j" || k === "down") move(this.sel + 1);
    else if (k === "k" || k === "up") move(this.sel - 1);
    else if (k === "G" || (k === "g" && e.modifiers?.shift)) move(n - 1);
    else if (k === "g") move(0);
    else if (k === "x" || k === "space") task && this.complete(task, cx);
    else if (k === "enter" || k === "o") task && openInThings(task.id);
    else if (k === "r") this.refresh(cx);
    else if (k === "/" || k === "m") this.openMenu("dialog");
    else if (k === "l" || k === "escape") run("pane.go", { direction: "right" });
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  row(t, task, now, i, focused) {
    const selected = focused && i === this.sel;
    const done = this.pending.has(task.id);
    const late = Boolean(task.deadline) && task.deadline <= now;
    return h_flex()
      .id(`th-${task.id}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = task.id;
        else if (this.hovered === task.id) this.hovered = null;
        cx.notify();
      })
      .child(
        div()
          .id(`th-check-${task.id}`)
          .flex_none()
          .size(14)
          .rounded(4)
          .border(1.5)
          .border_color(late ? t.ansi1 : t.dim)
          .cursor_pointer()
          .when(done || this.hovered === task.id, (el) => el.bg(late ? t.ansi1 : t.dim))
          .tooltip("Complete")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.complete(task, cx);
          }),
      )
      .child(
        div()
          .id(`th-open-${task.id}`)
          .flex_1()
          .min_w(0)
          .truncate()
          .cursor_pointer()
          .text_color(done ? t.dim : t.foreground)
          .tooltip(task.parent ? `${task.parent} · Open in Things` : "Open in Things")
          .on_click(() => openInThings(task.id))
          .child(task.name),
      )
      .when(Boolean(task.deadline), (el) =>
        el.child(div().flex_none().text_size(11).text_color(late ? t.ansi1 : t.dim).child(shortDate(task.deadline))),
      );
  }

  render(cx) {
    if (props()?.menu) return this.renderMenu(cx);
    const t = theme();
    const now = today();
    const view = currentView();
    // A list picked in the menu, or by another copy: read it once.
    if (this.loadedView && !this.refreshing && !sameView(view, this.loadedView)) {
      this.loadedView = view;
      cx.spawn(async (cx) => this.refresh(cx));
    }
    const note = (text, color) => div().px(16).pb(6).text_size(12).text_color(color).child(text);
    const focused = this.handle.is_focused();
    this.sel = Math.max(0, Math.min(this.tasks.length - 1, this.sel));
    const updated = this.updated ? `Refresh · updated ${this.updated.toLocaleTimeString().slice(0, 5)}` : "Refresh";
    return v_flex()
      .id("th-panel")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.panelKey(e, cx))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(
        h_flex()
          .px(16)
          .h(41)
          .pt(14)
          .pb(5)
          .flex_none()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .id("th-pick")
              .min_w(0)
              .gap(4)
              .items_center()
              .cursor_pointer()
              .text_size(11.5)
              .font_medium()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip("Choose a list")
              .on_click(() => this.openMenu())
              .child(div().min_w(0).truncate().child(`${view.label} · ${this.tasks.length}`))
              .child(svg("mods/things/chevron-down.svg").size(12).flex_none()),
          )
          .child(
            div()
              .id("th-refresh")
              .flex_none()
              .cursor_pointer()
              .text_color(this.refreshing ? t.foreground : t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip(updated)
              .on_click((_e, cx) => this.refresh(cx))
              .child(
                this.refreshing
                  ? svg("mods/things/refresh.svg").size(14).spin(900)
                  : svg("mods/things/refresh.svg").size(14),
              ),
          ),
      )
      .when(Boolean(this.error), (el) => el.child(note(this.error, t.ansi1)))
      .when(Boolean(this.hint), (el) => el.child(note(this.hint, t.dim)))
      .when(this.loading, (el) => el.child(note("Loading…", t.dim)))
      .when(!this.loading && !this.error && this.tasks.length === 0, (el) => el.child(note("Nothing to do.", t.dim)))
      .child(
        v_flex()
          .id("th-list")
          .flex_1()
          .min_h(0)
          .px(8)
          .overflow_y_scrollbar()
          .track_scroll(this.listScroll)
          .children(this.tasks.map((task, i) => this.row(t, task, now, i, focused))),
      )
      .when(focused, (el) =>
        el.child(
          div()
            .px(16)
            .py(6)
            .flex_none()
            .text_size(10.5)
            .text_color(t.dim)
            .child("j/k move · x done · ⏎ open · / list · l back"),
        ),
      );
  }

  // The list menu: built-in lists, areas, projects, tags and a title search.

  initMenu(cx) {
    this.areas = [];
    this.projects = [];
    this.tags = [];
    this.at = null;
    this.moved = false;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ value: "", placeholder: "Search to-dos by title  ( / )" });
    this.input.on("submit", () => {
      const query = this.input.value().trim();
      if (query) this.pick({ kind: "search", query, label: `“${query}”` });
    });
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });
    // The list has the keyboard first, so j/k move at once; / or i types a search.
    this.handle = cx.focus_handle();
    this.handle.focus();
    // A dialog puts the first input in focus: take it back unless / or i asked for it.
    this.wantInput = false;
    cx.timer.after(300, () => this.wantInput || this.handle.focus());
    cx.spawn(async (cx) => {
      const s = await things(["sources"]).catch(() => ({}));
      this.areas = (s.areas ?? []).map((a) => ({ kind: "area", id: a.id, label: a.name }));
      this.projects = (s.projects ?? []).map((p) => ({ kind: "project", id: p.id, label: p.name }));
      this.tags = (s.tags ?? []).map((name) => ({ kind: "tag", name, label: name }));
      cx.notify();
    });
  }

  sections() {
    return [
      { title: "Lists", items: PRESETS },
      { title: "Areas", items: this.areas },
      { title: "Projects", items: this.projects },
      { title: "Tags", items: this.tags },
    ].filter((s) => s.items.length > 0);
  }

  pick(view) {
    const p = props();
    setShared(p.key, view);
    closeOverlay(p.overlay);
    run("things.refresh");
  }

  // Up/down/j/k move by one, h/l to the previous/next section's first item, g/G to the ends.
  menuKey(e, cx, items, starts) {
    const k = e.key;
    const ctrl = e.modifiers?.control;
    const move = (to) => {
      this.moved = true;
      this.at = Math.max(0, Math.min(items.length - 1, to));
      this.scroll.scroll_to_item(this.rowOf[this.at]);
    };
    if (k === "escape") {
      if (this.inputFocused) this.handle.focus();
      else closeOverlay(props().overlay);
    } else if (k === "down" || (ctrl && (k === "j" || k === "n"))) move(this.at + 1);
    else if (k === "up" || (ctrl && (k === "k" || k === "p"))) move(this.at - 1);
    else if (this.inputFocused) return;
    else if (k === "j") move(this.at + 1);
    else if (k === "k") move(this.at - 1);
    else if (k === "l") move(starts.find((s) => s > this.at) ?? this.at);
    else if (k === "h") move([...starts].reverse().find((s) => s < this.at) ?? 0);
    else if (k === "G" || (k === "g" && e.modifiers?.shift)) move(items.length - 1);
    else if (k === "g") move(0);
    else if (k === "enter") items[this.at] && this.pick(items[this.at]);
    else if (k === "/" || k === "i") {
      this.wantInput = true;
      this.input.focus();
    }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  renderMenu() {
    const t = theme();
    const on = currentView(props().key);
    const sections = this.sections();
    const items = sections.flatMap((s) => s.items);
    const starts = [];
    for (let i = 0, n = 0; i < sections.length; n += sections[i].items.length, i++) starts.push(n);
    // Until a key moves it, the selection follows the current list, which may load late (areas, projects).
    if (!this.moved || this.at >= items.length) this.at = Math.max(0, items.findIndex((v) => sameView(v, on)));
    // The list's children are headers and rows: where each item's row sits, for scrolling.
    this.rowOf = [];
    let row = 0;
    for (const s of sections) {
      row++;
      for (const _ of s.items) this.rowOf.push(row++);
    }
    const section = (text) => div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child(text);
    let index = 0;
    const item = (v) => {
      const i = index++;
      const selected = i === this.at;
      return h_flex()
        .id(`th-menu-${v.kind}-${v.id ?? v.name ?? v.query}`)
        .h(30)
        .px(8)
        .gap(9)
        .flex_none()
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .cursor_pointer()
        .when(selected, (el) => el.bg(t.selected))
        .hover((el) => el.bg(selected ? t.selected : t.hover))
        .on_click(() => this.pick(v))
        .child(div().flex_1().min_w(0).truncate().child(v.label))
        .when(sameView(v, on), (el) => el.child(svg("mods/things/check.svg").size(14).flex_none()));
    };
    return v_flex()
      .id("th-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.menuKey(e, cx, items, starts))
      .size_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(
        div()
          .px(4)
          .pt(4)
          .pb(2)
          .child(
            Input.new(this.input)
              .h(30)
              .px(8)
              .rounded(7)
              .border_1()
              .border_color(this.inputFocused ? t.accent : t.input)
              .bg(t.background)
              .text_size(12.5),
          ),
      )
      .child(
        v_flex()
          .id("th-menu-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .children(sections.flatMap((s) => [section(s.title), ...s.items.map(item)])),
      )
      .child(
        div()
          .px(8)
          .pt(4)
          .pb(2)
          .flex_none()
          .text_size(10.5)
          .text_color(t.dim)
          .child(this.inputFocused ? "⏎ search · ↑↓ move · esc back" : "j/k move · h/l section · ⏎ pick · / search"),
      );
  }
}
