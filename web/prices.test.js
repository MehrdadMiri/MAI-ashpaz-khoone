const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("./household.js");
require("./pantry.js");
require("./shop.js");
const shop = require("./shop.js");
const prices = require("./prices.js");

const RICE = {
  name: "برنج",
  name_key: "برنج",
  matched: true,
  product_id: "190868",
  product_title: "برنج عنبربو آذوقه 10 کیلوگرمی",
  product_url: "https://www.okala.com/product/190868",
  pack_price_toman: 4125000,
  pack_quantity: 10,
  unit: "کیلوگرم",
  unit_price_toman: 412500,
  in_stock: true,
  origin: "fixture",
  fetched_at: "2026-09-29T12:00:00+00:00",
  stale: false,
};

const ONION = {
  name: "پیاز",
  name_key: "پیاز",
  matched: true,
  product_id: "1000762",
  product_title: "پیاز سفید جانزی 2 کیلوگرمی",
  product_url: "https://www.okala.com/product/1000762",
  pack_price_toman: 176963,
  pack_quantity: 2,
  unit: "کیلوگرم",
  unit_price_toman: 88482,
  in_stock: false,
  origin: "fixture",
  fetched_at: "2026-09-29T12:00:00+00:00",
  stale: false,
};

function catalog(extra) {
  return {
    ok: true,
    origin: "fixture",
    ttl_seconds: 86400,
    items: [RICE, ONION].concat(extra || []),
    unmatched: ["زعفران"],
  };
}

function riceRecipe(cost) {
  return {
    title: "پلو",
    ingredients: ["۲۰۰ گرم برنج"],
    steps: ["بپز"],
    cost_toman: cost == null ? 10000 : cost,
    servings: 4,
  };
}

test("fresh Okala unit prices replace the estimate and scale once with تعداد نفرات", () => {
  prices.applyCatalog(catalog());
  const now = Date.parse("2026-09-29T18:00:00+00:00");
  const four = prices.quoteRecipe(riceRecipe(), 4, now);
  const eight = prices.quoteRecipe(riceRecipe(), 8, now);
  assert.equal(four.source, "okala");
  assert.equal(four.toman, 82500);
  assert.equal(four.label, "۸۲٬۵۰۰ تومان · اُکالا");
  assert.equal(eight.source, "okala");
  assert.equal(eight.toman, 165000);
  assert.equal(eight.label, "۱۶۵٬۰۰۰ تومان · اُکالا");
  assert.notEqual(eight.toman, 20000);

  const partial = prices.quoteRecipe(
    {
      title: "پلو",
      ingredients: ["۲۰۰ گرم برنج", "۲۰۰ گرم زعفران"],
      steps: ["بپز"],
      cost_toman: 10000,
      servings: 4,
    },
    4,
    now,
  );
  assert.equal(partial.source, "partial");
  assert.equal(partial.toman, 82500);
  assert.match(partial.label, /بخشی از اُکالا/);
});

test("a stale Okala row falls back to the estimate and a missing catalog stays an estimate", () => {
  prices.applyCatalog(catalog());
  const later = Date.parse("2026-10-02T12:00:00+00:00");
  const stale = prices.quoteRecipe(riceRecipe(180000), 4, later);
  assert.equal(stale.source, "estimate");
  assert.equal(stale.toman, 180000);
  assert.equal(stale.stale, true);
  assert.equal(stale.label, "حدود ۱۸۰٬۰۰۰ تومان");

  prices.applyCatalog({ items: [], unmatched: [], ttl_seconds: 86400 });
  const empty = prices.quoteRecipe(riceRecipe(180000), 8, later);
  assert.equal(empty.source, "estimate");
  assert.equal(empty.toman, 360000);
  assert.equal(empty.label, "حدود ۳۶۰٬۰۰۰ تومان");
});

test("shopping lines show an Okala total, and a piece count keeps the unit price", () => {
  prices.applyCatalog(catalog());
  const now = Date.parse("2026-09-29T18:00:00+00:00");
  const list = shop.buildShoppingList(
    [],
    [
      {
        id: "sat",
        label: "شنبه",
        meals: [
          {
            id: "dinner",
            label: "شام",
            recipe: {
              title: "پلو",
              ingredients: ["۲۰۰ گرم برنج"],
              steps: ["بپز"],
              cost_toman: 10000,
              servings: 4,
            },
          },
        ],
      },
    ],
    8,
  );
  const rice = list.categories.flatMap((cat) => cat.items).find((item) => item.name === "برنج");
  assert.equal(rice.priceSource, "okala");
  assert.equal(rice.priceLabel, "۱۶۵٬۰۰۰ تومان · اُکالا");
  assert.equal(rice.productUrl, RICE.product_url);

  const pieces = prices.priceParts("پیاز", [{ qty: 2, unit: "عدد" }], now);
  assert.equal(pieces.unitOnly, true);
  assert.match(pieces.label, /^هر کیلوگرم .+ تومان · اُکالا$/);
  assert.equal(pieces.productUrl, ONION.product_url);
});

test("manual names take an Okala price, a stale line stays labeled, and the cart copies them", () => {
  prices.applyCatalog(catalog());
  const now = Date.parse("2026-09-29T18:00:00+00:00");
  const later = Date.parse("2026-10-02T12:00:00+00:00");
  const fresh = prices.priceParts("برنج", [{ qty: 200, unit: "گرم" }], now);
  assert.equal(fresh.source, "okala");
  assert.equal(fresh.toman, 82500);
  const stale = prices.priceParts("برنج", [{ qty: 200, unit: "گرم" }], later);
  assert.equal(stale.source, "stale");
  assert.equal(stale.toman, 82500);
  assert.equal(stale.label, "حدود ۸۲٬۵۰۰ تومان · کهنه");
  const pieces = prices.priceParts("پیاز", [{ qty: 2, unit: "عدد" }], later);
  assert.equal(pieces.unitOnly, true);
  assert.equal(pieces.toman, 0);
  assert.match(pieces.label, /کهنه/);

  const list = shop.buildShoppingList(
    [],
    [
      {
        label: "شنبه",
        meals: [
          {
            label: "شام",
            recipe: { title: "پلو", ingredients: ["۲۰۰ گرم برنج"], steps: ["بپز"], cost_toman: 10000, servings: 4 },
          },
        ],
      },
    ],
    4,
    { manual: [{ id: "mzaferan01", name: "زعفران", qty: 1, unit: "گرم" }], overrides: {} },
  );
  const rice = list.categories.flatMap((cat) => cat.items).find((item) => item.name === "برنج");
  const saffron = list.categories.flatMap((cat) => cat.items).find((item) => item.name === "زعفران");
  assert.equal(rice.priceSource, "okala");
  assert.equal(rice.priceToman, 82500);
  assert.equal(saffron.origin, "manual");
  assert.equal(saffron.priceLabel, "");
  assert.match(list.totalLabel, /جمع/);
  assert.match(list.totalLabel, /اُکالا/);
  assert.equal(list.totalToman, 82500);

  const staleList = shop.buildShoppingList([], [], 4, {
    manual: [{ id: "mrice01", name: "برنج", qty: 200, unit: "گرم" }],
    overrides: {},
  });
  const originalNow = Date.now;
  Date.now = () => later;
  try {
    const aged = shop.buildShoppingList([], [], 4, {
      manual: [{ id: "mrice01", name: "برنج", qty: 200, unit: "گرم" }],
      overrides: {},
    });
    assert.match(aged.categories[0].items[0].priceLabel, /حدود/);
    assert.match(aged.categories[0].items[0].priceLabel, /کهنه/);
    assert.match(aged.totalLabel, /حدود/);
    assert.match(aged.totalLabel, /کهنه/);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(staleList.categories[0].items[0].origin, "manual");

  const assist = prices.cartAssist(list.categories.flatMap((cat) => cat.items));
  assert.match(assist.copy_text, /برنج/);
  assert.match(assist.copy_text, /زعفران/);
  assert.equal(assist.prefill, false);

  const model = shop.createShopping({ storage: shop.createMemoryStorage() });
  model.add({ name: "زعفران", qty: "۱", unit: "گرم" });
  const previousPlan = global.AshpazPlan;
  const previousShop = shop.active;
  global.AshpazPlan = { active: { week() { return []; } } };
  shop.active = model;
  try {
    assert.ok(prices.collectNames().includes("زعفران"));
  } finally {
    global.AshpazPlan = previousPlan;
    shop.active = previousShop;
  }
});

test("cart assist copies names and refuses cart, search, and checkout links", () => {
  prices.applyCatalog(catalog());
  const names = [];
  for (let i = 0; i < 12; i += 1) names.push("ماده" + i);
  names[0] = "برنج";
  const assist = prices.cartAssist(names.map((name) => ({ name: name, quantityLabel: "۱" })));
  assert.equal(assist.prefill, false);
  assert.equal(assist.checkout, false);
  assert.equal(assist.homepage, "https://www.okala.com/");
  assert.equal(assist.homepage.includes("/cart"), false);
  assert.equal(assist.homepage.includes("/search"), false);
  assert.equal(assist.copy_text.split("\n").length, 10);
  assert.match(assist.message, /پرداخت اینجا انجام نمی‌شود/);
  assert.match(assist.message, /ده نام/);
  assert.equal(assist.items[0].product_url, RICE.product_url);
  assert.equal(prices.safeProductUrl("https://www.okala.com/cart"), "");
  assert.equal(prices.safeProductUrl("https://www.okala.com/search?keyword=برنج"), "");
  assert.equal(prices.safeProductUrl("https://www.okala.com/checkout"), "");
  assert.equal(prices.safeProductUrl(RICE.product_url), RICE.product_url);
});

test("the refresh button and shopping cart use Persian and no API key", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const sw = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
  const docker = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  assert.match(html, /id="price-refresh"/);
  assert.match(html, />به‌روزرسانی قیمت‌ها</);
  assert.match(html, /id="shop-okala"/);
  assert.match(html, />سبد اُکالا</);
  assert.match(html, /src="prices\.js"/);
  assert.ok(html.indexOf("prices.js") < html.indexOf("recipes.js"));
  assert.equal(html.includes("GAP_CODE_API_KEY"), false);
  assert.match(sw, /\/prices\.js/);
  assert.match(docker, /prices\.js/);
  assert.equal(prices.statusText({ origin: "live", degraded: false }, true), "قیمت‌های اُکالا به‌روز شد.");
  assert.match(prices.statusText({ degraded: true }, true), /آخرین قیمت/);
  assert.match(prices.unmatchedText(["زعفران"]), /زعفران/);
  assert.equal(prices.COPY.refresh.includes("Okala"), false);
});

function element(tag) {
  const node = {
    tag,
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    dataset: {},
    children: [],
    listeners: {},
    append(...kids) {
      kids.forEach((kid) => {
        if (!kid) return;
        kid.parentNode = node;
        node.children.push(kid);
      });
    },
    replaceChildren(...kids) {
      node.children = [];
      node.append(...kids.flatMap((kid) => (kid && kid.tag === "fragment" ? kid.children : [kid])).filter(Boolean));
    },
    setAttribute(name, value) {
      node.attrs = node.attrs || {};
      node.attrs[name] = value;
      if (name.indexOf("data-") === 0) node.dataset[name.slice(5)] = value;
    },
    getAttribute(name) {
      return (node.attrs || {})[name];
    },
    addEventListener(type, fn) {
      node.listeners[type] = fn;
    },
    focus() {},
    scrollIntoView() {},
  };
  return node;
}

test("refresh stores the catalog and the shopping sheet copies the Okala list", async () => {
  prices.applyCatalog({ items: [], unmatched: [], ttl_seconds: 86400 });
  const nodes = {};
  function register(id, tag) {
    const node = element(tag || "div");
    node.id = id;
    nodes[id] = node;
    return node;
  }
  ["price-refresh", "price-status", "price-unmatched"].forEach((id) => register(id, "button"));
  const doc = {
    getElementById(id) {
      return nodes[id] || null;
    },
    dispatchEvent(event) {
      return event;
    },
  };
  const seen = [];
  prices.mount(doc, {
    storage: { getItem() { return null; }, setItem() {} },
    refresh(names) {
      seen.push(names);
      return Promise.resolve({ ok: true, body: catalog() });
    },
  });
  nodes["price-refresh"].listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(seen[0].includes("برنج"));
  assert.equal(nodes["price-status"].textContent, "قیمت‌ها از نمونه ذخیره‌شده اُکالا آمد.");
  assert.match(nodes["price-unmatched"].textContent, /زعفران/);

  const shopNodes = {};
  ["shop", "shop-list", "shop-empty", "shop-sheet", "shop-sheet-title", "shop-sheet-hint", "shop-sheet-list", "shop-okala", "shop-status"].forEach(
    (id) => {
      shopNodes[id] = element("div");
      shopNodes[id].id = id;
    },
  );
  shopNodes["shop-sheet"].hidden = true;
  const copied = [];
  const opened = [];
  const shopDoc = {
    nodes: shopNodes,
    body: element("body"),
    listeners: {},
    getElementById(id) {
      return shopNodes[id] || null;
    },
    createElement: element,
    createDocumentFragment() {
      return element("fragment");
    },
    addEventListener(type, fn) {
      shopDoc.listeners[type] = shopDoc.listeners[type] || [];
      shopDoc.listeners[type].push(fn);
    },
    dispatchEvent(event) {
      (shopDoc.listeners[event.type] || []).forEach((fn) => fn(event));
    },
  };
  shop.mount(shopDoc, {
    pantry: () => [],
    week: () => [
      {
        label: "شنبه",
        meals: [
          {
            label: "شام",
            recipe: { title: "پلو", ingredients: ["۲۰۰ گرم برنج"], steps: ["بپز"], cost_toman: 1, servings: 4 },
          },
        ],
      },
    ],
    household: () => 4,
    copy(text) {
      copied.push(text);
    },
    open(url) {
      opened.push(url);
    },
  });
  shopNodes["shop-okala"].listeners.click();
  assert.equal(shopNodes["shop-sheet"].hidden, false);
  assert.equal(shopNodes["shop-sheet-title"].textContent, "سبد اُکالا");
  assert.match(shopNodes["shop-sheet-hint"].textContent, /پرداخت اینجا انجام نمی‌شود/);
  const choices = shopNodes["shop-sheet-list"].children.map((li) => li.children[0]);
  const productChoice = choices.find((button) => String(button.dataset.choice || "").startsWith("product:"));
  assert.ok(productChoice);
  shopDoc.dispatchEvent({ type: "click", target: productChoice });
  assert.equal(opened[0], RICE.product_url);
  assert.equal(opened[0].includes("/cart"), false);
  shopNodes["shop-okala"].listeners.click();
  const copyChoice = shopNodes["shop-sheet-list"].children
    .map((li) => li.children[0])
    .find((button) => button.dataset.choice === "copy");
  shopDoc.dispatchEvent({ type: "click", target: copyChoice });
  assert.equal(copied[0], "برنج");
});
