const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("./household.js");
const pantry = require("./pantry.js");

const { SEED_STAPLES, STORAGE_KEY, createPantry, createMemoryStorage, identityKey } = pantry;

function fresh() {
  return createPantry({ storage: createMemoryStorage() });
}

test("seed list is the eight Iranian staples", () => {
  assert.deepEqual(SEED_STAPLES, [
    "برنج",
    "پیاز",
    "عدس",
    "لوبیا",
    "سیب\u200cزمینی",
    "گوجه\u200cفرنگی",
    "ماست",
    "روغن",
  ]);
  assert.ok(SEED_STAPLES.length >= 8);
});

test("seed on an empty pantry loads the baseline in order", () => {
  const store = fresh();
  const result = store.seed();
  assert.equal(result.added.length, 8);
  assert.deepEqual(store.items(), [...SEED_STAPLES]);
});

test("seeding again does not duplicate staples", () => {
  const store = fresh();
  store.seed();
  const again = store.seed();
  assert.deepEqual(again.added, []);
  assert.equal(store.items().length, 8);
});

test("clear then seed restores the baseline and keeps the budget", () => {
  const store = fresh();
  store.setBudget("1500000");
  store.seed();
  store.add("نخود");
  store.remove("پیاز");
  store.clear();
  assert.deepEqual(store.items(), []);
  assert.equal(store.budget(), "1500000");
  store.seed();
  assert.deepEqual(store.items(), [...SEED_STAPLES]);
  assert.equal(store.budget(), "1500000");
});

test("rejects a name longer than 40 characters", () => {
  const store = fresh();
  assert.equal(store.add("ن".repeat(41)).reason, "too_long");
  assert.equal(store.add("ن".repeat(40)).ok, true);
});

test("add appends a new ingredient and ignores duplicates", () => {
  const store = fresh();
  assert.deepEqual(store.add("  نخود  "), { ok: true, reason: "added", name: "نخود" });
  assert.equal(store.add("نخود").reason, "duplicate");
  assert.equal(store.add("   ").reason, "empty");
  assert.deepEqual(store.items(), ["نخود"]);
});

test("Arabic and Persian spellings of the same staple collapse", () => {
  const store = fresh();
  store.seed();
  assert.equal(identityKey("سيب زميني"), identityKey("سیب\u200cزمینی"));
  assert.equal(store.add("سيب زميني").reason, "duplicate");
  assert.equal(store.add("گوجه فرنگی").reason, "duplicate");
  assert.deepEqual(store.add("كرفس"), { ok: true, reason: "added", name: "کرفس" });
  assert.deepEqual(store.add("کرفس"), { ok: false, reason: "duplicate", name: "کرفس" });
  assert.equal(store.items().filter((item) => identityKey(item) === identityKey("کرفس")).length, 1);
});

test("remove drops one chip", () => {
  const store = fresh();
  store.seed();
  assert.equal(store.remove("روغن"), true);
  assert.equal(store.remove("روغن"), false);
  assert.equal(store.items().includes("روغن"), false);
  assert.equal(store.items().length, 7);
});

test("seed merges missing staples without dropping custom items", () => {
  const store = fresh();
  store.add("نخود");
  store.add("برنج");
  const result = store.seed();
  assert.equal(result.added.includes("برنج"), false);
  assert.deepEqual(store.items()[0], "نخود");
  assert.equal(store.items().length, 9);
  SEED_STAPLES.forEach((staple) => {
    assert.equal(
      store.items().some((item) => identityKey(item) === identityKey(staple)),
      true,
    );
  });
});

test("week budget accepts digits and rejects junk", () => {
  const store = fresh();
  assert.deepEqual(store.setBudget("۱۲۳"), { ok: true, budget: "123" });
  assert.deepEqual(store.setBudget("1,500"), { ok: true, budget: "1500" });
  assert.equal(store.setBudget("nope").ok, false);
  assert.equal(store.budget(), "1500");
  assert.equal(store.setBudget("-4").ok, false);
  assert.equal(store.setBudget("").budget, "");
  assert.equal(store.budget(), "");
});

test("state survives a new pantry on the same storage", () => {
  const storage = createMemoryStorage();
  const first = createPantry({ storage });
  first.add("ماست");
  first.setBudget("20");
  const second = createPantry({ storage });
  assert.deepEqual(second.items(), ["ماست"]);
  assert.equal(second.budget(), "20");
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(raw.items, ["ماست"]);
});

test("corrupt storage starts empty instead of throwing", () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, "{");
  const store = createPantry({ storage });
  assert.deepEqual(store.items(), []);
  assert.equal(store.add("عدس").ok, true);
});

test("storage failures stay in memory", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  const store = createPantry({ storage });
  assert.equal(store.add("روغن").ok, true);
  assert.deepEqual(store.items(), ["روغن"]);
});

test("replace loads a saved pantry without notifying a remote hook", () => {
  const storage = createMemoryStorage();
  const store = createPantry({ storage });
  store.add("پیاز");
  let calls = 0;
  global.AshpazPersist = {
    onPantry() {
      calls += 1;
    },
  };
  try {
    store.replace({ items: ["برنج", "كرفس"], budget: "20" });
    assert.deepEqual(store.items(), ["برنج", "کرفس"]);
    assert.equal(store.budget(), "20");
    assert.equal(calls, 0);
    const again = createPantry({ storage });
    assert.deepEqual(again.snapshot(), {
      items: ["برنج", "کرفس"],
      budget: "20",
      filters: { vegetarian: false, no_onion: false, diabetic: false },
      household: 4,
    });
  } finally {
    delete global.AshpazPersist;
  }
});

test("a remote hook error still keeps the chip", () => {
  global.AshpazPersist = {
    onPantry() {
      throw new Error("down");
    },
  };
  try {
    const store = fresh();
    assert.equal(store.add("روغن").ok, true);
    assert.deepEqual(store.items(), ["روغن"]);
  } finally {
    delete global.AshpazPersist;
  }
});

test("a remote pantry event refreshes the budget field", () => {
  const storage = createMemoryStorage();
  const model = createPantry({ storage });
  model.setBudget("20");
  const listeners = {};
  const nodes = {};
  function el() {
    return {
      hidden: false,
      disabled: false,
      value: "",
      textContent: "",
      className: "",
      dataset: {},
      children: [],
      classList: { add() {}, toggle() {} },
      append() {},
      replaceChildren() {},
      setAttribute() {},
      addEventListener() {},
      focus() {},
      select() {},
    };
  }
  ["add-form", "ingredient", "chips", "empty", "status", "week-budget", "seed", "clear"].forEach((id) => {
    nodes[id] = el();
  });
  const doc = {
    getElementById(id) {
      return nodes[id] || null;
    },
    createElement: el,
    createDocumentFragment() {
      return { append() {} };
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
  };
  pantry.mount(doc, model);
  assert.equal(nodes["week-budget"].value, "20");
  model.replace({ items: ["برنج"], budget: "9" });
  listeners["ashpaz-pantry-changed"].forEach((fn) => fn({ detail: { source: "remote" } }));
  assert.equal(nodes["week-budget"].value, "9");
  assert.deepEqual(model.items(), ["برنج"]);
});

test("diet filters persist with the pantry and ignore unknown values", () => {
  const storage = createMemoryStorage();
  const store = createPantry({ storage });
  store.add("پیاز");
  store.setBudget("20");
  assert.deepEqual(store.setFilter("vegetarian", true), {
    ok: true,
    filters: { vegetarian: true, no_onion: false, diabetic: false },
  });
  store.setFilter("diabetic", true);
  store.setFilter("nope", true);
  store.clear();
  assert.deepEqual(store.items(), []);
  assert.equal(store.budget(), "20");
  const again = createPantry({ storage });
  assert.deepEqual(again.filters(), {
    vegetarian: true,
    no_onion: false,
    diabetic: true,
  });
  again.replace({
    items: ["برنج"],
    budget: "9",
    filters: { vegetarian: "بله", no_onion: true, diabetic: 1, extra: true },
  });
  assert.deepEqual(again.filters(), {
    vegetarian: false,
    no_onion: true,
    diabetic: false,
  });
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(raw.filters.no_onion, true);
  assert.equal(raw.filters.vegetarian, false);
});

test("empty pantry copy offers seed, a chip, and a fridge photo", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.match(html, /هنوز چیزی در آشپزخانه نیست/);
  assert.match(html, /empty-art/);
  assert.match(html, /id="empty-add"/);
  assert.match(html, /for="ingredient"/);
  assert.match(html, /افزودن ماده/);
  assert.match(html, /id="fridge-launch"/);
  assert.match(html, /id="seed"/);
  assert.match(html, /عکس یخچال/);
  assert.equal(html.includes(["GAP", "CODE", "API", "KEY"].join("_")), false);
  assert.match(html, /id="household-size"/);
  assert.match(html, /data-testid="household-size"/);
  assert.match(html, /id="household-dec"/);
  assert.match(html, /id="household-inc"/);
  assert.match(html, /تعداد نفرات/);
  assert.match(html, /کم کردن تعداد نفرات/);
  assert.match(html, /زیاد کردن تعداد نفرات/);
  assert.match(html, /household\.js/);
  assert.ok(html.indexOf("household.js") < html.indexOf("pantry.js"));
});

test("household size defaults to 4, persists, and clear keeps it", () => {
  const storage = createMemoryStorage();
  const store = createPantry({ storage });
  assert.equal(store.household(), 4);
  assert.equal(store.setHousehold(0).ok, false);
  assert.equal(store.household(), 4);
  assert.deepEqual(store.setHousehold("۸"), { ok: true, household: 8, changed: true });
  assert.equal(store.setHousehold(13).ok, false);
  assert.equal(store.household(), 8);
  assert.equal(store.setHousehold(8).changed, false);
  store.add("برنج");
  store.setBudget("20");
  store.clear();
  assert.deepEqual(store.items(), []);
  assert.equal(store.budget(), "20");
  assert.equal(store.household(), 8);
  const again = createPantry({ storage });
  assert.equal(again.household(), 8);
  assert.equal(again.budget(), "20");
  again.replace({ items: ["پیاز"], household: "nope" });
  assert.equal(again.household(), 4);
  again.replace({ items: ["پیاز"], household: 2 });
  assert.equal(again.household(), 2);
});
