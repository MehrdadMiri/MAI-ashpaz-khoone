const test = require("node:test");
const assert = require("node:assert/strict");
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
