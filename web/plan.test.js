const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("./pantry.js");
const recipes = require("./recipes.js");
const plan = require("./plan.js");
const shop = require("./shop.js");

const { COPY, DAYS, STORAGE_KEY, MAX_RECIPES } = plan;

function dish(title, ingredients, steps, cost) {
  const recipe = { title, ingredients, steps };
  if (cost !== undefined) recipe.cost_toman = cost;
  return recipe;
}

const THREE = [
  dish("عدس‌پلو", ["برنج", "عدس"], ["پیاز را تفت بده", "عدس را بپز"], 180000),
  dish("لوبیا پلو", ["برنج", "لوبیا"], ["لوبیا را بپز", "برنج را دم کن"], 160000),
  dish("ماست و خیار", ["ماست", "خیار"], ["ماست را هم بزن", "سرد سرو کن"], 70000),
];

function fresh() {
  return plan.createPlan({ storage: plan.createMemoryStorage() });
}

function element(tag) {
  const node = {
    tag,
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    dataset: {},
    children: [],
    attrs: {},
    listeners: {},
    parentNode: null,
    append(...kids) {
      kids.forEach((kid) => {
        if (!kid) return;
        kid.parentNode = node;
        node.children.push(kid);
      });
    },
    replaceChildren(...kids) {
      node.children.forEach((kid) => {
        kid.parentNode = null;
      });
      node.children = [];
      node.append(...kids);
    },
    setAttribute(name, value) {
      node.attrs[name] = value;
    },
    getAttribute(name) {
      return node.attrs[name];
    },
    addEventListener(type, fn) {
      node.listeners[type] = fn;
    },
    focus() {
      node.focused = true;
    },
  };
  node.classList = {
    toggle(name, on) {
      const parts = new Set(node.className.split(/\s+/).filter(Boolean));
      const enable = on === undefined ? !parts.has(name) : !!on;
      if (enable) parts.add(name);
      else parts.delete(name);
      node.className = [...parts].join(" ");
    },
  };
  return node;
}

function fakeDocument() {
  const nodes = {};
  function register(id, tag, hidden) {
    const node = element(tag);
    node.id = id;
    node.hidden = !!hidden;
    nodes[id] = node;
    return node;
  }
  register("build-plan", "button");
  register("plan-export", "button");
  register("plan-share", "button");
  register("plan-status", "p");
  register("plan-budget", "p", true);
  register("plan-empty", "div");
  register("plan-share-box", "div", true);
  register("plan-share-url", "input");
  register("plan-share-copy", "button");
  nodes["plan-budget"].className = "budget-strip";
  register("week-grid", "div");
  register("plan", "section");
  register("plan-sheet", "div", true);
  nodes["plan-sheet"].className = "sheet";
  nodes["plan-sheet"].dataset.mode = "";
  register("plan-sheet-title", "h2");
  register("plan-sheet-hint", "p");
  register("plan-sheet-list", "ul");
  register("plan-sheet-close", "button");
  register("plan-sheet-cancel", "button");
  register("week-budget", "input");
  const doc = {
    nodes,
    listeners: {},
    body: element("body"),
    getElementById(id) {
      return nodes[id] || null;
    },
    createElement: element,
    addEventListener(type, fn) {
      if (!doc.listeners[type]) doc.listeners[type] = [];
      doc.listeners[type].push(fn);
    },
  };
  return doc;
}

function fire(doc, type, event) {
  (doc.listeners[type] || []).forEach((fn) => fn(event));
}

function click(doc, target) {
  fire(doc, "click", { target });
}

function sheetChoices(doc) {
  return doc.nodes["plan-sheet-list"].children.map((li) => li.children[0]);
}

function dayCards(doc) {
  return doc.nodes["week-grid"].children;
}

function mountPlan(options) {
  const model = options.model || fresh();
  const doc = fakeDocument();
  const downloads = [];
  const prints = [];
  let budget = Object.prototype.hasOwnProperty.call(options, "budget") ? options.budget : null;
  plan.mount(doc, model, {
    latest() {
      return options.latest || [];
    },
    budget() {
      return budget;
    },
    download(text, filename) {
      downloads.push({ text, filename });
    },
    print() {
      prints.push(1);
    },
  });
  return {
    doc,
    model,
    downloads,
    prints,
    setBudget(value) {
      budget = value;
    },
  };
}

test("the Persian week runs Saturday through Friday", () => {
  assert.deepEqual(
    DAYS.map((day) => day.id),
    ["sat", "sun", "mon", "tue", "wed", "thu", "fri"],
  );
  assert.deepEqual(
    DAYS.map((day) => day.label),
    ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"],
  );
  assert.equal(DAYS[3].label, "\u0633\u0647\u200c\u0634\u0646\u0628\u0647");
  assert.equal(COPY.empty, "خالی");
  assert.equal(COPY.swap, "جایگزین");
  assert.equal(COPY.addToPlan, "افزودن به برنامه");
  assert.equal(COPY.export, "چاپ / خروجی");
  assert.equal(STORAGE_KEY, "ashpaz-khoone.plan.v1");
});

test("empty days stay خالی until a recipe is assigned or swapped", () => {
  const model = fresh();
  assert.equal(model.week().length, 7);
  model.week().forEach((day) => assert.equal(day.recipe, null));

  const assigned = model.assign("sat", THREE[0]);
  assert.equal(assigned.ok, true);
  assert.equal(assigned.replaced, false);
  assert.equal(model.week()[0].recipe.title, "عدس‌پلو");
  assert.equal(model.week()[1].recipe, null);

  const swapped = model.assign("sat", THREE[1]);
  assert.equal(swapped.replaced, true);
  assert.equal(model.week()[0].recipe.title, "لوبیا پلو");

  const cleared = model.clearDay("sat");
  assert.equal(cleared.cleared, true);
  assert.equal(model.week()[0].recipe, null);
  assert.equal(model.assign("nope", THREE[0]).ok, false);
  assert.equal(model.assign("sun", { title: "  " }).ok, false);
});

test("Arabic and Persian spellings of one title stay one recipe", () => {
  const model = fresh();
  model.remember([dish("كباب", ["پیاز"], ["بپز"], 1000)]);
  model.assign("fri", model.recipes()[0].id);
  model.remember([dish("کباب", ["پیاز"], ["کباب را بپز"], 2000)]);
  assert.equal(model.recipes().length, 1);
  assert.equal(model.recipes()[0].title, "کباب");
  assert.equal(model.recipes()[0].cost_toman, 2000);
  assert.equal(model.week()[6].recipe.title, "کباب");
  assert.equal(model.week()[6].recipe.cost_toman, 2000);
});

test("building the week fills only empty days, repeating recipes", () => {
  const model = fresh();
  assert.equal(model.fillEmpty().filled, 0);
  model.remember(THREE);
  model.assign("sat", THREE[2]);
  const result = model.fillEmpty();
  assert.equal(result.filled, 6);
  const titles = model.week().map((day) => day.recipe.title);
  assert.deepEqual(titles, [
    "ماست و خیار",
    "عدس‌پلو",
    "لوبیا پلو",
    "ماست و خیار",
    "عدس‌پلو",
    "لوبیا پلو",
    "ماست و خیار",
  ]);
  assert.equal(model.fillEmpty().filled, 0);
  assert.equal(model.spend(), 180000 + 160000 + 70000 + 180000 + 160000 + 70000 + 70000);
});

test("replace restores recipes, slots, and eaten days without a remote write", () => {
  const storage = plan.createMemoryStorage();
  const model = plan.createPlan({ storage });
  let calls = 0;
  global.AshpazPersist = {
    onPlan() {
      calls += 1;
    },
  };
  try {
    model.replace({
      recipes: [dish("عدس‌پلو", ["برنج"], ["بپز"], 10)],
      slots: { sat: "r:عدسپلو" },
      used: { sat: true },
    });
    assert.equal(calls, 0);
    assert.equal(model.week()[0].recipe.title, "عدس‌پلو");
    assert.equal(model.week()[0].used, true);
    const again = plan.createPlan({ storage });
    assert.equal(again.week()[0].used, true);
    assert.equal(again.snapshot().slots.sat, "r:عدسپلو");
  } finally {
    delete global.AshpazPersist;
  }
});

test("a share event names an empty week without wiping a remote redraw", () => {
  const view = mountPlan({ latest: [] });
  view.model.assign("sat", THREE[0]);
  fire(view.doc, "ashpaz-plan-changed", {
    detail: { source: "share", shared: { ok: true, empty: true } },
  });
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.shareEmptyOpened);
  assert.equal(view.model.week()[0].recipe.title, "عدس‌پلو");
  fire(view.doc, "ashpaz-plan-changed", { detail: { source: "remote" } });
  assert.equal(
    dayCards(view.doc)[0].children.find((node) => node.dataset.testid === "day-meal").textContent,
    "عدس‌پلو",
  );
});

test("a remote plan event redraws the week", () => {
  const view = mountPlan({});
  view.model.replace({
    recipes: [dish("عدس‌پلو", ["برنج"], ["بپز"], 10)],
    slots: { sat: "r:عدسپلو" },
    used: { sat: true },
  });
  fire(view.doc, "ashpaz-plan-changed", { detail: { source: "remote" } });
  const meal = dayCards(view.doc)[0].children.find((node) => node.dataset.testid === "day-meal");
  assert.equal(meal.textContent, "عدس‌پلو — خورده شد");
});

test("the plan is remembered in localStorage and ignores a broken save", () => {
  const storage = plan.createMemoryStorage();
  const first = plan.createPlan({ storage });
  first.assign("sun", THREE[0]);
  const second = plan.createPlan({ storage });
  assert.equal(second.week()[1].recipe.title, "عدس‌پلو");
  assert.equal(second.week()[0].recipe, null);

  storage.setItem(STORAGE_KEY, "{");
  const broken = plan.createPlan({ storage });
  assert.equal(broken.week().every((day) => day.recipe === null), true);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      recipes: [{ title: "عدس‌پلو", ingredients: ["برنج"], steps: ["بپز"] }],
      slots: { sat: "missing" },
    }),
  );
  const dangling = plan.createPlan({ storage });
  assert.equal(dangling.recipes()[0].title, "عدس‌پلو");
  assert.equal(dangling.week()[0].recipe, null);
});

test("assigned recipes are kept when the catalog is trimmed", () => {
  const model = fresh();
  model.assign("sat", dish("ثابت", ["برنج"], ["بپز"], 10));
  const many = [];
  for (let i = 0; i < 30; i += 1) {
    many.push(dish("غذا " + i, ["برنج"], ["بپز"], 10));
  }
  model.remember(many);
  assert.ok(model.recipes().length <= MAX_RECIPES);
  assert.equal(model.week()[0].recipe.title, "ثابت");
  assert.equal(
    model.recipes().some((recipe) => recipe.title === "ثابت"),
    true,
  );
});

test("markdown lists every day and the budget line stays soft", () => {
  const model = fresh();
  model.assign("sat", THREE[0]);
  const emptyNote = plan.budgetLine(0, 1500000);
  assert.equal(emptyNote, null);
  const under = plan.budgetLine(180000, 1500000);
  assert.equal(under.over, false);
  assert.match(under.text, /۱۸۰٬۰۰۰/);
  assert.match(under.text, /۱٬۵۰۰٬۰۰۰/);
  assert.equal(under.text.includes("بیشتر"), false);
  const over = plan.budgetLine(2000000, 1500000);
  assert.equal(over.over, true);
  assert.match(over.text, /بیشتر از بودجه هفته/);
  assert.match(over.text, /چاپ و خروجی همچنان ممکن است/);

  const text = model.markdown(1500000);
  assert.match(text, /^# برنامه ۷ روزه/);
  DAYS.forEach((day) => assert.match(text, new RegExp("\\*\\*" + day.label + ":\\*\\*")));
  assert.match(text, /\*\*شنبه:\*\* عدس‌پلو — حدود ۱۸۰٬۰۰۰ تومان/);
  assert.match(text, /\*\*یکشنبه:\*\* خالی/);
  assert.match(text, /جمع شام‌ها حدود ۱۸۰٬۰۰۰ تومان از بودجه ۱٬۵۰۰٬۰۰۰ تومان/);
  assert.equal(recipes.formatCostToman(180000), "حدود ۱۸۰٬۰۰۰ تومان");
});

test("the week renders seven days and an empty placeholder", () => {
  const doc = fakeDocument();
  const model = fresh();
  model.assign("mon", THREE[1]);
  plan.renderWeek(doc, doc.nodes["week-grid"], model);
  const cards = dayCards(doc);
  assert.equal(cards.length, 7);
  assert.equal(cards[0].children[0].textContent, "شنبه");
  assert.equal(cards[0].queryMeal || cards[0].children.find((child) => child.dataset.testid === "day-meal").textContent, "خالی");
  assert.equal(cards[0].children.find((child) => child.tag === "button").textContent, COPY.pick);
  assert.equal(cards[2].children.find((child) => child.dataset.testid === "day-meal").textContent, "لوبیا پلو");
  assert.equal(cards[2].children.find((child) => child.tag === "button").textContent, COPY.swap);
  assert.equal(cards[6].children[0].textContent, "جمعه");
});

test("برنامه ۷ روزه fills the grid from the recipes on the page", () => {
  const view = mountPlan({ latest: THREE });
  assert.equal(dayCards(view.doc).length, 7);
  dayCards(view.doc).forEach((card) => {
    assert.equal(card.children.find((child) => child.dataset.testid === "day-meal").textContent, "خالی");
  });

  view.doc.nodes["build-plan"].listeners.click();
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.filledWeek);
  const meals = dayCards(view.doc).map(
    (card) => card.children.find((child) => child.dataset.testid === "day-meal").textContent,
  );
  assert.deepEqual(meals, [
    "عدس‌پلو",
    "لوبیا پلو",
    "ماست و خیار",
    "عدس‌پلو",
    "لوبیا پلو",
    "ماست و خیار",
    "عدس‌پلو",
  ]);
  dayCards(view.doc).forEach((card) => {
    assert.equal(card.children.find((child) => child.tag === "button").textContent, COPY.swap);
  });

  view.doc.nodes["build-plan"].listeners.click();
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.weekFull);
});

test("without recipes the plan action leaves every day fillable and empty", () => {
  const view = mountPlan({ latest: [] });
  view.doc.nodes["build-plan"].listeners.click();
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.needRecipes);
  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);
  dayCards(view.doc).forEach((card) => {
    assert.equal(card.children.find((child) => child.dataset.testid === "day-meal").textContent, "خالی");
    assert.equal(card.children.find((child) => child.tag === "button").dataset.testid, "day-pick");
  });
});

test("افزودن به برنامه assigns a card, then جایگزین swaps or clears the day", () => {
  const view = mountPlan({ latest: THREE });
  const add = element("button");
  add.dataset.testid = "add-to-plan";
  add.dataset.recipeIndex = "0";
  click(view.doc, add);

  assert.equal(view.doc.nodes["plan-sheet"].hidden, false);
  assert.equal(view.doc.nodes["plan-sheet"].dataset.mode, "assign");
  assert.equal(view.doc.nodes["plan-sheet-title"].textContent, COPY.addToPlan);
  assert.match(view.doc.nodes["plan-sheet-hint"].textContent, /عدس‌پلو/);
  const days = sheetChoices(view.doc);
  assert.equal(days.length, 7);
  assert.equal(days[0].dataset.choice, "sat");
  assert.equal(days[0].children[1].textContent, "خالی");
  assert.equal(days[3].children[0].textContent, "سه‌شنبه");
  click(view.doc, days[0]);

  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);
  assert.match(view.doc.nodes["plan-status"].textContent, /عدس‌پلو/);
  assert.match(view.doc.nodes["plan-status"].textContent, /شنبه/);
  assert.equal(
    dayCards(view.doc)[0].children.find((child) => child.dataset.testid === "day-meal").textContent,
    "عدس‌پلو",
  );

  click(view.doc, dayCards(view.doc)[0].children.find((child) => child.tag === "button"));
  assert.equal(view.doc.nodes["plan-sheet"].dataset.mode, "swap");
  assert.equal(view.doc.nodes["plan-sheet-title"].textContent, COPY.swap);
  const swaps = sheetChoices(view.doc);
  assert.equal(swaps.length, 4);
  const other = swaps.find((button) => button.children[0].textContent === "لوبیا پلو");
  click(view.doc, other);
  assert.equal(
    dayCards(view.doc)[0].children.find((child) => child.dataset.testid === "day-meal").textContent,
    "لوبیا پلو",
  );
  assert.match(view.doc.nodes["plan-status"].textContent, /جایگزین/);

  click(view.doc, dayCards(view.doc)[0].children.find((child) => child.tag === "button"));
  const clear = sheetChoices(view.doc).find((button) => button.dataset.choice === "clear");
  assert.equal(clear.children[0].textContent, "خالی");
  click(view.doc, clear);
  assert.equal(
    dayCards(view.doc)[0].children.find((child) => child.dataset.testid === "day-meal").textContent,
    "خالی",
  );
});

test("a click on the choice label still selects that day", () => {
  const view = mountPlan({ latest: THREE });
  const add = element("button");
  add.dataset.testid = "add-to-plan";
  add.dataset.recipeIndex = "2";
  click(view.doc, add);
  const label = sheetChoices(view.doc)[4].children[0];
  assert.equal(label.textContent, "چهارشنبه");
  click(view.doc, label);
  assert.equal(view.model.week()[4].recipe.title, "ماست و خیار");
});

test("چاپ / خروجی prints and downloads Persian day assignments", () => {
  const view = mountPlan({ latest: THREE, budget: 100000 });
  view.model.assign("sat", THREE[0]);
  view.doc.nodes["build-plan"].listeners.click();

  view.doc.nodes["plan-export"].listeners.click();
  assert.equal(view.doc.nodes["plan-sheet"].hidden, false);
  assert.equal(view.doc.nodes["plan-sheet-title"].textContent, COPY.export);
  assert.equal(view.doc.nodes["plan-sheet-close"].focused, true);
  const printChoice = sheetChoices(view.doc).find((button) => button.dataset.choice === "print");
  click(view.doc, printChoice);
  assert.deepEqual(view.prints, [1]);
  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);

  view.doc.nodes["plan-export"].listeners.click();
  const downloadChoice = sheetChoices(view.doc).find((button) => button.dataset.choice === "download");
  click(view.doc, downloadChoice);
  assert.equal(view.downloads.length, 1);
  assert.equal(view.downloads[0].filename, COPY.filename);
  assert.match(view.downloads[0].text, /# برنامه ۷ روزه/);
  assert.match(view.downloads[0].text, /\*\*شنبه:\*\* عدس‌پلو/);
  assert.match(view.downloads[0].text, /\*\*جمعه:\*\*/);
  assert.equal(view.downloads[0].text.includes("GAP_CODE"), false);

  assert.equal(view.doc.nodes["plan-budget"].hidden, false);
  assert.match(view.doc.nodes["plan-budget"].textContent, /بیشتر از بودجه هفته/);
  assert.match(view.doc.nodes["plan-budget"].className, /is-over/);
  view.setBudget(5000000);
  view.doc.nodes["week-budget"].listeners.input();
  assert.equal(view.doc.nodes["plan-budget"].className.includes("is-over"), false);
});

test("escape, backdrop, and انصراف close the sheet without changing the week", () => {
  const view = mountPlan({ latest: THREE });
  view.doc.nodes["plan-export"].listeners.click();
  fire(view.doc, "keydown", {
    key: "Escape",
    preventDefault() {
      this.defaulted = true;
    },
  });
  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);

  view.doc.nodes["plan-export"].listeners.click();
  view.doc.nodes["plan-sheet"].listeners.click({ target: view.doc.nodes["plan-sheet"] });
  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);

  view.doc.nodes["plan-export"].listeners.click();
  view.doc.nodes["plan-sheet-cancel"].listeners.click();
  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);
  assert.equal(view.model.week().every((day) => day.recipe === null), true);
});

test("خورده شد marks a dinner, survives reload, and frees the chip count", () => {
  const storage = plan.createMemoryStorage();
  const model = plan.createPlan({ storage });
  model.assign("sat", THREE[0]);
  model.assign("sun", THREE[2]);
  assert.equal(model.setUsed("sat", true).ok, true);
  assert.equal(model.setUsed("fri", true).ok, false);
  assert.equal(model.week()[0].used, true);
  assert.equal(model.week()[1].used, false);
  assert.deepEqual(model.usedTitles(), ["عدس‌پلو"]);
  assert.deepEqual(model.remainingChips(["برنج", "عدس", "پیاز", "ماست"]), ["پیاز", "ماست"]);
  assert.match(model.markdown(null), /\*\*شنبه:\*\* عدس‌پلو — خورده شد/);

  const again = plan.createPlan({ storage });
  assert.equal(again.week()[0].used, true);
  assert.equal(again.week()[0].recipe.title, "عدس‌پلو");
  again.assign("sat", THREE[1]);
  assert.equal(again.week()[0].used, false);
  again.setUsed("sat", true);
  again.clearDay("sat");
  assert.equal(again.week()[0].used, false);
  assert.equal(again.week()[0].recipe, null);

  const measured = plan.createPlan({ storage: plan.createMemoryStorage() });
  measured.assign("mon", dish("کتلت", ["۲ عدد پیاز متوسط", "روغن زیتون"], ["بپز"], 10));
  measured.setUsed("mon", true);
  assert.deepEqual(measured.remainingChips(["پیاز", "روغن", "ماست"]), ["روغن", "ماست"]);
});

test("the eaten toggle stays on the day and swap clears it", () => {
  const view = mountPlan({ latest: THREE });
  view.model.assign("sat", THREE[0]);
  view.doc.nodes["build-plan"].listeners.click();
  const eaten = dayCards(view.doc)[0].children.find((child) => child.dataset.testid === "day-eaten");
  assert.equal(eaten.textContent, COPY.eaten);
  assert.equal(eaten.getAttribute("aria-pressed"), "false");
  click(view.doc, eaten);
  assert.equal(view.doc.nodes["plan-sheet"].hidden, true);
  assert.equal(view.model.week()[0].used, true);
  const marked = dayCards(view.doc)[0];
  assert.match(marked.className, /is-used/);
  assert.match(
    marked.children.find((child) => child.dataset.testid === "day-meal").textContent,
    /خورده شد/,
  );
  assert.equal(
    marked.children.find((child) => child.dataset.testid === "day-eaten").getAttribute("aria-pressed"),
    "true",
  );
  assert.match(view.doc.nodes["plan-status"].textContent, /خورده شد/);
  assert.match(view.doc.nodes["plan-status"].textContent, /تکرار نمی‌کند/);

  click(view.doc, marked.children.find((child) => child.dataset.testid === "day-swap"));
  const other = sheetChoices(view.doc).find((button) => button.children[0].textContent === "لوبیا پلو");
  click(view.doc, other);
  assert.equal(view.model.week()[0].used, false);
  assert.equal(view.model.week()[0].recipe.title, "لوبیا پلو");
});

test("new suggestions stay beside eaten dinners and do not clear them", () => {
  const view = mountPlan({ latest: [] });
  view.model.assign("sat", THREE[0]);
  view.model.setUsed("sat", true);
  fire(view.doc, "ashpaz-recipes", {
    detail: {
      recipes: [
        THREE[1],
        THREE[2],
        dish("کوکو سبزی", ["سبزی", "تخم‌مرغ"], ["سبزی را خرد کن"], 90000),
      ],
      skip: ["عدس‌پلو"],
    },
  });
  assert.equal(view.model.week()[0].recipe.title, "عدس‌پلو");
  assert.equal(view.model.week()[0].used, true);
  assert.equal(
    view.model.recipes().some((recipe) => recipe.title === "کوکو سبزی"),
    true,
  );
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.freshIdeas);

  fire(view.doc, "ashpaz-recipes", {
    detail: { recipes: [dish("آبگوشت", ["لوبیا"], ["بپز"], 1000)], full: true },
  });
  assert.equal(view.model.week()[0].used, true);
  assert.equal(view.model.week()[0].recipe.title, "عدس‌پلو");
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.fullIdeas);
});

test("recipe events are stored for a later plan action", () => {
  const view = mountPlan({ latest: [] });
  fire(view.doc, "ashpaz-recipes", { detail: { recipes: THREE } });
  assert.equal(view.model.recipes().length, 3);
  view.doc.nodes["build-plan"].listeners.click();
  assert.equal(view.model.week()[0].recipe.title, "عدس‌پلو");
});

test("the page, stylesheet, and image wire the plan without an API key", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "pantry.css"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "plan.js"), "utf8");
  const docker = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  assert.match(html, /id="build-plan"/);
  assert.match(html, /id="plan-export"/);
  assert.match(html, /id="plan-share"/);
  assert.match(html, /id="plan-share-url"/);
  assert.match(html, /id="plan-empty"/);
  assert.match(html, /id="week-grid"/);
  assert.match(html, /id="plan-sheet"/);
  assert.match(html, />برنامه ۷ روزه</);
  assert.match(html, /چاپ \/ خروجی/);
  assert.match(html, /کپی لینک/);
  assert.match(html, /برنامه هفته خالی است/);
  assert.ok(html.indexOf("recipes.js") < html.indexOf("plan.js"));
  assert.equal(html.includes("GAP_CODE_API_KEY"), false);
  assert.equal(script.includes("GAP_CODE_API_KEY"), false);
  assert.equal(script.includes("fetch("), false);
  assert.match(script, /hashchange/);
  assert.match(docker, /plan\.js/);

  const printCss = css.slice(css.indexOf("@media print"));
  assert.match(printCss, /#pantry/);
  assert.match(printCss, /#recipes/);
  assert.match(printCss, /\.sheet/);
  assert.match(printCss, /\.topbar/);
  assert.match(printCss, /\.footer/);
  assert.match(printCss, /\.day-action/);
  assert.match(printCss, /\.day-eaten/);
  assert.match(printCss, /#fff/);
  assert.match(printCss, /Vazirmatn/);
  assert.match(printCss, /A4/);
  assert.match(printCss, /direction:\s*rtl/);
  assert.match(printCss, /page-break-inside:\s*avoid/);
  assert.match(printCss, /break-inside:\s*avoid/);
  assert.match(printCss, /content:\s*"روز"/);
  assert.match(printCss, /content:\s*"وعده"/);
  assert.match(printCss, /#plan-empty\[hidden\]/);
  assert.equal(printCss.includes("#week-grid"), false);
});

test("share encode and decode round-trip the week and drop secrets", () => {
  const model = fresh();
  model.assign("sat", THREE[0]);
  model.assign("tue", dish("لوبیا پلو", ["برنج", "۲۰۰ گرم گوشت"], ["لوبیا را بپز"], 160000));
  model.setUsed("sat", true);
  const snapshot = model.snapshot();
  snapshot.local_user_id = "local-user-demo1";
  snapshot.env = { POSTGRES_PASSWORD: "hunter2" };
  snapshot.recipes[0].api_key = "sk-live-secret";
  snapshot.recipes[0].ingredients = snapshot.recipes[0].ingredients.concat(["GAP_CODE_API_KEY=sk-should-not-leak"]);

  const token = plan.encodeShare(snapshot);
  const packed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  assert.equal(packed.v, 1);
  assert.equal(packed.days[0].id, "sat");
  assert.equal(packed.days[0].title, "عدس‌پلو");
  assert.equal(packed.days[0].used, true);
  assert.equal(packed.days[0].cost, 180000);
  assert.deepEqual(packed.days[0].ingredients, ["برنج", "عدس"]);
  assert.equal(JSON.stringify(packed).includes("GAP_CODE"), false);
  assert.equal(JSON.stringify(packed).includes("hunter2"), false);
  assert.equal(JSON.stringify(packed).includes("sk-live"), false);
  assert.equal(JSON.stringify(packed).includes("local_user"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(packed, "local_user_id"), false);

  const decoded = plan.decodeShare(token);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.empty, false);
  const again = fresh();
  const applied = again.applyShare(token);
  assert.equal(applied.ok, true);
  assert.equal(applied.empty, false);
  assert.equal(again.week()[0].recipe.title, "عدس‌پلو");
  assert.equal(again.week()[0].used, true);
  assert.deepEqual(again.week()[0].recipe.steps, ["پیاز را تفت بده", "عدس را بپز"]);
  assert.equal(again.week()[3].recipe.title, "لوبیا پلو");
  assert.equal(again.week()[3].recipe.ingredients[1], "۲۰۰ گرم گوشت");
  assert.equal(again.week()[3].label, "سه‌شنبه");
  assert.equal(again.week()[1].recipe, null);
  const list = shop.buildShoppingList(["برنج"], again.week());
  assert.equal(
    list.categories.some((group) => group.items.some((item) => item.name === "گوشت")),
    true,
  );

  const href = plan.shareHref(
    {
      origin: "http://localhost:8080",
      pathname: "/",
      search: "?local_user_id=local-user-demo1&GAP_CODE_API_KEY=nope",
      hash: "",
    },
    token,
  );
  assert.equal(href, "http://localhost:8080/#p=" + token);
  assert.equal(href.includes("local_user_id"), false);
  assert.equal(href.includes("GAP_CODE"), false);
  assert.equal(plan.shareTokenFromLocation({ hash: "#p=" + token }), token);
});

test("a secret inside the share payload is refused and an empty week still reopens", () => {
  const model = fresh();
  model.assign("fri", THREE[2]);
  const bad = Buffer.from(
    JSON.stringify({
      v: 1,
      days: [{ id: "sat", title: "عدس‌پلو", GAP_CODE_API_KEY: "sk-test" }],
      local_user_id: "local-user-demo1",
    }),
    "utf8",
  ).toString("base64url");
  const refused = model.applyShare(bad);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "secret");
  assert.equal(model.week()[6].recipe.title, "ماست و خیار");
  assert.equal(plan.decodeShare(bad).plan, undefined);

  const emptyToken = plan.encodeShare({ recipes: [], slots: {}, used: {} });
  const storage = plan.createMemoryStorage();
  const emptyModel = plan.createPlan({ storage });
  emptyModel.assign("sat", THREE[0]);
  const opened = emptyModel.applyShare(emptyToken);
  assert.equal(opened.ok, true);
  assert.equal(opened.empty, true);
  assert.equal(emptyModel.week().every((day) => day.recipe === null), true);
  const meta = JSON.parse(storage.getItem(plan.SYNC_META_KEY));
  assert.ok(meta.planRev > meta.planSyncedRev);
  assert.equal(plan.decodeShare("@@@").ok, false);
  assert.equal(plan.decodeShare("a".repeat(24001)).reason, "size");

  const renamed = Buffer.from(
    JSON.stringify({ v: 1, days: [{ id: "tue", title: "عدس‌پلو", label: "Monday" }] }),
    "utf8",
  ).toString("base64url");
  const renamedModel = fresh();
  assert.equal(renamedModel.applyShare(renamed).ok, true);
  assert.equal(renamedModel.week()[3].label, "سه‌شنبه");
  assert.equal(renamedModel.week()[3].recipe.title, "عدس‌پلو");
});

test("poster outline names روز and وعده, including an empty week", () => {
  const model = fresh();
  const emptyPoster = plan.posterOutline(model.week());
  assert.equal(emptyPoster.empty, true);
  assert.equal(emptyPoster.emptyTitle, COPY.emptyPlanTitle);
  assert.equal(emptyPoster.brand, "آشپزخونه");
  assert.equal(emptyPoster.days.length, 7);
  assert.deepEqual(
    emptyPoster.days.map((day) => day.dayLabel),
    ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"],
  );
  emptyPoster.days.forEach((day) => {
    assert.equal(day.dayRole, "روز");
    assert.equal(day.mealRole, "وعده");
    assert.equal(day.mealLabel, "شام");
    assert.equal(day.title, "خالی");
    assert.equal(day.empty, true);
  });

  model.assign("thu", THREE[1]);
  model.setUsed("thu", true);
  const poster = plan.posterOutline(model.week());
  assert.equal(poster.empty, false);
  assert.equal(poster.days[5].dayLabel, "پنجشنبه");
  assert.equal(poster.days[5].title, "لوبیا پلو");
  assert.equal(poster.days[5].eaten, true);
  assert.equal(poster.days[0].title, "خالی");
});

test("کپی لینک copies a hash the page can reopen, and an empty plan says so", () => {
  const copied = [];
  const view = mountPlan({ latest: THREE, budget: null });
  view.doc.nodes["plan-share"] = view.doc.nodes["plan-share"];
  assert.equal(view.doc.nodes["plan-empty"].hidden, false);
  const loc = { origin: "http://localhost:8080", pathname: "/app/", search: "?local_user_id=abc", hash: "" };
  plan.mount(view.doc, view.model, {
    latest() {
      return THREE;
    },
    budget() {
      return null;
    },
    location: loc,
    copy(text) {
      copied.push(text);
    },
    print() {},
    download() {},
  });
  view.doc.nodes["plan-share"].listeners.click();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^http:\/\/localhost:8080\/app\/#p=[A-Za-z0-9_-]+$/);
  assert.equal(copied[0].includes("?"), false);
  assert.equal(view.doc.nodes["plan-status"].textContent, COPY.shareCopied);

  view.doc.nodes["plan-export"].listeners.click();
  assert.equal(view.doc.nodes["plan-share-box"].hidden, false);
  assert.equal(view.doc.nodes["plan-share-url"].value, copied[0]);
  const printChoice = sheetChoices(view.doc).find((button) => button.dataset.choice === "print");
  assert.match(printChoice.children[1].textContent, /روز و وعده/);

  const token = copied[0].split("#p=")[1];
  const other = fresh();
  const incoming = {
    origin: "http://localhost:8080",
    pathname: "/",
    search: "",
    hash: "#p=" + token,
  };
  const doc = fakeDocument();
  plan.mount(doc, other, {
    location: incoming,
    latest() {
      return [];
    },
    budget() {
      return null;
    },
  });
  assert.equal(incoming.hash, "");
  assert.equal(doc.nodes["plan-status"].textContent, COPY.shareEmptyOpened);
  assert.equal(doc.nodes["plan-empty"].hidden, false);
  assert.equal(other.week().every((day) => day.recipe === null), true);

  view.doc.nodes["build-plan"].listeners.click();
  assert.equal(view.doc.nodes["plan-empty"].hidden, true);
  const filled = [];
  view.doc.nodes["plan-share"].listeners.click();
  filled.push(copied[copied.length - 1]);
  const reopened = fresh();
  assert.equal(reopened.applyShare(filled[0].split("#p=")[1]).ok, true);
  assert.equal(reopened.week()[0].recipe.title, "عدس‌پلو");
  assert.equal(reopened.week()[6].recipe.title, "عدس‌پلو");
});

test("a failed copy leaves the share field selected, and a bad link keeps the week", () => {
  const view = mountPlan({});
  view.model.assign("sun", THREE[1]);
  const doc = view.doc;
  plan.mount(doc, view.model, {
    latest() {
      return [];
    },
    budget() {
      return null;
    },
    copy() {
      return false;
    },
  });
  doc.nodes["plan-share-url"].select = function () {
    doc.nodes["plan-share-url"].selected = true;
  };
  doc.nodes["plan-share"].listeners.click();
  assert.equal(doc.nodes["plan-status"].textContent, COPY.shareReady);
  assert.equal(doc.nodes["plan-sheet"].hidden, false);
  assert.equal(doc.nodes["plan-share-box"].hidden, false);
  assert.equal(doc.nodes["plan-share-url"].selected, true);
  assert.match(doc.nodes["plan-share-url"].value, /#p=/);
  click(doc, doc.nodes["plan-share-copy"]);
  assert.equal(doc.nodes["plan-sheet"].hidden, false);
  assert.equal(view.model.week()[1].recipe.title, "لوبیا پلو");

  const kept = fresh();
  kept.assign("mon", THREE[0]);
  const badDoc = fakeDocument();
  plan.mount(badDoc, kept, {
    location: { origin: "http://localhost:8080", pathname: "/", hash: "#p=not-a-plan", search: "" },
    latest() {
      return [];
    },
    budget() {
      return null;
    },
  });
  assert.equal(badDoc.nodes["plan-status"].textContent, COPY.shareBad);
  assert.equal(kept.week()[2].recipe.title, "عدس‌پلو");
  assert.equal(kept.week()[0].recipe, null);
});
