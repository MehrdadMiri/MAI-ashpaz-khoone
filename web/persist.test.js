const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pantry = require("./pantry.js");
const plan = require("./plan.js");
const persist = require("./persist.js");

const USER_RE = /^[A-Za-z0-9_-]{8,64}$/;

function storage() {
  return pantry.createMemoryStorage();
}

function cookieJar() {
  const jar = { value: "" };
  return {
    jar,
    cookie: {
      get() {
        return jar.value;
      },
      set(value) {
        jar.value = value;
      },
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json() {
      return Promise.resolve(body);
    },
  };
}

function mockFetch(handler) {
  const calls = [];
  function fetchImpl(url, options) {
    const call = {
      url,
      options,
      body: options && options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    const result = handler(call);
    if (result && typeof result.then === "function") return result;
    return Promise.resolve(result);
  }
  return { fetchImpl, calls };
}

function session(overrides) {
  const jar = cookieJar();
  const store = overrides.storage || storage();
  const fetchBox = overrides.fetchBox || mockFetch(() => jsonResponse(200, { ok: true, found: false }));
  const created = persist.createPersist({
    storage: store,
    cookie: jar.cookie,
    fetch: fetchBox.fetchImpl,
    delay: 0,
    document: overrides.document || null,
    apiBase: "/api",
  });
  return { created, store, jar, calls: fetchBox.calls, fetchBox };
}

test("a browser id is stable, cookie-backed, and not an account secret", () => {
  const store = storage();
  const jar = cookieJar();
  const first = persist.createPersist({ storage: store, cookie: jar.cookie, delay: 0, fetch: () => Promise.reject(new Error("down")) });
  const second = persist.createPersist({ storage: store, cookie: jar.cookie, delay: 0, fetch: () => Promise.reject(new Error("down")) });
  assert.equal(first.userId(), second.userId());
  assert.match(first.userId(), USER_RE);
  assert.match(jar.jar.value, new RegExp(persist.COOKIE_NAME + "="));
  assert.match(jar.jar.value, /SameSite=Lax/);
  assert.equal(jar.jar.value.includes("HttpOnly"), false);
  assert.equal(store.getItem(persist.USER_KEY), first.userId());
  assert.equal(jar.jar.value.includes("برنج"), false);

  const fresh = storage();
  const restored = persist.createPersist({
    storage: fresh,
    cookie: jar.cookie,
    delay: 0,
    fetch: () => Promise.reject(new Error("down")),
  });
  assert.equal(restored.userId(), first.userId());
  assert.equal(fresh.getItem(persist.USER_KEY), first.userId());
});

test("an invalid stored id is replaced", () => {
  const store = storage();
  store.setItem(persist.USER_KEY, "nope");
  const jar = cookieJar();
  const created = persist.createPersist({ storage: store, cookie: jar.cookie, delay: 0, fetch: () => Promise.reject(new Error("down")) });
  assert.notEqual(created.userId(), "nope");
  assert.match(created.userId(), USER_RE);
});

test("a saved pantry replaces the cache and does not write again", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  model.add("پیاز");
  const events = [];
  const fetchBox = mockFetch((call) => {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, undefined);
    return jsonResponse(200, {
      ok: true,
      found: true,
      pantry: { items: ["برنج"], budget: "20" },
    });
  });
  const created = persist.createPersist({
    storage: store,
    cookie: cookieJar().cookie,
    fetch: fetchBox.fetchImpl,
    delay: 0,
    document: {
      dispatchEvent(event) {
        events.push(event);
      },
    },
  });
  await created.hydrate(model, null);
  assert.equal(fetchBox.calls[0].options.headers["X-Local-User-Id"], created.userId());
  assert.deepEqual(model.items(), ["برنج"]);
  assert.equal(model.budget(), "20");
  assert.equal(fetchBox.calls.length, 1);
  assert.equal(events[0].detail.source, "remote");
  assert.equal(JSON.parse(store.getItem(pantry.STORAGE_KEY)).items[0], "برنج");
});

test("a browser cache is uploaded when the server has no row", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  model.setBudget("15");
  model.add("عدس");
  const fetchBox = mockFetch((call) => {
    if (call.options.method === "GET") {
      return jsonResponse(200, { ok: true, found: false, pantry: { items: [], budget: "" } });
    }
    assert.equal(call.url, "/api/pantry");
    assert.equal(call.options.headers["Content-Type"], "application/json");
    assert.deepEqual(call.body.pantry.items, ["عدس"]);
    assert.equal(call.body.pantry.budget, "15");
    assert.equal(call.body.local_user_id, call.options.headers["X-Local-User-Id"]);
    assert.equal(JSON.stringify(call.options.headers).includes("Bearer"), false);
    return jsonResponse(200, { ok: true, found: true, pantry: call.body.pantry });
  });
  const { created } = session({ storage: store, fetchBox });
  await created.hydrate(model, null);
  assert.equal(fetchBox.calls.filter((call) => call.options.method === "PUT").length, 1);
  assert.deepEqual(model.items(), ["عدس"]);
});

test("an api failure keeps the local pantry", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  model.add("ماست");
  const fetchBox = mockFetch(() => Promise.reject(new Error("offline")));
  const { created } = session({ storage: store, fetchBox });
  await created.hydrate(model, null);
  assert.deepEqual(model.items(), ["ماست"]);
});

test("an unsynced local edit wins over a saved row", async () => {
  const store = storage();
  store.setItem(
    persist.META_KEY,
    JSON.stringify({ pantryRev: 4, pantrySyncedRev: 1, planRev: 0, planSyncedRev: 0 }),
  );
  const model = pantry.createPantry({ storage: store });
  model.add("نخود");
  const fetchBox = mockFetch((call) => {
    assert.equal(call.options.method, "PUT");
    assert.deepEqual(call.body.pantry.items, ["نخود"]);
    return jsonResponse(200, { ok: true, found: true, pantry: call.body.pantry });
  });
  const { created } = session({ storage: store, fetchBox });
  await created.hydrate(model, null);
  assert.deepEqual(model.items(), ["نخود"]);
  assert.equal(fetchBox.calls.length, 1);
});

test("an edit during load is not overwritten by the saved row", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  let releaseGet;
  const fetchBox = mockFetch((call) => {
    if (call.options.method === "PUT") {
      return jsonResponse(200, { ok: true, found: true, pantry: call.body.pantry });
    }
    return new Promise((resolve) => {
      releaseGet = () =>
        resolve(
          jsonResponse(200, {
            ok: true,
            found: true,
            pantry: { items: ["برنج"], budget: "" },
          }),
        );
    });
  });
  const created = persist.createPersist({
    storage: store,
    cookie: cookieJar().cookie,
    fetch: fetchBox.fetchImpl,
    delay: 0,
  });
  const pending = created.hydrate(model, null);
  model.add("نخود");
  created.savePantry(model.snapshot());
  releaseGet();
  await pending;
  assert.deepEqual(model.items(), ["نخود"]);
  const puts = fetchBox.calls.filter((call) => call.options && call.options.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body.pantry.items, ["نخود"]);
});

test("diet filters are saved with the pantry and uploaded when that is the only change", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  model.setFilter("vegetarian", true);
  model.setFilter("diabetic", true);
  const fetchBox = mockFetch((call) => {
    if (call.options.method === "GET") {
      return jsonResponse(200, { ok: true, found: false, pantry: { items: [], budget: "" } });
    }
    return jsonResponse(200, { ok: true, found: true, pantry: call.body.pantry });
  });
  const { created } = session({ storage: store, fetchBox });
  await created.hydrate(model, null);
  const puts = fetchBox.calls.filter((call) => call.options && call.options.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body.pantry.filters, {
    vegetarian: true,
    no_onion: false,
    diabetic: true,
  });
  assert.deepEqual(puts[0].body.pantry.items, []);
  const again = pantry.createPantry({ storage: store });
  assert.equal(again.filters().vegetarian, true);
  assert.equal(again.filters().diabetic, true);
  assert.equal(again.filters().no_onion, false);
});

test("rapid pantry edits send the latest snapshot", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  const fetchBox = mockFetch((call) => jsonResponse(200, { ok: true, found: true, pantry: call.body.pantry }));
  const { created } = session({ storage: store, fetchBox });
  created.savePantry(model.snapshot());
  model.add("روغن");
  created.savePantry(model.snapshot());
  model.add("پیاز");
  created.savePantry(model.snapshot());
  await created.flush();
  const puts = fetchBox.calls.filter((call) => call.options.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body.pantry.items, ["روغن", "پیاز"]);
});

test("a failed save stays dirty and the next flush retries", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  model.add("لوبیا");
  let attempts = 0;
  const fetchBox = mockFetch(() => {
    attempts += 1;
    if (attempts === 1) return jsonResponse(503, { ok: false, error: "database_unavailable" });
    return jsonResponse(200, { ok: true, found: true, pantry: { items: ["لوبیا"], budget: "" } });
  });
  const { created } = session({ storage: store, fetchBox });
  created.savePantry(model.snapshot());
  await created.flush();
  const meta = JSON.parse(store.getItem(persist.META_KEY));
  assert.ok(meta.pantryRev > meta.pantrySyncedRev);
  await created.flush();
  const synced = JSON.parse(store.getItem(persist.META_KEY));
  assert.equal(synced.pantryRev, synced.pantrySyncedRev);
  assert.equal(attempts, 2);
});

test("the week plan round-trips through the same local id", async () => {
  const store = storage();
  const model = plan.createPlan({ storage: store });
  model.assign("sat", { title: "عدس‌پلو", ingredients: ["برنج"], steps: ["بپز"], cost_toman: 10 });
  model.setUsed("sat", true);
  const fetchBox = mockFetch((call) => {
    if (call.options.method === "GET" && call.url === "/api/plan") {
      return jsonResponse(200, { ok: true, found: false, plan: { recipes: [], slots: {}, used: {} } });
    }
    if (call.options.method === "GET") {
      return jsonResponse(200, { ok: true, found: false, pantry: { items: [], budget: "" } });
    }
    return jsonResponse(200, { ok: true, found: true, plan: call.body.plan, pantry: call.body.pantry });
  });
  const { created } = session({ storage: store, fetchBox });
  await created.hydrate(null, model);
  const put = fetchBox.calls.find((call) => call.options.method === "PUT" && call.url === "/api/plan");
  assert.equal(put.body.plan.slots.sat.dinner, "r:عدسپلو");
  assert.equal(put.body.plan.slots.sat.breakfast, null);
  assert.equal(put.body.plan.used.sat.dinner, true);
  assert.equal(put.body.plan.used.sat.lunch, false);
  assert.equal(put.body.plan.recipes[0].title, "عدس‌پلو");
  assert.equal(model.week()[0].meals.find((meal) => meal.id === "dinner").used, true);
});

test("the page wires persist.js after the plan and does not embed a key", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const docker = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "persist.js"), "utf8");
  assert.ok(html.indexOf("shop.js") < html.indexOf("persist.js"));
  assert.match(docker, /persist\.js/);
  assert.equal(script.includes("GAP_CODE_API_KEY"), false);
  assert.equal(script.includes("Bearer "), false);
  assert.match(script, /\/pantry/);
  assert.match(script, /\/plan/);
  assert.match(script, /localStorage/);
});

test("household size is saved with the pantry and uploaded when that is the only change", async () => {
  const store = storage();
  const model = pantry.createPantry({ storage: store });
  assert.equal(model.setHousehold(6).ok, true);
  const fetchBox = mockFetch((call) => {
    if (call.options.method === "GET") {
      return jsonResponse(200, { ok: true, found: false, pantry: { items: [], budget: "" } });
    }
    return jsonResponse(200, { ok: true, found: true, pantry: call.body.pantry });
  });
  const { created } = session({ storage: store, fetchBox });
  await created.hydrate(model, null);
  const puts = fetchBox.calls.filter((call) => call.options && call.options.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.pantry.household, 6);
  assert.deepEqual(puts[0].body.pantry.items, []);
  const again = pantry.createPantry({ storage: store });
  assert.equal(again.household(), 6);
});
