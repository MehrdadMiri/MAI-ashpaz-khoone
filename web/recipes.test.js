const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("./household.js");
const recipes = require("./recipes.js");

const { COPY, ERROR_COPY, ENDPOINT } = recipes;

function pantry(items, budget) {
  return {
    items() {
      return items.slice();
    },
    budget() {
      return budget;
    },
  };
}

function dish(title, ingredients, steps, cost) {
  const recipe = { title, ingredients, steps };
  if (cost !== undefined) recipe.cost_toman = cost;
  return recipe;
}

const THREE = [
  dish("عدس‌پلو", ["برنج", "عدس"], ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"], 180000),
  dish("لوبیا پلو", ["برنج", "لوبیا"], ["لوبیا را بپز", "برنج را اضافه کن", "دم کن"], 160000),
  dish("ماست و خیار", ["ماست", "خیار"], ["ماست را هم بزن", "خیار را اضافه کن", "سرد سرو کن"], 70000),
];

test("loading and plan-button copy is the product text", () => {
  assert.equal(COPY.suggest, "پیشنهاد دستور");
  assert.equal(COPY.suggestMore, "پیشنهاد دستورهای بیشتر");
  assert.equal(COPY.moreNote, "دستورهای تازه به همین فهرست اضافه شد.");
  assert.equal(COPY.loading, "در حال پختن ایده‌ها…");
  assert.equal(COPY.retry, "تلاش دوباره");
  assert.equal(COPY.addToPlan, "افزودن به برنامه");
  assert.equal(COPY.nutritionPending, "در حال برآورد کالری…");
  assert.equal(COPY.nutritionDisclaimer, "این عددها برآورد هوش مصنوعی هستند، نه مقدار دقیق غذا.");
  assert.equal(ENDPOINT, "/api/recipes/generate");
  assert.equal(recipes.NUTRITION_ENDPOINT, "/api/recipes/nutrition");
});

test("payload includes pantry chips and week budget", () => {
  assert.deepEqual(recipes.buildGeneratePayload(pantry(["برنج", "پیاز"], "1500000")), {
    ingredients: ["برنج", "پیاز"],
    budget: 1500000,
    household: 4,
    count: 3,
  });
  assert.deepEqual(recipes.buildGeneratePayload(pantry(["روغن"], "")).budget, null);
  assert.equal(recipes.buildGeneratePayload(pantry(["روغن"], "0")).budget, 0);
});

test("errors are friendly Persian and never echo the server message", () => {
  const secret = "unit-test-key";
  const message = recipes.messageForFailure(502, {
    error: "unauthorized",
    message: `rejected ${secret}`,
  });
  assert.equal(message, ERROR_COPY.unauthorized);
  assert.equal(message.includes(secret), false);
  assert.equal(recipes.messageForFailure(0, null), ERROR_COPY.default);
  assert.equal(
    recipes.messageForFailure(400, { error: "empty_ingredients" }),
    "برای پیشنهاد دستور، حداقل یک ماده به آشپزخانه اضافه کنید.",
  );
  assert.equal(recipes.messageForFailure(503, { error: "not_configured", message: secret }).includes(secret), false);
  assert.equal(recipes.hintForFailure({ error: "empty_ingredients", message: secret }), "");
  assert.equal(recipes.hintForFailure({ error: "invalid_budget" }), "");
  const hint = recipes.hintForFailure({
    error: "not_configured",
    message: `Bearer ${secret}\nTraceback (most recent call last)`,
  });
  assert.equal(hint, recipes.SERVICE_HINT);
  assert.match(hint, /GAP_CODE_API_KEY/);
  assert.match(hint, /docker compose/);
  assert.equal(hint.includes(secret), false);
  assert.equal(hint.includes("Traceback"), false);
  const upstream = recipes.messageForFailure(502, {
    error: "upstream_error",
    message: `Traceback (most recent call last)\n${secret}`,
  });
  assert.equal(upstream, ERROR_COPY.upstream_error);
  assert.equal(upstream.includes(secret), false);
  assert.equal(recipes.sanitizeDisplay(`Bearer ${secret}`).includes(secret), false);
});

test("cost badge uses Persian digits", () => {
  assert.equal(recipes.formatCostToman(12500), "حدود ۱۲٬۵۰۰ تومان");
  assert.equal(recipes.formatCostToman(180000), "حدود ۱۸۰٬۰۰۰ تومان");
  assert.equal(recipes.formatCostToman(null), "");
  assert.equal(recipes.formatKcal(450), "حدود ۴۵۰ کیلوکالری در هر وعده");
  assert.equal(recipes.formatKcal(1200), "حدود ۱٬۲۰۰ کیلوکالری در هر وعده");
  assert.equal(recipes.formatKcal(null), "");
  assert.equal(recipes.formatKcal(-1), "");
  assert.equal(
    recipes.formatMacros({ protein_g: 18, carbs_g: 62, fat_g: 14 }),
    "پروتئین ۱۸ گرم، کربوهیدرات ۶۲ گرم، چربی ۱۴ گرم",
  );
  assert.equal(recipes.formatMacros({ kcal: 90 }), "");
  assert.equal(recipes.readEstimate({ kcal: 450, note: "skip", protein_g: 18 }).note, undefined);
});

test("cards need three complete recipes", () => {
  assert.equal(recipes.selectRecipes(THREE.slice(0, 2)), null);
  assert.equal(recipes.selectRecipes([{ title: "عدس", ingredients: [], steps: ["یک"] }]), null);
  const selected = recipes.selectRecipes(THREE);
  assert.equal(selected.length, 3);
  assert.equal(selected[0].title, "عدس‌پلو");
  assert.equal(selected[0].cost_toman, 180000);
});

test("submit gate blocks a second start until the first finishes", () => {
  const gate = recipes.createSubmitGate();
  assert.equal(gate.begin(), true);
  assert.equal(gate.isBusy(), true);
  assert.equal(gate.begin(), false);
  gate.end();
  assert.equal(gate.begin(), true);
});

test("pantry page wires the suggest button and recipe script", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.match(html, /id="suggest"/);
  assert.match(html, /data-testid="suggest-button"/);
  assert.match(html, /id="regenerate-full"/);
  assert.match(html, /data-testid="regenerate-full"/);
  assert.match(html, />پیشنهاد دستور</);
  assert.match(html, />بازتولید کامل</);
  assert.match(html, /id="recipe-retry"/);
  assert.match(html, />تلاش دوباره</);
  assert.match(html, /recipes\.js/);
  assert.match(html, /id="recipe-empty"/);
  assert.match(html, /بودجه هفته و تعداد نفرات را تنظیم کنید و «پیشنهاد دستور» را بزنید/);
  assert.match(html, /id="recipe-skeleton"/);
  assert.match(html, /id="recipe-error-hint"/);
  assert.match(html, /id="diet-filters"/);
  assert.match(html, /id="diet-vegetarian"/);
  assert.match(html, /id="diet-no-onion"/);
  assert.match(html, /id="diet-diabetic"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, />\s*گیاهی\s*</);
  assert.match(html, />\s*بدون پیاز\s*</);
  assert.match(html, />\s*مناسب دیابت\s*</);
  assert.match(html, /محدودیت غذایی/);
  assert.equal(html.includes("GAP_CODE_API_KEY"), false);
  const script = fs.readFileSync(path.join(__dirname, "recipes.js"), "utf8");
  assert.match(script, /GAP_CODE_API_KEY/);
  assert.equal(script.includes(secretKey()), false);
});

function secretKey() {
  return ["unit", "test", "key"].join("-");
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
    append(...kids) {
      node.children.push(...kids);
    },
    replaceChildren(...kids) {
      node.children = kids;
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
  };
  node.classList = {
    toggle(name, on) {
      const parts = new Set(node.className.split(/\s+/).filter(Boolean));
      if (on) parts.add(name);
      else parts.delete(name);
      node.className = [...parts].join(" ");
    },
  };
  return node;
}

function fakeDocument() {
  const nodes = {};
  function register(id, tag) {
    const node = element(tag);
    node.id = id;
    nodes[id] = node;
    return node;
  }
  const doc = { events: [] };
  register("suggest", "button");
  register("regenerate-full", "button");
  register("recipe-retry", "button");
  register("recipe-status", "p");
  register("recipe-error", "div");
  register("recipe-error-text", "p");
  register("recipe-error-hint", "p");
  register("recipe-empty", "div");
  register("recipe-skeleton", "div");
  register("recipe-grid", "div");
  register("recipes", "section");
  nodes["recipe-error"].hidden = true;
  nodes["recipe-error-hint"].hidden = true;
  nodes["recipe-skeleton"].hidden = true;
  nodes["recipe-grid"].hidden = true;
  return {
    nodes,
    events: doc.events,
    getElementById(id) {
      return nodes[id] || null;
    },
    createElement: element,
    createDocumentFragment() {
      return {
        children: [],
        append(...kids) {
          this.children.push(...kids);
        },
      };
    },
    dispatchEvent(event) {
      doc.events.push(event);
    },
  };
}

function cardsOf(grid) {
  const fragment = grid.children[0];
  return fragment ? fragment.children : [];
}

function flush() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text() {
      return Promise.resolve(JSON.stringify(body));
    },
  };
}

test("suggest renders three Persian cards and blocks a second submit", async () => {
  const doc = fakeDocument();
  const calls = [];
  let resolveFetch = null;
  function fetchImpl(url, options) {
    calls.push({ url, options });
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  }
  recipes.mount(doc, pantry(["برنج", "عدس"], "250000"), fetchImpl);

  doc.nodes.suggest.listeners.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(doc.nodes.suggest.textContent, COPY.suggest);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ingredients: ["برنج", "عدس"],
    budget: 250000,
    household: 4,
    count: 3,
  });
  assert.equal(doc.nodes.suggest.disabled, true);
  assert.equal(doc.nodes["recipe-retry"].disabled, true);
  assert.equal(doc.nodes["recipe-status"].textContent, COPY.loading);
  assert.equal(doc.nodes["recipe-skeleton"].hidden, false);
  assert.equal(doc.nodes["recipe-empty"].hidden, true);
  assert.equal(doc.nodes.recipes.className.includes("is-busy"), true);

  doc.nodes.suggest.listeners.click();
  assert.equal(calls.length, 1);

  resolveFetch(jsonResponse(200, { ok: true, recipes: THREE }));
  await flush();
  await flush();

  assert.equal(doc.nodes.suggest.disabled, false);
  assert.equal(doc.nodes.suggest.textContent, COPY.suggestMore);
  assert.equal(doc.nodes["recipe-grid"].hidden, false);
  assert.equal(doc.nodes["recipe-error"].hidden, true);
  assert.equal(doc.nodes["recipe-empty"].hidden, true);
  assert.equal(doc.nodes["recipe-skeleton"].hidden, true);
  assert.equal(doc.nodes["recipe-status"].textContent, "");
  const cards = cardsOf(doc.nodes["recipe-grid"]);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].children[0].children[0].textContent, "عدس‌پلو");
  assert.equal(cards[0].children[0].children[1].textContent, "حدود ۱۸۰٬۰۰۰ تومان");
  assert.equal(cards[0].children[1].dataset.testid, "recipe-nutrition");
  assert.equal(cards[0].children[1].hidden, false);
  assert.equal(cards[0].children[1].children[0].textContent, COPY.nutritionPending);
  assert.equal(cards[0].children[1].children[3].hidden, true);
  assert.equal(cards[0].children[3].children[0].textContent, "برنج");
  assert.equal(cards[0].children[5].children.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, recipes.NUTRITION_ENDPOINT);
  assert.equal(JSON.parse(calls[1].options.body).recipes[0].title, "عدس‌پلو");
  assert.equal(JSON.parse(calls[1].options.body).recipes[0].cost_toman, undefined);
  cards.forEach((card, index) => {
    const plan = card.children[card.children.length - 1];
    assert.equal(plan.disabled, false);
    assert.equal(plan.textContent, COPY.addToPlan);
    assert.equal(plan.dataset.testid, "add-to-plan");
    assert.equal(plan.dataset.recipeIndex, String(index));
  });
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].type, "ashpaz-recipes");
  assert.equal(doc.events[0].detail.recipes[0].title, "عدس‌پلو");
});

test("recipe cards keep an index the meal plan can assign", () => {
  const doc = fakeDocument();
  recipes.renderRecipeGrid(doc, doc.nodes["recipe-grid"], THREE);
  assert.equal(recipes.latestRecipes[0].title, "عدس‌پلو");
  const cards = cardsOf(doc.nodes["recipe-grid"]);
  assert.equal(cards[2].children[cards[2].children.length - 1].dataset.recipeIndex, "2");
  assert.equal(cards[2].children[cards[2].children.length - 1].disabled, false);
});

test("empty pantry does not call the API", async () => {
  const doc = fakeDocument();
  let called = false;
  recipes.mount(doc, pantry([], "10"), () => {
    called = true;
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
  });
  doc.nodes.suggest.listeners.click();
  await flush();
  assert.equal(called, false);
  assert.equal(doc.nodes["recipe-error"].hidden, false);
  assert.equal(doc.nodes["recipe-error-text"].textContent, ERROR_COPY.empty_ingredients);
  assert.equal(doc.nodes["recipe-error-hint"].hidden, true);
  assert.equal(doc.nodes["recipe-error-hint"].textContent, "");
  assert.equal(doc.nodes.suggest.disabled, false);
});

test("failures show Persian retry copy and hide secrets", async () => {
  const doc = fakeDocument();
  const secret = "unit-test-key";
  recipes.mount(doc, pantry(["برنج"], "10"), () =>
    Promise.resolve(
      jsonResponse(502, {
        ok: false,
        error: "unauthorized",
        message: secret,
      }),
    ),
  );
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  assert.equal(doc.nodes["recipe-error"].hidden, false);
  assert.equal(doc.nodes["recipe-error-text"].textContent, ERROR_COPY.unauthorized);
  assert.equal(doc.nodes["recipe-error-text"].textContent.includes(secret), false);
  assert.equal(doc.nodes["recipe-error-hint"].hidden, false);
  assert.equal(doc.nodes["recipe-error-hint"].textContent, recipes.SERVICE_HINT);
  assert.equal(doc.nodes["recipe-error-hint"].textContent.includes(secret), false);
  assert.equal(doc.nodes["recipe-empty"].hidden, true);
  assert.equal(doc.nodes["recipe-skeleton"].hidden, true);
  assert.equal(doc.nodes["recipe-grid"].hidden, true);
  assert.equal(doc.nodes.suggest.disabled, false);
  assert.equal(doc.nodes["recipe-retry"].disabled, false);
});

test("retry asks again after an error", async () => {
  const doc = fakeDocument();
  const calls = [];
  recipes.mount(doc, pantry(["برنج"], null), () => {
    calls.push(1);
    if (calls.length === 1) {
      return Promise.reject(Object.assign(new Error("down"), { name: "AbortError" }));
    }
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
  });
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  assert.equal(doc.nodes["recipe-error-text"].textContent, ERROR_COPY.timeout);
  doc.nodes["recipe-retry"].listeners.click();
  await flush();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(doc.nodes["recipe-grid"].hidden, false);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
});

test("leftover suggest sends remaining chips, skips eaten dinners, and keeps the pantry", async () => {
  require("./pantry.js");
  const plan = require("./plan.js");
  require("./shop.js");
  const model = plan.createPlan({ storage: plan.createMemoryStorage() });
  model.assign(
    "sat",
    dish("عدس‌پلو", ["برنج", "عدس", "۲ عدد پیاز"], ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"], 180000),
  );
  model.setUsed("sat", true);
  const previous = global.AshpazPlan;
  global.AshpazPlan = Object.assign({}, plan, { active: model });
  const chips = ["برنج", "عدس", "پیاز", "ماست"];
  let removed = false;
  const source = {
    items() {
      return chips.slice();
    },
    budget() {
      return "1500000";
    },
    remove() {
      removed = true;
    },
    clear() {
      removed = true;
    },
  };
  const doc = fakeDocument();
  const calls = [];
  try {
    recipes.mount(doc, source, (url, options) => {
      calls.push({ url, options });
      return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
    });
    doc.nodes.suggest.listeners.click();
    await flush();
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(calls[1].url, recipes.NUTRITION_ENDPOINT);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      ingredients: chips,
      budget: 1500000,
      household: 4,
      remaining: ["ماست"],
      skip: ["عدس‌پلو"],
      full: false,
      count: 3,
    });
    assert.equal(doc.nodes["recipe-status"].textContent, COPY.leftoverNote);
    assert.equal(doc.nodes["recipe-grid"].hidden, false);
    assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
    assert.deepEqual(doc.events[0].detail.skip, ["عدس‌پلو"]);
    assert.equal(doc.events[0].detail.full, undefined);
    assert.equal(removed, false);
    assert.deepEqual(source.items(), chips);
    assert.equal(model.week()[0].meals.find((meal) => meal.id === "dinner").used, true);
    assert.equal(model.week()[0].meals.find((meal) => meal.id === "dinner").recipe.title, "عدس‌پلو");
  } finally {
    global.AshpazPlan = previous;
  }
});

test("full regenerate ignores the eaten skip and retry repeats that mode", async () => {
  require("./pantry.js");
  const plan = require("./plan.js");
  const model = plan.createPlan({ storage: plan.createMemoryStorage() });
  model.assign("sat", dish("عدس‌پلو", ["برنج"], ["برنج را بپز", "دم کن", "سرو کن"], 1000));
  model.setUsed("sat", true);
  const previous = global.AshpazPlan;
  global.AshpazPlan = Object.assign({}, plan, { active: model });
  const chips = ["برنج", "ماست"];
  const doc = fakeDocument();
  const calls = [];
  try {
    recipes.mount(doc, pantry(chips, "250000"), (url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return Promise.resolve(
          jsonResponse(502, { ok: false, error: "unauthorized", message: "unit-test-key" }),
        );
      }
      return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
    });
    doc.nodes["regenerate-full"].listeners.click();
    await flush();
    await flush();
    assert.deepEqual(calls[0], { ingredients: chips, budget: 250000, household: 4, full: true, count: 3 });
    assert.equal(doc.nodes["recipe-error-text"].textContent, ERROR_COPY.unauthorized);
    assert.equal(doc.nodes["recipe-error-text"].textContent.includes("unit-test-key"), false);
    doc.nodes["recipe-retry"].listeners.click();
    await flush();
    await flush();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1], { ingredients: chips, budget: 250000, household: 4, full: true, count: 3 });
    assert.ok(Array.isArray(calls[2].recipes));
    assert.equal(doc.nodes["recipe-status"].textContent, COPY.fullNote);
    assert.equal(doc.nodes["recipe-grid"].hidden, false);
    assert.equal(model.week()[0].meals.find((meal) => meal.id === "dinner").recipe.title, "عدس‌پلو");
    assert.equal(model.week()[0].meals.find((meal) => meal.id === "dinner").used, true);
    assert.deepEqual(pantry(chips, "250000").items(), chips);
  } finally {
    global.AshpazPlan = previous;
  }
});

test("an eaten week with no chips left does not call the API until full regenerate", async () => {
  const plan = require("./plan.js");
  const model = plan.createPlan({ storage: plan.createMemoryStorage() });
  model.assign("sat", dish("عدس‌پلو", ["برنج"], ["برنج را بپز", "دم کن", "سرو کن"], 1000));
  model.setUsed("sat", true);
  const previous = global.AshpazPlan;
  global.AshpazPlan = Object.assign({}, plan, { active: model });
  const doc = fakeDocument();
  const calls = [];
  try {
    recipes.mount(doc, pantry(["برنج"], "10"), (url, options) => {
      calls.push(JSON.parse(options.body));
      return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
    });
    doc.nodes.suggest.listeners.click();
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(doc.nodes["recipe-error-text"].textContent, ERROR_COPY.no_remaining);
    assert.equal(doc.nodes["recipe-error-hint"].hidden, true);
    assert.equal(doc.nodes.suggest.disabled, false);
    assert.equal(doc.nodes["regenerate-full"].disabled, false);
    doc.nodes["regenerate-full"].listeners.click();
    await flush();
    await flush();
    assert.deepEqual(calls[0], { ingredients: ["برنج"], budget: 10, household: 4, full: true, count: 3 });
    assert.equal(doc.nodes["recipe-grid"].hidden, false);
    assert.equal(calls.length, 2);
    assert.ok(Array.isArray(calls[1].recipes));
  } finally {
    global.AshpazPlan = previous;
  }
});

function collectText(node, found) {
  if (!node) return;
  if (node.textContent) found.push(String(node.textContent));
  if (node.attrs) {
    Object.keys(node.attrs).forEach((key) => found.push(String(node.attrs[key])));
  }
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i += 1) collectText(kids[i], found);
}

test("nutrition failure leaves the recipe cards up and hides the secret", async () => {
  const doc = fakeDocument();
  const secret = "unit-test-key";
  recipes.mount(doc, pantry(["برنج", "عدس"], "250000"), (url) => {
    if (url === recipes.NUTRITION_ENDPOINT) {
      return Promise.resolve(
        jsonResponse(503, {
          ok: false,
          error: "not_configured",
          message: secret,
          disclaimer: secret,
        }),
      );
    }
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
  });
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  assert.equal(doc.nodes["recipe-grid"].hidden, false);
  assert.equal(doc.nodes["recipe-error"].hidden, true);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
  const block = cardsOf(doc.nodes["recipe-grid"])[0].children[1];
  assert.equal(block.hidden, true);
  assert.equal(block.children[3].textContent, "");
  const texts = [];
  collectText(doc.nodes["recipe-grid"], texts);
  assert.equal(texts.join("\n").includes(secret), false);
  assert.equal(doc.nodes["recipe-status"].textContent, "");
});

test("nutrition estimates render in Persian with an AI disclaimer", async () => {
  const doc = fakeDocument();
  const secret = "unit-test-key";
  recipes.mount(doc, pantry(["برنج", "عدس"], "250000"), (url) => {
    if (url === recipes.NUTRITION_ENDPOINT) {
      return Promise.resolve(
        jsonResponse(200, {
          ok: true,
          available: true,
          message: secret,
          estimates: [
            { kcal: 450, protein_g: 18, carbs_g: 62, fat_g: 14, disclaimer: secret },
            { kcal: 510, protein_g: 20, carbs_g: 70, fat_g: 16 },
            { kcal: 90 },
          ],
        }),
      );
    }
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
  });
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  const cards = cardsOf(doc.nodes["recipe-grid"]);
  const first = cards[0].children[1];
  const third = cards[2].children[1];
  assert.equal(first.hidden, false);
  assert.equal(first.children[1].textContent, "حدود ۴۵۰ کیلوکالری در هر وعده");
  assert.equal(first.children[2].textContent, "پروتئین ۱۸ گرم، کربوهیدرات ۶۲ گرم، چربی ۱۴ گرم");
  assert.equal(first.children[3].textContent, COPY.nutritionDisclaimer);
  assert.equal(first.children[3].hidden, false);
  assert.equal(third.children[1].textContent, "حدود ۹۰ کیلوکالری در هر وعده");
  assert.equal(third.children[2].hidden, true);
  assert.equal(third.children[3].textContent, COPY.nutritionDisclaimer);
  const texts = [];
  collectText(doc.nodes["recipe-grid"], texts);
  assert.equal(texts.join("\n").includes(secret), false);
  assert.equal(doc.nodes["recipe-error"].hidden, true);
  assert.equal(doc.events[0].detail.recipes[0].kcal, undefined);
});

test("the same cards reuse the page cache", async () => {
  const doc = fakeDocument();
  const resolvers = [];
  recipes.mount(doc, pantry(["برنج"], "10"), (url) => {
    if (url === recipes.NUTRITION_ENDPOINT) {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    }
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
  });
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  resolvers[0](
    jsonResponse(200, {
      ok: true,
      estimates: [
        { kcal: 450, protein_g: 12, carbs_g: 70, fat_g: 10 },
        { kcal: 510 },
        { kcal: 90 },
      ],
    }),
  );
  await flush();
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  assert.equal(resolvers.length, 1);
  const block = cardsOf(doc.nodes["recipe-grid"])[0].children[1];
  assert.equal(block.children[1].textContent, "حدود ۴۵۰ کیلوکالری در هر وعده");
  assert.equal(block.children[3].textContent, COPY.nutritionDisclaimer);
});

test("a late nutrition response does not relabel newer cards", async () => {
  const doc = fakeDocument();
  const resolvers = [];
  let round = 0;
  recipes.mount(doc, pantry(["برنج"], "10"), (url) => {
    if (url === recipes.NUTRITION_ENDPOINT) {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    }
    round += 1;
    const title = round === 1 ? "عدس‌پلو" : "آبگوشت";
    const batch = THREE.map((item, index) =>
      index === 0 ? dish(title, item.ingredients, item.steps, item.cost_toman) : item,
    );
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: batch }));
  });
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  doc.nodes["regenerate-full"].listeners.click();
  await flush();
  await flush();
  assert.equal(resolvers.length, 2);
  resolvers[0](
    jsonResponse(200, {
      ok: true,
      estimates: [{ kcal: 111 }, { kcal: 111 }, { kcal: 111 }],
    }),
  );
  await flush();
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[0].children[0].textContent, "آبگوشت");
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[1].children[0].textContent, COPY.nutritionPending);
  resolvers[1](
    jsonResponse(200, {
      ok: true,
      estimates: [{ kcal: 640, protein_g: 30, carbs_g: 40, fat_g: 22 }, { kcal: 510 }, { kcal: 90 }],
    }),
  );
  await flush();
  const kcal = cardsOf(doc.nodes["recipe-grid"])[0].children[1].children[1].textContent;
  assert.equal(kcal, "حدود ۶۴۰ کیلوکالری در هر وعده");
  assert.equal(kcal.includes("۱۱۱"), false);
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[1].children[3].textContent, COPY.nutritionDisclaimer);
});

function addDietButtons(doc) {
  ["diet-vegetarian", "diet-no-onion", "diet-diabetic"].forEach((id) => {
    const node = element("button");
    node.id = id;
    doc.nodes[id] = node;
  });
}

test("diet chips toggle together and ride on generate", async () => {
  const doc = fakeDocument();
  addDietButtons(doc);
  const calls = [];
  const model = pantry(["برنج", "عدس"], "250000");
  const flags = { vegetarian: false, no_onion: false, diabetic: false };
  model.filters = () => ({ ...flags });
  model.setFilter = (key, on) => {
    flags[key] = on === true;
    return { ok: true, filters: { ...flags } };
  };
  recipes.mount(doc, model, (url, options) => {
    calls.push({ url, options });
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
  });
  assert.equal(doc.nodes["diet-vegetarian"].attrs["aria-pressed"], "false");
  assert.equal(doc.nodes["diet-no-onion"].attrs["aria-pressed"], "false");
  assert.equal(doc.nodes["diet-diabetic"].attrs["aria-pressed"], "false");
  doc.nodes["diet-vegetarian"].listeners.click();
  doc.nodes["diet-diabetic"].listeners.click();
  assert.equal(doc.nodes["diet-vegetarian"].attrs["aria-pressed"], "true");
  assert.equal(doc.nodes["diet-vegetarian"].className.includes("is-on"), true);
  assert.equal(doc.nodes["diet-no-onion"].attrs["aria-pressed"], "false");
  assert.equal(doc.nodes["diet-diabetic"].className.includes("is-on"), true);
  doc.nodes.suggest.listeners.click();
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ingredients: ["برنج", "عدس"],
    budget: 250000,
    household: 4,
    count: 3,
    filters: { vegetarian: true, no_onion: false, diabetic: true },
  });
  assert.equal(doc.nodes["diet-vegetarian"].disabled, true);
  await flush();
  await flush();
  assert.match(doc.nodes["recipe-status"].textContent, /گیاهی/);
  assert.match(doc.nodes["recipe-status"].textContent, /مناسب دیابت/);
  assert.equal(doc.nodes["recipe-status"].textContent.includes("بدون پیاز"), false);
  assert.equal(doc.nodes["diet-vegetarian"].disabled, false);

  doc.nodes["regenerate-full"].listeners.click();
  assert.deepEqual(JSON.parse(calls[2].options.body).filters, {
    vegetarian: true,
    no_onion: false,
    diabetic: true,
  });
  assert.equal(JSON.parse(calls[2].options.body).full, true);
});

test("a saved pantry filter is sent after a new pantry reads the same storage", () => {
  const pantryLib = require("./pantry.js");
  const storage = pantryLib.createMemoryStorage();
  const model = pantryLib.createPantry({ storage });
  model.add("برنج");
  model.setBudget("10");
  model.setFilter("no_onion", true);
  model.setFilter("vegetarian", true);
  const again = pantryLib.createPantry({ storage });
  assert.deepEqual(recipes.buildGeneratePayload(again), {
    ingredients: ["برنج"],
    budget: 10,
    household: 4,
    count: 3,
    filters: { vegetarian: true, no_onion: true, diabetic: false },
  });
  again.setFilter("vegetarian", false);
  again.setFilter("no_onion", false);
  assert.deepEqual(recipes.buildGeneratePayload(again), {
    ingredients: ["برنج"],
    budget: 10,
    household: 4,
    count: 3,
  });
  again.setHousehold(6);
  assert.equal(recipes.buildGeneratePayload(again).household, 6);
});

function nodeByTestId(node, id) {
  if (!node) return null;
  if (node.dataset && node.dataset.testid === id) return node;
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i += 1) {
    const found = nodeByTestId(kids[i], id);
    if (found) return found;
  }
  return null;
}

test("recipe cards scale amounts and cost for the current household and keep the stored lines", () => {
  const doc = fakeDocument();
  const stored = [
    dish("عدس‌پلو", ["۲۰۰ گرم گوشت", "برنج"], ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"], 10000),
    dish("لوبیا پلو", ["۱۰۰ گرم برنج"], ["لوبیا را بپز", "برنج را اضافه کن", "دم کن"], 5000),
    dish("ماست و خیار", ["۲ عدد خیار"], ["ماست را هم بزن", "خیار را اضافه کن", "سرد سرو کن"], 2000),
  ];
  stored.forEach((card) => {
    card.servings = 4;
  });
  recipes.renderRecipeGrid(doc, doc.nodes["recipe-grid"], stored, 8);
  const card = cardsOf(doc.nodes["recipe-grid"])[0];
  assert.equal(nodeByTestId(card, "recipe-ingredient").textContent, "۴۰۰ گرم گوشت");
  assert.equal(nodeByTestId(card, "recipe-cost").textContent, "حدود ۲۰٬۰۰۰ تومان");
  assert.equal(nodeByTestId(card, "recipe-people").textContent, "برای ۸ نفر");
  assert.equal(nodeByTestId(card, "recipe-step").textContent, "پیاز را تفت بده");
  assert.equal(recipes.latestRecipes[0].ingredients[0], "۲۰۰ گرم گوشت");
  assert.equal(recipes.latestRecipes[0].cost_toman, 10000);
  assert.equal(recipes.latestRecipes[0].servings, 4);

  const selected = recipes.selectRecipes(
    [
      dish("عدس‌پلو", ["برنج"], ["بپز", "دم کن", "سرو کن"], 10),
      dish("لوبیا پلو", ["لوبیا"], ["بپز", "دم کن", "سرو کن"], 10),
      dish("ماست", ["ماست"], ["بپز", "سرد کن", "سرو کن"], 10),
    ],
    6,
  );
  assert.equal(selected[0].servings, 6);
  assert.equal(recipes.messageForFailure(400, { error: "invalid_household", message: "secret" }), ERROR_COPY.invalid_household);
  assert.equal(recipes.hintForFailure({ error: "invalid_household" }), "");
});

test("suggest count is 3, then 5, then 7 as the pantry grows", () => {
  assert.equal(recipes.suggestCount(0), 3);
  assert.equal(recipes.suggestCount(1), 3);
  assert.equal(recipes.suggestCount(4), 3);
  assert.equal(recipes.suggestCount(5), 5);
  assert.equal(recipes.suggestCount(7), 5);
  assert.equal(recipes.suggestCount(8), 7);
  assert.equal(recipes.suggestCount(12), 7);
  assert.equal(recipes.SUGGEST_FIVE_AT, 5);
  assert.equal(recipes.SUGGEST_SEVEN_AT, 8);
  const rich = ["برنج", "عدس", "پیاز", "لوبیا", "ماست", "روغن", "مرغ", "سبزی", "تخم‌مرغ"];
  assert.equal(recipes.buildGeneratePayload(pantry(rich, "10")).count, 3);
  assert.equal(recipes.buildGeneratePayload(pantry(rich, "10"), { more: true }).count, 7);
  assert.equal(recipes.buildGeneratePayload(pantry(rich.slice(0, 6), "10"), { full: true }).count, 5);
  assert.equal(recipes.buildGeneratePayload(pantry(rich.slice(0, 4), "10"), { more: true }).count, 3);
  const seven = [];
  for (let i = 0; i < 8; i += 1) {
    seven.push(dish("غذا " + i, ["برنج"], ["آماده کن", "بپز", "سرو کن"], 1000));
  }
  assert.equal(recipes.selectRecipes(seven).length, 7);
  assert.equal(recipes.selectRecipes(seven.slice(0, 2)), null);
});

test("پیشنهاد دستورهای بیشتر appends and a failed more keeps the first cards", async () => {
  const rich = ["برنج", "عدس", "پیاز", "لوبیا", "ماست", "روغن", "مرغ", "سبزی", "تخم‌مرغ"];
  const extra = ["کوکو سبزی", "کتلت", "آش رشته", "زرشک‌پلو", "عدسی", "کشک بادمجان", "میرزا قاسمی"].map((title) =>
    dish(title, ["برنج", "روغن"], ["مواد را آماده کن", "بپز", "سرو کن"], 80000),
  );
  const doc = fakeDocument();
  const calls = [];
  let round = 0;
  recipes.mount(doc, pantry(rich, "1500000"), (url, options) => {
    if (url === recipes.NUTRITION_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { ok: true, estimates: [] }));
    }
    calls.push(JSON.parse(options.body));
    round += 1;
    if (round === 1) return Promise.resolve(jsonResponse(200, { ok: true, recipes: THREE }));
    if (round === 2) return Promise.resolve(jsonResponse(502, { ok: false, error: "upstream_error", message: "secret" }));
    if (round === 3) return Promise.resolve(jsonResponse(200, { ok: true, recipes: extra }));
    return Promise.resolve(jsonResponse(200, { ok: true, recipes: extra.slice(0, 3) }));
  });

  assert.equal(doc.nodes.suggest.textContent, COPY.suggest);
  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  assert.equal(calls[0].count, 3);
  assert.equal(calls[0].exclude, undefined);
  assert.equal(doc.nodes.suggest.textContent, COPY.suggestMore);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[0].children[0].textContent, "عدس‌پلو");

  doc.nodes.suggest.listeners.click();
  await flush();
  await flush();
  assert.equal(calls[1].count, 7);
  assert.deepEqual(calls[1].exclude, ["عدس‌پلو", "لوبیا پلو", "ماست و خیار"]);
  assert.equal(doc.nodes["recipe-grid"].hidden, false);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
  assert.equal(doc.nodes["recipe-error"].hidden, false);
  assert.equal(doc.nodes["recipe-error-text"].textContent.includes("secret"), false);
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[0].children[0].textContent, "عدس‌پلو");

  doc.nodes["recipe-retry"].listeners.click();
  await flush();
  await flush();
  assert.equal(calls[2].count, 7);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 10);
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[0].children[0].textContent, "عدس‌پلو");
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[3].children[0].children[0].textContent, "کوکو سبزی");
  assert.match(doc.nodes["recipe-status"].textContent, /اضافه شد/);
  assert.equal(doc.events[doc.events.length - 1].detail.append, true);
  assert.equal(doc.events[doc.events.length - 1].detail.recipes.length, 10);

  doc.nodes["regenerate-full"].listeners.click();
  await flush();
  await flush();
  assert.equal(calls[3].count, 7);
  assert.equal(calls[3].full, true);
  assert.equal(calls[3].exclude, undefined);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
  assert.equal(cardsOf(doc.nodes["recipe-grid"])[0].children[0].children[0].textContent, "کوکو سبزی");
  assert.match(doc.nodes["recipe-status"].textContent, /بازتولید کامل/);
  assert.equal(doc.nodes.suggest.textContent, COPY.suggestMore);
});
