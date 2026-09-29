const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  assert.equal(COPY.loading, "در حال پختن ایده‌ها…");
  assert.equal(COPY.retry, "تلاش دوباره");
  assert.equal(COPY.addToPlan, "افزودن به برنامه");
  assert.equal(ENDPOINT, "/api/recipes/generate");
});

test("payload includes pantry chips and week budget", () => {
  assert.deepEqual(recipes.buildGeneratePayload(pantry(["برنج", "پیاز"], "1500000")), {
    ingredients: ["برنج", "پیاز"],
    budget: 1500000,
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
  assert.match(html, />پیشنهاد دستور</);
  assert.match(html, /id="recipe-retry"/);
  assert.match(html, />تلاش دوباره</);
  assert.match(html, /recipes\.js/);
  assert.match(html, /id="recipe-empty"/);
  assert.match(html, /بودجه هفته را وارد کنید و «پیشنهاد دستور» را بزنید/);
  assert.match(html, /id="recipe-skeleton"/);
  assert.match(html, /id="recipe-error-hint"/);
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
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ingredients: ["برنج", "عدس"],
    budget: 250000,
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
  assert.equal(doc.nodes["recipe-grid"].hidden, false);
  assert.equal(doc.nodes["recipe-error"].hidden, true);
  assert.equal(doc.nodes["recipe-empty"].hidden, true);
  assert.equal(doc.nodes["recipe-skeleton"].hidden, true);
  assert.equal(doc.nodes["recipe-status"].textContent, "");
  const cards = cardsOf(doc.nodes["recipe-grid"]);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].children[0].children[0].textContent, "عدس‌پلو");
  assert.equal(cards[0].children[0].children[1].textContent, "حدود ۱۸۰٬۰۰۰ تومان");
  assert.equal(cards[0].children[2].children[0].textContent, "برنج");
  assert.equal(cards[0].children[4].children.length, 3);
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
  assert.equal(calls.length, 2);
  assert.equal(doc.nodes["recipe-grid"].hidden, false);
  assert.equal(cardsOf(doc.nodes["recipe-grid"]).length, 3);
});
