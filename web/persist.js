/* Server persistence for pantry chips, the 7-day plan, and shopping extras.
   The browser keeps a random local user id in localStorage and a cookie.
   That id is not an account. Saves go to PUT /api/pantry, PUT /api/plan,
   and PUT /api/shopping. localStorage remains the copy used when the api
   or database is down. This file does not call GapGPT and never sees an API key. */
(function (global) {
  "use strict";

  var USER_KEY = "ashpaz-khoone.local-user.v1";
  var META_KEY = "ashpaz-khoone.sync.v1";
  var COOKIE_NAME = "ashpaz_local_user";
  var USER_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var DEBOUNCE_MS = 400;
  var RETRY_MS = 5000;
  var DAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
  var MEALS = ["breakfast", "lunch", "dinner"];

  function validId(value) {
    return typeof value === "string" && USER_RE.test(value);
  }

  function defaultRandomId() {
    var cryptoObj = global.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      var uuid = cryptoObj.randomUUID();
      if (validId(uuid)) return uuid;
    }
    var bytes = new Uint8Array(16);
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      cryptoObj.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = "";
    for (var j = 0; j < bytes.length; j += 1) hex += (bytes[j] + 256).toString(16).slice(1);
    return (
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-" +
      hex.slice(12, 16) +
      "-" +
      hex.slice(16, 20) +
      "-" +
      hex.slice(20)
    );
  }

  function cookieValue(header, name) {
    var parts = String(header || "").split(";");
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].replace(/^\s+/, "");
      var eq = part.indexOf("=");
      if (eq <= 0) continue;
      if (part.slice(0, eq) !== name) continue;
      try {
        return decodeURIComponent(part.slice(eq + 1));
      } catch (err) {
        return "";
      }
    }
    return "";
  }

  function later(fn, ms) {
    var handle = setTimeout(fn, ms);
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  function copyFilters(snapshot) {
    var source = snapshot && snapshot.filters;
    return {
      vegetarian: !!(source && source.vegetarian === true),
      no_onion: !!(source && source.no_onion === true),
      diabetic: !!(source && source.diabetic === true),
    };
  }

  function copyHousehold(snapshot) {
    var shared = global.AshpazHousehold;
    if (shared && typeof shared.householdOrDefault === "function") {
      return shared.householdOrDefault(snapshot && snapshot.household);
    }
    var value = snapshot && snapshot.household;
    if (typeof value !== "number" || !isFinite(value)) return 4;
    var people = Math.round(value);
    if (people < 1 || people > 12) return 4;
    return people;
  }

  function copyPantry(snapshot) {
    var items = [];
    if (snapshot && Array.isArray(snapshot.items)) {
      snapshot.items.forEach(function (item) {
        if (typeof item === "string") items.push(item);
      });
    }
    return {
      items: items,
      budget: snapshot && typeof snapshot.budget === "string" ? snapshot.budget : "",
      filters: copyFilters(snapshot),
      household: copyHousehold(snapshot),
    };
  }

  function copyPlan(snapshot) {
    var recipes = [];
    if (snapshot && Array.isArray(snapshot.recipes)) {
      snapshot.recipes.forEach(function (recipe) {
        if (!recipe || typeof recipe !== "object") return;
        var copied = {
          id: recipe.id,
          title: recipe.title,
          ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice() : [],
          steps: Array.isArray(recipe.steps) ? recipe.steps.slice() : [],
          cost_toman: recipe.cost_toman,
        };
        if (typeof recipe.servings === "number" && isFinite(recipe.servings)) {
          copied.servings = Math.round(recipe.servings);
        }
        recipes.push(copied);
      });
    }
    var slots = {};
    var used = {};
    var sourceSlots = (snapshot && snapshot.slots) || {};
    var sourceUsed = (snapshot && snapshot.used) || {};
    DAYS.forEach(function (day) {
      var rawSlot = sourceSlots[day];
      var rawUsed = sourceUsed[day];
      var nextSlot = { breakfast: null, lunch: null, dinner: null };
      var nextUsed = { breakfast: false, lunch: false, dinner: false };
      if (typeof rawSlot === "string" || rawSlot == null) {
        nextSlot.dinner = typeof rawSlot === "string" ? rawSlot : null;
        nextUsed.dinner = rawUsed === true;
      } else if (typeof rawSlot === "object") {
        MEALS.forEach(function (meal) {
          nextSlot[meal] = typeof rawSlot[meal] === "string" ? rawSlot[meal] : null;
        });
        if (typeof rawUsed === "boolean") {
          nextUsed.dinner = rawUsed === true;
        } else if (rawUsed && typeof rawUsed === "object") {
          MEALS.forEach(function (meal) {
            nextUsed[meal] = rawUsed[meal] === true;
          });
        }
      }
      slots[day] = nextSlot;
      used[day] = nextUsed;
    });
    return { recipes: recipes, slots: slots, used: used };
  }

  function hasPantry(snapshot) {
    if (!snapshot) return false;
    if (Array.isArray(snapshot.items) && snapshot.items.length) return true;
    if (typeof snapshot.budget === "string" && snapshot.budget !== "") return true;
    var filters = copyFilters(snapshot);
    if (filters.vegetarian || filters.no_onion || filters.diabetic) return true;
    return copyHousehold(snapshot) !== 4;
  }

  function copyShopping(snapshot) {
    var manual = [];
    var source = snapshot && Array.isArray(snapshot.manual) ? snapshot.manual : [];
    source.forEach(function (item) {
      if (!item || typeof item !== "object" || typeof item.name !== "string") return;
      var row = {
        id: typeof item.id === "string" ? item.id : "",
        name: item.name,
        qty: typeof item.qty === "number" && isFinite(item.qty) ? item.qty : null,
        unit: typeof item.unit === "string" ? item.unit : "",
        checked: item.checked === true,
      };
      manual.push(row);
    });
    var overrides = {};
    var raw = snapshot && snapshot.overrides;
    if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(function (key) {
        var value = raw[key];
        if (!value || typeof value !== "object") return;
        overrides[key] = {
          name: typeof value.name === "string" ? value.name : "",
          qty: typeof value.qty === "number" && isFinite(value.qty) ? value.qty : null,
          unit: typeof value.unit === "string" ? value.unit : "",
          qtyOwned: value.qtyOwned === true,
          removed: value.removed === true,
          checked: value.checked === true,
        };
      });
    }
    return { manual: manual, overrides: overrides };
  }

  function hasShopping(snapshot) {
    if (!snapshot) return false;
    if (Array.isArray(snapshot.manual) && snapshot.manual.length) return true;
    var overrides = snapshot.overrides;
    if (!overrides || typeof overrides !== "object") return false;
    return Object.keys(overrides).length > 0;
  }

  function emptyMeta() {
    return {
      pantryRev: 0,
      pantrySyncedRev: 0,
      planRev: 0,
      planSyncedRev: 0,
      shoppingRev: 0,
      shoppingSyncedRev: 0,
    };
  }

  function hasPlan(snapshot) {
    if (!snapshot) return false;
    if (Array.isArray(snapshot.recipes) && snapshot.recipes.length) return true;
    var slots = snapshot.slots || {};
    for (var i = 0; i < DAYS.length; i += 1) {
      var raw = slots[DAYS[i]];
      if (typeof raw === "string" && raw) return true;
      if (raw && typeof raw === "object") {
        for (var m = 0; m < MEALS.length; m += 1) {
          if (raw[MEALS[m]]) return true;
        }
      }
    }
    return false;
  }

  function createPersist(options) {
    options = options || {};
    var storage = options.storage;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      var memory = Object.create(null);
      storage = {
        getItem: function (key) {
          return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
        },
        setItem: function (key, value) {
          memory[key] = String(value);
        },
      };
    }
    var delay = options.delay == null ? DEBOUNCE_MS : options.delay;
    var retryMs = options.retryMs == null ? RETRY_MS : options.retryMs;
    var doc = options.document || null;
    var cookies = options.cookie;
    if (!cookies || typeof cookies.get !== "function" || typeof cookies.set !== "function") {
      cookies = {
        get: function () {
          try {
            if (typeof document === "undefined" || !document || typeof document.cookie !== "string") return "";
            return document.cookie;
          } catch (err) {
            return "";
          }
        },
        set: function (value) {
          try {
            if (typeof document !== "undefined" && document) document.cookie = value;
          } catch (err) {
            /* The id still lives in localStorage for this browser. */
          }
        },
      };
    }

    var meta = loadMeta();
    var userId = resolveUserId();
    var pantryEdits = 0;
    var planEdits = 0;
    var shoppingEdits = 0;

    function loadMeta() {
      var empty = emptyMeta();
      try {
        var raw = storage.getItem(META_KEY);
        if (!raw) return empty;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return empty;
        Object.keys(empty).forEach(function (key) {
          var value = parsed[key];
          empty[key] = typeof value === "number" && isFinite(value) && value >= 0 ? Math.floor(value) : 0;
        });
        return empty;
      } catch (err) {
        return emptyMeta();
      }
    }

    function writeMeta() {
      try {
        storage.setItem(META_KEY, JSON.stringify(meta));
      } catch (err) {
        /* The pantry key is still the local copy. */
      }
    }

    function readStoredId() {
      try {
        var raw = storage.getItem(USER_KEY);
        return validId(raw) ? raw : "";
      } catch (err) {
        return "";
      }
    }

    function writeStoredId(id) {
      try {
        storage.setItem(USER_KEY, id);
      } catch (err) {
        /* Keep the id in memory and in the cookie when that write works. */
      }
    }

    function writeCookie(id) {
      var secure = "";
      try {
        if (global.location && global.location.protocol === "https:") secure = "; Secure";
      } catch (err) {
        secure = "";
      }
      cookies.set(
        COOKIE_NAME + "=" + encodeURIComponent(id) + "; Path=/; Max-Age=31536000; SameSite=Lax" + secure
      );
    }

    function resolveUserId() {
      var fromStore = readStoredId();
      if (fromStore) {
        writeCookie(fromStore);
        return fromStore;
      }
      var fromCookie = cookieValue(cookies.get(), COOKIE_NAME);
      if (validId(fromCookie)) {
        writeStoredId(fromCookie);
        writeCookie(fromCookie);
        return fromCookie;
      }
      var makeId = typeof options.random === "function" ? options.random : defaultRandomId;
      var created = makeId();
      if (!validId(created)) created = defaultRandomId();
      writeStoredId(created);
      writeCookie(created);
      return created;
    }

    function resolveFetch() {
      var fetchFn = options.fetch || global.fetch;
      return typeof fetchFn === "function" ? fetchFn : null;
    }

    function apiPath(path) {
      var base = options.apiBase == null ? "/api" : String(options.apiBase);
      if (base.charAt(base.length - 1) === "/") base = base.slice(0, -1);
      return base + path;
    }

    function notify(name, detail) {
      if (!doc || typeof doc.dispatchEvent !== "function") return;
      var event;
      try {
        event =
          typeof CustomEvent === "function"
            ? new CustomEvent(name, { detail: detail })
            : { type: name, detail: detail };
      } catch (err) {
        event = { type: name, detail: detail };
      }
      try {
        doc.dispatchEvent(event);
      } catch (err2) {
        /* The model is already updated. The next local render reads it. */
      }
    }

    function getJson(path) {
      var fetchFn = resolveFetch();
      if (!fetchFn) return Promise.reject(new Error("unavailable"));
      return fetchFn(apiPath(path), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "X-Local-User-Id": userId,
        },
      })
        .then(function (response) {
          if (!response || !response.ok) throw new Error("unavailable");
          return response.json();
        })
        .then(function (body) {
          if (!body || body.ok !== true) throw new Error("unavailable");
          return body;
        });
    }

    function putJson(path, payload) {
      var fetchFn = resolveFetch();
      if (!fetchFn) return Promise.reject(new Error("unavailable"));
      var body = JSON.stringify(Object.assign({ local_user_id: userId }, payload));
      var init = {
        method: "PUT",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Local-User-Id": userId,
        },
        body: body,
      };
      if (body.length <= 60000) init.keepalive = true;
      return fetchFn(apiPath(path), init)
        .then(function (response) {
          if (!response || !response.ok) throw new Error("unavailable");
          return response.json();
        })
        .then(function (parsed) {
          if (!parsed || parsed.ok !== true) throw new Error("unavailable");
          return parsed;
        });
    }

    function createQueue(send) {
      var timer = null;
      var retry = null;
      var pending = null;
      var sending = false;
      var inFlight = Promise.resolve();

      function clearTimers() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (retry) {
          clearTimeout(retry);
          retry = null;
        }
      }

      function kick() {
        if (sending) return inFlight;
        if (!pending) return Promise.resolve();
        var job = pending;
        pending = null;
        sending = true;
        inFlight = send(job)
          .then(function () {
            sending = false;
            return kick();
          })
          .catch(function (err) {
            sending = false;
            if (!pending) pending = job;
            retry = later(function () {
              retry = null;
              kick();
            }, retryMs);
            throw err;
          });
        return inFlight;
      }

      return {
        push: function (job) {
          pending = job;
          clearTimers();
          timer = later(function () {
            timer = null;
            kick();
          }, delay);
        },
        flush: function () {
          clearTimers();
          return kick().catch(function () {
            /* Keep the local copy. The next flush or page load tries again. */
          });
        },
      };
    }

    var pantryQueue = createQueue(function (job) {
      return putJson("/pantry", { pantry: job.snapshot }).then(function () {
        var rev = meta.pantryRev || 0;
        if (rev <= job.rev) meta.pantrySyncedRev = rev;
        else if ((meta.pantrySyncedRev || 0) < job.rev) meta.pantrySyncedRev = job.rev;
        writeMeta();
      });
    });

    var planQueue = createQueue(function (job) {
      return putJson("/plan", { plan: job.snapshot }).then(function () {
        var rev = meta.planRev || 0;
        if (rev <= job.rev) meta.planSyncedRev = rev;
        else if ((meta.planSyncedRev || 0) < job.rev) meta.planSyncedRev = job.rev;
        writeMeta();
      });
    });

    var shoppingQueue = createQueue(function (job) {
      return putJson("/shopping", { shopping: job.snapshot }).then(function () {
        var rev = meta.shoppingRev || 0;
        if (rev <= job.rev) meta.shoppingSyncedRev = rev;
        else if ((meta.shoppingSyncedRev || 0) < job.rev) meta.shoppingSyncedRev = job.rev;
        writeMeta();
      });
    });

    function savePantry(snapshot) {
      pantryEdits += 1;
      meta.pantryRev = (meta.pantryRev || 0) + 1;
      writeMeta();
      pantryQueue.push({ snapshot: copyPantry(snapshot), rev: meta.pantryRev });
    }

    function savePlan(snapshot) {
      planEdits += 1;
      meta.planRev = (meta.planRev || 0) + 1;
      writeMeta();
      planQueue.push({ snapshot: copyPlan(snapshot), rev: meta.planRev });
    }

    function saveShopping(snapshot) {
      shoppingEdits += 1;
      meta.shoppingRev = (meta.shoppingRev || 0) + 1;
      writeMeta();
      shoppingQueue.push({ snapshot: copyShopping(snapshot), rev: meta.shoppingRev });
    }

    function queuePantry(snapshot) {
      pantryQueue.push({ snapshot: copyPantry(snapshot), rev: meta.pantryRev || 0 });
    }

    function queuePlan(snapshot) {
      planQueue.push({ snapshot: copyPlan(snapshot), rev: meta.planRev || 0 });
    }

    function queueShopping(snapshot) {
      shoppingQueue.push({ snapshot: copyShopping(snapshot), rev: meta.shoppingRev || 0 });
    }

    function alignPantry() {
      var rev = (meta.pantryRev || 0) + 1;
      meta.pantryRev = rev;
      meta.pantrySyncedRev = rev;
      writeMeta();
    }

    function alignPlan() {
      var rev = (meta.planRev || 0) + 1;
      meta.planRev = rev;
      meta.planSyncedRev = rev;
      writeMeta();
    }

    function alignShopping() {
      var rev = (meta.shoppingRev || 0) + 1;
      meta.shoppingRev = rev;
      meta.shoppingSyncedRev = rev;
      writeMeta();
    }

    function hydratePantry(model) {
      if (!model || typeof model.snapshot !== "function" || typeof model.replace !== "function") {
        return Promise.resolve();
      }
      var mark = pantryEdits;
      var local = model.snapshot();
      if ((meta.pantryRev || 0) > (meta.pantrySyncedRev || 0)) {
        queuePantry(local);
        return Promise.resolve();
      }
      return getJson("/pantry")
        .then(function (body) {
          if (pantryEdits !== mark || (meta.pantryRev || 0) > (meta.pantrySyncedRev || 0)) return;
          if (body.found) {
            model.replace(body.pantry || {});
            alignPantry();
            notify("ashpaz-pantry-changed", { source: "remote" });
            return;
          }
          if (hasPantry(local)) queuePantry(local);
        })
        .catch(function () {
          /* Offline or a bad response: the localStorage pantry stays. */
        });
    }

    function hydratePlan(model) {
      if (!model || typeof model.snapshot !== "function" || typeof model.replace !== "function") {
        return Promise.resolve();
      }
      var mark = planEdits;
      var local = model.snapshot();
      if ((meta.planRev || 0) > (meta.planSyncedRev || 0)) {
        queuePlan(local);
        return Promise.resolve();
      }
      return getJson("/plan")
        .then(function (body) {
          if (planEdits !== mark || (meta.planRev || 0) > (meta.planSyncedRev || 0)) return;
          if (body.found) {
            model.replace(body.plan || {});
            alignPlan();
            notify("ashpaz-plan-changed", { source: "remote" });
            return;
          }
          if (hasPlan(local)) queuePlan(local);
        })
        .catch(function () {
          /* Offline or a bad response: the localStorage plan stays. */
        });
    }

    function hydrateShopping(model) {
      if (!model || typeof model.snapshot !== "function" || typeof model.replace !== "function") {
        return Promise.resolve();
      }
      var mark = shoppingEdits;
      var local = model.snapshot();
      if ((meta.shoppingRev || 0) > (meta.shoppingSyncedRev || 0)) {
        queueShopping(local);
        return Promise.resolve();
      }
      return getJson("/shopping")
        .then(function (body) {
          if (shoppingEdits !== mark || (meta.shoppingRev || 0) > (meta.shoppingSyncedRev || 0)) return;
          if (body.found) {
            model.replace(body.shopping || {});
            alignShopping();
            notify("ashpaz-shopping-changed", { source: "remote" });
            return;
          }
          if (hasShopping(local)) queueShopping(local);
        })
        .catch(function () {
          /* Offline or a bad response: the localStorage shopping list stays. */
        });
    }

    function flush() {
      return Promise.all([pantryQueue.flush(), planQueue.flush(), shoppingQueue.flush()]);
    }

    return {
      userId: function () {
        return userId;
      },
      savePantry: savePantry,
      savePlan: savePlan,
      saveShopping: saveShopping,
      hydrate: function (pantryModel, planModel, shoppingModel) {
        return Promise.all([
          hydratePantry(pantryModel),
          hydratePlan(planModel),
          hydrateShopping(shoppingModel),
        ]).then(flush);
      },
      flush: flush,
    };
  }

  function browserStorage() {
    var storage = null;
    try {
      if (global.localStorage) {
        var probe = "ashpaz-khoone.persist.probe";
        global.localStorage.setItem(probe, "1");
        global.localStorage.removeItem(probe);
        storage = global.localStorage;
      }
    } catch (err) {
      storage = null;
    }
    if (!storage) {
      var memory = Object.create(null);
      storage = {
        getItem: function (key) {
          return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
        },
        setItem: function (key, value) {
          memory[key] = String(value);
        },
      };
    }
    return storage;
  }

  function watchUnload(session) {
    if (!global || typeof global.addEventListener !== "function") return;
    global.addEventListener("pagehide", function () {
      session.flush();
    });
    global.addEventListener("visibilitychange", function () {
      var hidden = false;
      try {
        hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      } catch (err) {
        hidden = false;
      }
      if (hidden) session.flush();
    });
  }

  var started = false;

  function boot() {
    if (started) return;
    started = true;
    var session = createPersist({
      storage: browserStorage(),
      document: typeof document !== "undefined" ? document : null,
    });
    api.active = session;
    api.onPantry = function (snapshot) {
      session.savePantry(snapshot);
    };
    api.onPlan = function (snapshot) {
      session.savePlan(snapshot);
    };
    api.onShopping = function (snapshot) {
      session.saveShopping(snapshot);
    };
    var pantryApi = global.AshpazPantry;
    var planApi = global.AshpazPlan;
    var shopApi = global.AshpazShop;
    session.hydrate(pantryApi && pantryApi.active, planApi && planApi.active, shopApi && shopApi.active);
    watchUnload(session);
  }

  var api = {
    USER_KEY: USER_KEY,
    META_KEY: META_KEY,
    COOKIE_NAME: COOKIE_NAME,
    createPersist: createPersist,
    onPantry: null,
    onPlan: null,
    onShopping: null,
    active: null,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazPersist = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
