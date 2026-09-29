const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("./household.js");
require("./pantry.js");
const pantry = require("./pantry.js");
const plan = require("./plan.js");
const shop = require("./shop.js");

const { COPY } = shop;

function dish(title, ingredients) {
  return { title, ingredients: ingredients || [], steps: ["بپز"], cost_toman: 0 };
}

function week(days) {
  return days.map((day) => ({
    id: day.id,
    label: day.label,
    recipe: day.recipe || null,
  }));
}

function names(result) {
  return result.categories.flatMap((cat) => cat.items.map((item) => item.name));
}

function item(result, name) {
  for (const cat of result.categories) {
    const found = cat.items.find((entry) => entry.name === name);
    if (found) return { ...found, category: cat.id, label: cat.label };
  }
  return null;
}

test("missing dinner ingredients are listed and pantry chips are not", () => {
  const result = shop.buildShoppingList(
    ["برنج", "پیاز", "عدس"],
    week([
      { id: "sat", label: "شنبه", recipe: dish("عدس پلو", ["برنج", "۲۰۰ گرم گوشت", "پیاز"]) },
      { id: "sun", label: "یکشنبه", recipe: null },
    ]),
  );
  assert.equal(result.state, "list");
  assert.deepEqual(names(result), ["گوشت"]);
  const meat = item(result, "گوشت");
  assert.equal(meat.category, "protein");
  assert.equal(meat.label, "پروتئین");
  assert.equal(meat.quantityLabel, "۲۰۰ گرم");
  assert.match(meat.meta, /عدس پلو/);
  assert.match(meat.meta, /شنبه/);
});

test("Arabic, Persian, and half-space spellings count as the same pantry item", () => {
  const covered = shop.buildShoppingList(
    ["كرفس", "سیب\u200cزمینی", "گوجه‌فرنگی"],
    week([
      {
        id: "sat",
        label: "شنبه",
        recipe: dish("خوراک", ["کرفس", "سیب زمینی", "گوجه فرنگی"]),
      },
    ]),
  );
  assert.equal(covered.state, "covered");
  assert.equal(covered.itemCount, 0);

  const sized = shop.buildShoppingList(
    ["پیاز"],
    week([{ id: "sat", label: "شنبه", recipe: dish("خوراک", ["۲ عدد پیاز متوسط"]) }]),
  );
  assert.equal(sized.itemCount, 0);

  const olive = shop.buildShoppingList(
    ["روغن"],
    week([{ id: "sat", label: "شنبه", recipe: dish("سالاد", ["روغن زیتون", "روغن"]) }]),
  );
  assert.deepEqual(names(olive), ["روغن زیتون"]);
  assert.equal(item(olive, "روغن زیتون").category, "spice");
});

test("quantities add across dinners and keep a different unit beside them", () => {
  const result = shop.buildShoppingList(
    [],
    week([
      { id: "sat", label: "شنبه", recipe: dish("عدس پلو", ["۲ عدد پیاز", "نصف پیمانه عدس"]) },
      { id: "sun", label: "یکشنبه", recipe: dish("عدس پلو", ["۲ عدد پیاز", "نصف پیمانه عدس"]) },
      { id: "mon", label: "دوشنبه", recipe: dish("خورشت", ["۱ کیلو گوشت"]) },
      { id: "tue", label: "سه‌شنبه", recipe: dish("کباب", ["۲۰۰ گرم گوشت"]) },
    ]),
  );
  assert.equal(result.state, "list-pantry-empty");
  assert.equal(item(result, "پیاز").quantityLabel, "۴ عدد");
  assert.equal(item(result, "عدس").quantityLabel, "۱ پیمانه");
  assert.match(item(result, "گوشت").quantityLabel, /۲۰۰ گرم/);
  assert.match(item(result, "گوشت").quantityLabel, /۱ کیلو/);
  assert.match(item(result, "پیاز").meta, /شنبه/);
  assert.match(item(result, "پیاز").meta, /یکشنبه/);
});

test("a repeated item without a quantity says how many dinners need it", () => {
  const result = shop.buildShoppingList(
    ["برنج"],
    week([
      { id: "sat", label: "شنبه", recipe: dish("عدس پلو", ["نمک"]) },
      { id: "mon", label: "دوشنبه", recipe: dish("لوبیا پلو", ["نمک"]) },
      { id: "fri", label: "جمعه", recipe: dish("باقالی پلو", ["نمک"]) },
    ]),
  );
  assert.equal(item(result, "نمک").quantityLabel, "برای ۳ وعده");
  assert.equal(item(result, "نمک").category, "spice");
});

test("word quantities and combined lines stay attached to the food", () => {
  const half = shop.parseIngredient("یک و نیم پیمانه برنج");
  assert.equal(half.name, "برنج");
  assert.equal(half.qty, 1.5);
  assert.equal(half.unit, "پیمانه");
  const parts = shop.expandLine("پیاز، سیر و ۲۰۰ گرم گوشت");
  assert.deepEqual(
    parts.map((part) => part.name),
    ["پیاز", "سیر", "گوشت"],
  );
  assert.equal(parts[2].qty, 200);
  assert.equal(parts[2].unit, "گرم");
});

test("rows are grouped from سبزی to سایر", () => {
  const result = shop.buildShoppingList(
    [],
    week([
      {
        id: "sat",
        label: "شنبه",
        recipe: dish("سفره", ["پیاز", "سیب", "گوشت", "ماست", "برنج", "نان", "روغن", "گردو", "مایونز"]),
      },
    ]),
  );
  assert.deepEqual(
    result.categories.map((cat) => cat.id),
    ["produce", "fruit", "protein", "dairy", "grains", "bread", "spice", "nuts", "other"],
  );
  const potato = shop.buildShoppingList(
    [],
    week([{ id: "sat", label: "شنبه", recipe: dish("خوراک", ["سیب‌زمینی", "فلفل دلمه", "فلفل سیاه"]) }]),
  );
  assert.equal(item(potato, "سیب زمینی").category, "produce");
  assert.equal(item(potato, "فلفل دلمه").category, "produce");
  assert.equal(item(potato, "فلفل سیاه").category, "spice");
});

test("empty plan, empty pantry, covered pantry, and missing ingredients have Persian states", () => {
  const emptyWeek = week([{ id: "sat", label: "شنبه", recipe: null }]);
  const both = shop.buildShoppingList([], emptyWeek);
  assert.equal(both.state, "empty-both");
  assert.match(shop.markdownDocument(both), /برنامه و آشپزخانه خالی است/);

  const planOnly = shop.buildShoppingList(["برنج"], emptyWeek);
  assert.equal(planOnly.state, "empty-plan");
  assert.match(shop.markdownDocument(planOnly), /برنامه هفته خالی است/);
  assert.equal(shop.markdownDocument(planOnly).includes("برنج"), false);

  const bare = shop.buildShoppingList(
    [],
    week([{ id: "fri", label: "جمعه", recipe: dish("کباب", []) }]),
  );
  assert.equal(bare.state, "missing");
  assert.equal(bare.skipped[0].title, "کباب");
  assert.equal(bare.skipped[0].day, "جمعه");
  assert.match(shop.markdownDocument(bare), /مواد این وعده‌ها در برنامه نیست/);
  assert.match(shop.markdownDocument(bare), /کباب \(جمعه\)/);

  const covered = shop.buildShoppingList(
    ["برنج"],
    week([{ id: "sat", label: "شنبه", recipe: dish("پلو", ["برنج"]) }]),
  );
  assert.equal(covered.state, "covered");
  assert.match(shop.markdownDocument(covered), /چیزی برای خرید نمانده/);
});

test("markdown is a Persian shopping list and does not carry a secret", () => {
  const result = shop.buildShoppingList(
    [],
    week([{ id: "sat", label: "شنبه", recipe: dish("عدس پلو", ["۲۰۰ گرم گوشت", "پیاز"]) }]),
  );
  const text = shop.markdownDocument(result);
  assert.match(text, /^# مواد خرید/);
  assert.match(text, /## پروتئین/);
  assert.match(text, /## سبزی و صیفی/);
  assert.match(text, /\*\*گوشت\*\* — ۲۰۰ گرم/);
  assert.match(text, /عدس پلو \(شنبه\)/);
  assert.match(text, /آشپزخانه خالی است/);
  assert.equal(text.includes("GAP_CODE"), false);
  assert.equal(text.includes("sk-"), false);
});

function element(tag) {
  const node = {
    tag,
    hidden: false,
    disabled: false,
    value: "",
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
      const flat = [];
      kids.forEach((kid) => {
        if (!kid) return;
        if (kid.tag === "fragment") flat.push(...kid.children);
        else flat.push(kid);
      });
      node.children.forEach((kid) => {
        kid.parentNode = null;
      });
      node.children = [];
      node.append(...flat);
    },
    setAttribute(name, value) {
      node.attrs[name] = value;
      if (name === "tabindex") node.tabIndex = value;
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
    select() {},
    scrollIntoView() {
      node.scrolled = true;
    },
  };
  node.classList = {
    add(name) {
      node.classList.toggle(name, true);
    },
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
  [
    "shop",
    "shop-list",
    "shop-empty",
    "shop-empty-title",
    "shop-empty-help",
    "shop-pantry-note",
    "shop-skipped",
    "shop-skipped-title",
    "shop-skipped-list",
    "shop-count",
    "shop-status",
    "shop-open",
    "shop-export",
    "shop-sheet",
    "shop-sheet-title",
    "shop-sheet-hint",
    "shop-sheet-list",
    "shop-sheet-close",
    "shop-sheet-cancel",
    "shop-title",
    "week-grid",
    "plan-sheet",
    "plan-sheet-title",
    "plan-sheet-list",
    "build-plan",
    "plan",
    "add-form",
    "ingredient",
    "chips",
    "empty",
    "status",
    "week-budget",
    "seed",
    "clear",
  ].forEach((id) => register(id, "div"));
  nodes["shop-list"].hidden = true;
  nodes["shop-pantry-note"].hidden = true;
  nodes["shop-skipped"].hidden = true;
  nodes["shop-count"].hidden = true;
  nodes["shop-sheet"].hidden = true;
  nodes["plan-sheet"].hidden = true;
  const doc = {
    nodes,
    listeners: {},
    body: element("body"),
    getElementById(id) {
      return nodes[id] || null;
    },
    createElement: element,
    createDocumentFragment() {
      return element("fragment");
    },
    addEventListener(type, fn) {
      if (!doc.listeners[type]) doc.listeners[type] = [];
      doc.listeners[type].push(fn);
    },
    dispatchEvent(event) {
      (doc.listeners[event.type] || []).forEach((fn) => fn(event));
      return true;
    },
  };
  return doc;
}

function fire(doc, type, event) {
  (doc.listeners[type] || []).forEach((fn) => fn(event));
}

function byTestId(node, testid) {
  const found = [];
  function walk(current) {
    (current.children || []).forEach((child) => {
      if (child.dataset && child.dataset.testid === testid) found.push(child);
      walk(child);
    });
  }
  walk(node);
  return found;
}

function mountShop(options) {
  const doc = options.doc || fakeDocument();
  const downloads = [];
  const prints = [];
  let pantryItems = typeof options.pantry === "function" ? null : options.pantry || [];
  let days = typeof options.week === "function" ? null : options.week || [];
  const readPantry = typeof options.pantry === "function" ? options.pantry : () => pantryItems;
  const readWeek = typeof options.week === "function" ? options.week : () => days;
  shop.mount(doc, {
    pantry() {
      return readPantry();
    },
    week() {
      return readWeek();
    },
    download(text, filename) {
      downloads.push({ text, filename });
    },
    print() {
      prints.push(doc.body.dataset.print);
    },
  });
  return {
    doc,
    downloads,
    prints,
    setPantry(items) {
      pantryItems = items;
    },
    setWeek(next) {
      days = next;
    },
  };
}

test("مواد خرید renders the diff, then print and markdown stay on that list", () => {
  const view = mountShop({
    pantry: ["برنج", "پیاز"],
    week: week([
      { id: "sat", label: "شنبه", recipe: dish("عدس پلو", ["برنج", "۲ عدد پیاز", "۲۰۰ گرم گوشت"]) },
    ]),
  });
  assert.equal(view.doc.nodes.shop.dataset.state, "list");
  assert.equal(view.doc.nodes["shop-empty"].hidden, true);
  assert.equal(view.doc.nodes["shop-list"].hidden, false);
  assert.equal(view.doc.nodes["shop-count"].textContent, "۱");
  assert.match(view.doc.nodes["shop-status"].textContent, /۱ ماده برای خرید/);
  const shown = byTestId(view.doc.nodes["shop-list"], "shop-item-name").map((node) => node.textContent);
  assert.deepEqual(shown, ["گوشت"]);

  view.doc.nodes["shop-open"].listeners.click();
  assert.equal(view.doc.nodes.shop.scrolled, true);
  assert.equal(view.doc.nodes["shop-title"].focused, true);

  view.doc.nodes["shop-export"].listeners.click();
  assert.equal(view.doc.nodes["shop-sheet"].hidden, false);
  assert.equal(view.doc.nodes["shop-sheet-title"].textContent, COPY.export);
  assert.match(view.doc.nodes["shop-sheet-hint"].textContent, /مواد خرید/);
  const choices = view.doc.nodes["shop-sheet-list"].children.map((li) => li.children[0]);
  const printChoice = choices.find((button) => button.dataset.choice === "print");
  fire(view.doc, "click", { target: printChoice.children[0] });
  assert.deepEqual(view.prints, ["shop"]);
  assert.equal(view.doc.nodes["shop-sheet"].hidden, true);

  view.doc.nodes["shop-export"].listeners.click();
  const downloadChoice = view.doc.nodes["shop-sheet-list"].children
    .map((li) => li.children[0])
    .find((button) => button.dataset.choice === "download");
  fire(view.doc, "click", { target: downloadChoice });
  assert.equal(view.downloads.length, 1);
  assert.equal(view.downloads[0].filename, "مواد-خرید.md");
  assert.match(view.downloads[0].text, /# مواد خرید/);
  assert.match(view.downloads[0].text, /گوشت/);
  assert.equal(view.downloads[0].text.includes("پیاز"), false);
  assert.equal(view.downloads[0].text.includes("GAP_CODE"), false);
});

test("empty pantry and empty plan copy is shown in the section", () => {
  const emptyPlan = mountShop({
    pantry: ["برنج"],
    week: week([{ id: "sat", label: "شنبه", recipe: null }]),
  });
  assert.equal(emptyPlan.doc.nodes.shop.dataset.state, "empty-plan");
  assert.equal(emptyPlan.doc.nodes["shop-empty"].hidden, false);
  assert.equal(emptyPlan.doc.nodes["shop-empty-title"].textContent, COPY.emptyPlanTitle);
  assert.match(emptyPlan.doc.nodes["shop-empty-help"].textContent, /شنبه تا جمعه/);
  assert.equal(emptyPlan.doc.nodes["shop-list"].hidden, true);

  const both = mountShop({ pantry: [], week: [] });
  assert.equal(both.doc.nodes.shop.dataset.state, "empty-both");
  assert.equal(both.doc.nodes["shop-empty-title"].textContent, COPY.emptyBothTitle);

  const pantryEmpty = mountShop({
    pantry: [],
    week: week([{ id: "sat", label: "شنبه", recipe: dish("پلو", ["برنج"]) }]),
  });
  assert.equal(pantryEmpty.doc.nodes.shop.dataset.state, "list-pantry-empty");
  assert.equal(pantryEmpty.doc.nodes["shop-pantry-note"].hidden, false);
  assert.equal(pantryEmpty.doc.nodes["shop-empty"].hidden, true);
  assert.equal(byTestId(pantryEmpty.doc.nodes["shop-list"], "shop-item-name")[0].textContent, "برنج");
});

test("escape, backdrop, and انصراف close the shopping sheet", () => {
  const view = mountShop({ pantry: [], week: [] });
  view.doc.nodes["shop-export"].listeners.click();
  fire(view.doc, "keydown", {
    key: "Escape",
    preventDefault() {
      this.defaulted = true;
    },
  });
  assert.equal(view.doc.nodes["shop-sheet"].hidden, true);

  view.doc.nodes["shop-export"].listeners.click();
  view.doc.nodes["shop-sheet"].listeners.click({ target: view.doc.nodes["shop-sheet"] });
  assert.equal(view.doc.nodes["shop-sheet"].hidden, true);

  view.doc.nodes["shop-export"].listeners.click();
  view.doc.nodes["shop-sheet-cancel"].listeners.click();
  assert.equal(view.doc.nodes["shop-sheet"].hidden, true);
});

test("pantry edits and plan fills refresh the list without a model call", () => {
  const doc = fakeDocument();
  const store = pantry.createPantry({ storage: pantry.createMemoryStorage() });
  const model = plan.createPlan({ storage: plan.createMemoryStorage() });
  model.remember([dish("عدس پلو", ["برنج", "۲۰۰ گرم گوشت"])]);
  pantry.mount(doc, store);
  const view = mountShop({
    doc,
    pantry: () => store.items(),
    week: () => model.week(),
  });
  plan.mount(doc, model);
  assert.equal(view.doc.nodes.shop.dataset.state, "empty-both");

  doc.nodes["build-plan"].listeners.click();
  assert.equal(model.week()[0].meals[0].recipe.title, "عدس پلو");
  assert.equal(model.week()[0].meals.length, 3);
  assert.deepEqual(
    byTestId(doc.nodes["shop-list"], "shop-item-name").map((node) => node.textContent),
    ["گوشت", "برنج"],
  );

  doc.nodes.ingredient.value = "برنج";
  doc.nodes["add-form"].listeners.submit({ preventDefault() {} });
  assert.deepEqual(store.items(), ["برنج"]);
  assert.deepEqual(
    byTestId(doc.nodes["shop-list"], "shop-item-name").map((node) => node.textContent),
    ["گوشت"],
  );
});

test("breakfast lunch and dinner all contribute ingredients", () => {
  const result = shop.buildShoppingList(
    ["برنج"],
    [
      {
        id: "sat",
        label: "شنبه",
        meals: [
          { id: "breakfast", label: "صبحانه", recipe: dish("املت", ["۲ عدد تخم‌مرغ"]) },
          { id: "lunch", label: "ناهار", recipe: dish("کتلت", ["۲۰۰ گرم گوشت"]) },
          { id: "dinner", label: "شام", recipe: dish("پلو", ["برنج", "پیاز"]) },
        ],
      },
    ],
  );
  assert.equal(result.planEmpty, false);
  assert.deepEqual(names(result), ["پیاز", "تخم مرغ", "گوشت"]);
  assert.equal(item(result, "گوشت").quantityLabel, "۲۰۰ گرم");
  assert.match(item(result, "گوشت").meta, /ناهار/);
  assert.match(item(result, "پیاز").meta, /شام/);
  assert.equal(names(result).includes("برنج"), false);
});

test("the documented plan snippet keeps گوشت and drops pantry staples", () => {
  const storage = plan.createMemoryStorage();
  storage.setItem(
    plan.STORAGE_KEY,
    JSON.stringify({
      recipes: [
        {
          title: "عدس پلو",
          ingredients: ["برنج", "عدس", "پیاز", "۲۰۰ گرم گوشت"],
          steps: ["بپز"],
          cost_toman: 0,
        },
      ],
      slots: { sat: "r:عدسپلو", sun: null, mon: null, tue: null, wed: null, thu: null, fri: null },
    }),
  );
  const model = plan.createPlan({ storage });
  assert.equal(model.week()[0].meals.find((meal) => meal.id === "dinner").recipe.title, "عدس پلو");
  assert.equal(model.week()[0].meals.find((meal) => meal.id === "breakfast").recipe, null);
  const result = shop.buildShoppingList(["برنج", "عدس", "پیاز"], model.week());
  assert.deepEqual(names(result), ["گوشت"]);
  assert.equal(item(result, "گوشت").quantityLabel, "۲۰۰ گرم");
  assert.equal(item(result, "گوشت").label, "پروتئین");
});

test("the page, stylesheet, and image wire مواد خرید without an API key", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "pantry.css"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "shop.js"), "utf8");
  const docker = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="fa"/);
  assert.match(html, /id="shop-open"/);
  assert.match(html, />مواد خرید</);
  assert.match(html, /id="shop"/);
  assert.match(html, /id="shop-export"/);
  assert.match(html, /برنامه هفته خالی است/);
  assert.match(html, /آشپزخانه خالی است/);
  assert.ok(html.indexOf("plan.js") < html.indexOf("shop.js"));
  assert.equal(html.includes("GAP_CODE_API_KEY"), false);
  assert.equal(script.includes("GAP_CODE_API_KEY"), false);
  assert.equal(script.includes("fetch("), false);
  assert.equal(script.includes("/api/"), false);
  assert.match(script, /no fetch/);
  assert.match(docker, /shop\.js/);

  const printCss = css.slice(css.indexOf("@media print"));
  assert.match(printCss, /#shop/);
  assert.match(printCss, /data-print="shop"/);
  assert.match(printCss, /#plan/);
  assert.match(printCss, /Vazirmatn/);
  assert.match(printCss, /#fff/);
  assert.equal(printCss.includes("#week-grid"), false);
  assert.match(html, /id="shop-scale"/);
});

test("shopping quantities scale with household size and each recipe's servings", () => {
  const doubled = shop.buildShoppingList(
    [],
    week([
      {
        id: "sat",
        label: "شنبه",
        recipe: {
          title: "خوراک",
          ingredients: ["۲۰۰ گرم گوشت", "نصف پیمانه ماست"],
          steps: ["بپز"],
          servings: 4,
        },
      },
    ]),
    8,
  );
  assert.equal(item(doubled, "گوشت").quantityLabel, "۴۰۰ گرم");
  assert.equal(item(doubled, "ماست").quantityLabel, "۱ پیمانه");

  const halved = shop.buildShoppingList(
    [],
    week([
      {
        id: "sat",
        label: "شنبه",
        recipe: { title: "خوراک", ingredients: ["۲ عدد پیاز"], steps: ["بپز"], servings: 4 },
      },
    ]),
    2,
  );
  assert.equal(item(halved, "پیاز").quantityLabel, "۱ عدد");

  const summed = shop.buildShoppingList(
    [],
    week([
      {
        id: "sat",
        label: "شنبه",
        recipe: { title: "الف", ingredients: ["۲۰۰ گرم گوشت"], steps: ["بپز"], servings: 4 },
      },
      {
        id: "sun",
        label: "یکشنبه",
        recipe: { title: "ب", ingredients: ["۲۰۰ گرم گوشت"], steps: ["بپز"], servings: 4 },
      },
    ]),
    8,
  );
  assert.equal(item(summed, "گوشت").quantityLabel, "۸۰۰ گرم");

  const covered = shop.buildShoppingList(
    ["پیاز"],
    week([
      {
        id: "sat",
        label: "شنبه",
        recipe: { title: "خوراک", ingredients: ["۲ عدد پیاز متوسط"], steps: ["بپز"], servings: 4 },
      },
    ]),
    8,
  );
  assert.equal(covered.itemCount, 0);
});
