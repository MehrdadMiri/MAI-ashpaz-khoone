/* Seven-day dinner plan for آشپزخونه (US-06, US-07, US-10).
   Recipes already on the page can be assigned to شنبه–جمعه.
   A day can be marked خورده شد. That flag stays in localStorage with the
   plan and is how leftover regenerate knows which dinners to skip.
   When AshpazPersist is loaded, the same snapshot is also stored in Postgres.
   If that api is down, the localStorage copy is what the page keeps using.
   Print and Markdown export are client-side. This file does not call
   GapGPT and never sees the API key.
   A share link is only the week, in the URL hash (#p=). It is not this
   browser's local user id. Keys and environment values are refused.
   Opening the link replaces the plan here; Postgres then stores it under
   the reader's own id, the same way any other local edit is saved. */
(function (global) {
  "use strict";

  var STORAGE_KEY = "ashpaz-khoone.plan.v1";
  var MAX_RECIPES = 24;
  var MAX_TITLE = 120;

  var COPY = {
    title: "برنامه ۷ روزه",
    dinner: "شام",
    empty: "خالی",
    swap: "جایگزین",
    pick: "انتخاب",
    add: "افزودن",
    addToPlan: "افزودن به برنامه",
    export: "چاپ / خروجی",
    print: "چاپ",
    download: "دانلود مارک‌داون",
    share: "کپی لینک",
    shareCopied: "لینک برنامه کپی شد.",
    shareReady: "لینک آماده است. اگر کپی نشد، آن را از کادر انتخاب کنید.",
    shareOpened: "برنامه اشتراکی باز شد.",
    shareEmptyOpened: "این لینک یک برنامه خالی است. روزها «خالی» هستند.",
    shareBad: "لینک برنامه خوانده نشد. برنامه همین مرورگر سر جایش ماند.",
    emptyPlanTitle: "برنامه هفته خالی است",
    emptyPlanHelp:
      "هنوز شامی برای شنبه تا جمعه چیده نشده. لینک اشتراک و چاپ پوستر برای همین برنامه خالی هم کار می‌کنند.",
    posterRange: "هفت وعده شام، از شنبه تا جمعه",
    dayRole: "روز",
    mealRole: "وعده",
    cancel: "انصراف",
    clear: "خالی کردن",
    current: "فعلی",
    filledWeek: "شام هر روز این هفته چیده شد.",
    needRecipes: "برای چیدن برنامه، اول «پیشنهاد دستور» را بزنید.",
    weekFull: "هر هفت روز شام دارد. برای عوض کردن، «جایگزین» را بزنید.",
    noRecipes: "هنوز دستوری نیست. اول «پیشنهاد دستور» را بزنید.",
    exportHint:
      "چاپ، پوستر A4 با پس‌زمینه سفید است: نام روز، وعده شام، و نام غذا. لینک اشتراک فقط همین برنامه را باز می‌کند و کلید یا شناسه داخلی ندارد. فایل مارک‌داون فهرست روزهاست.",
    filename: "برنامه-۷-روزه.md",
    eaten: "خورده شد",
    freshIdeas: "ایده‌های تازه آماده‌اند. شام‌های خورده‌شده سر جایشان ماندند.",
    fullIdeas: "پیشنهاد کامل آماده است. شام‌های چیده‌شده سر جایشان ماندند.",
  };

  var DAYS = Object.freeze([
    Object.freeze({ id: "sat", label: "شنبه" }),
    Object.freeze({ id: "sun", label: "یکشنبه" }),
    Object.freeze({ id: "mon", label: "دوشنبه" }),
    Object.freeze({ id: "tue", label: "سه‌شنبه" }),
    Object.freeze({ id: "wed", label: "چهارشنبه" }),
    Object.freeze({ id: "thu", label: "پنجشنبه" }),
    Object.freeze({ id: "fri", label: "جمعه" }),
  ]);

  function createMemoryStorage() {
    var data = Object.create(null);
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function (key, value) {
        data[key] = String(value);
      },
      removeItem: function (key) {
        delete data[key];
      },
    };
  }

  function displayName(value) {
    var pantryApi = global.AshpazPantry;
    if (pantryApi && typeof pantryApi.displayName === "function") return pantryApi.displayName(value);
    return String(value || "")
      .replace(/[\u200e\u200f]/g, "")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[ةۀ]/g, "ه")
      .replace(/\u0640/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function identityKey(value) {
    var pantryApi = global.AshpazPantry;
    if (pantryApi && typeof pantryApi.identityKey === "function") return pantryApi.identityKey(value);
    return displayName(value)
      .replace(/[\u200c\u200d]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function toPersianDigits(value) {
    return String(value).replace(/\d/g, function (digit) {
      return "۰۱۲۳۴۵۶۷۸۹"[Number(digit)];
    });
  }

  function formatToman(value) {
    var grouped = String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u066c");
    return toPersianDigits(grouped) + " تومان";
  }

  function formatApprox(value) {
    var recipesApi = global.AshpazRecipes;
    if (recipesApi && typeof recipesApi.formatCostToman === "function") {
      var formatted = recipesApi.formatCostToman(value);
      if (formatted) return formatted;
    }
    if (typeof value !== "number" || !isFinite(value) || value <= 0) return "";
    return "حدود " + formatToman(value);
  }

  function cleanLine(value, limit) {
    if (typeof value !== "string") return "";
    var text = value
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    if (text.length > limit) text = text.slice(0, limit).trim();
    return text;
  }

  function cleanList(value, maxItems, itemLimit) {
    if (!Array.isArray(value)) return [];
    var items = [];
    for (var i = 0; i < value.length && items.length < maxItems; i += 1) {
      var text = cleanLine(value[i], itemLimit);
      if (text) items.push(text);
    }
    return items;
  }

  function dayById(dayId) {
    for (var i = 0; i < DAYS.length; i += 1) {
      if (DAYS[i].id === dayId) return DAYS[i];
    }
    return null;
  }

  function emptySlots() {
    var slots = {};
    DAYS.forEach(function (day) {
      slots[day.id] = null;
    });
    return slots;
  }

  function emptyUsed() {
    var used = {};
    DAYS.forEach(function (day) {
      used[day.id] = false;
    });
    return used;
  }

  function lineUsesChip(chip, line) {
    var shopApi = global.AshpazShop;
    if (shopApi && typeof shopApi.lineUsesChip === "function") {
      return !!shopApi.lineUsesChip(chip, line);
    }
    var chipKey = identityKey(chip);
    var lineKey = identityKey(line);
    if (!chipKey || chipKey.length < 2 || !lineKey) return false;
    return lineKey.indexOf(chipKey) !== -1;
  }

  function normalizeRecipe(recipe) {
    if (!recipe || typeof recipe !== "object") return null;
    var title = displayName(cleanLine(recipe.title, MAX_TITLE));
    var key = identityKey(title);
    if (!title || !key) return null;
    var cost = null;
    if (typeof recipe.cost_toman === "number" && isFinite(recipe.cost_toman) && recipe.cost_toman >= 0) {
      cost = Math.round(recipe.cost_toman);
    }
    return {
      id: "r:" + key,
      title: title,
      ingredients: cleanList(recipe.ingredients, 16, 80),
      steps: cleanList(recipe.steps, 12, 400),
      cost_toman: cost,
    };
  }

  function copyRecipe(recipe) {
    return {
      id: recipe.id,
      title: recipe.title,
      ingredients: recipe.ingredients.slice(),
      steps: recipe.steps.slice(),
      cost_toman: recipe.cost_toman,
    };
  }

  function budgetLine(spent, budget) {
    if (typeof spent !== "number" || !isFinite(spent) || spent <= 0) return null;
    var hasBudget = typeof budget === "number" && isFinite(budget) && budget >= 0;
    var over = !!(hasBudget && spent > budget);
    var text = "جمع شام‌ها " + formatApprox(spent);
    if (hasBudget) text += " از بودجه " + formatToman(budget);
    if (over) text += " — بیشتر از بودجه هفته. چاپ و خروجی همچنان ممکن است";
    return { text: text, over: over };
  }

  function markdownDocument(week, note) {
    var lines = ["# " + COPY.title, ""];
    week.forEach(function (day) {
      var meal = day.recipe ? day.recipe.title : COPY.empty;
      if (day.recipe && day.used) meal += " — " + COPY.eaten;
      if (day.recipe && typeof day.recipe.cost_toman === "number" && day.recipe.cost_toman > 0) {
        var cost = formatApprox(day.recipe.cost_toman);
        if (cost) meal += " — " + cost;
      }
      lines.push("- **" + day.label + ":** " + meal);
    });
    lines.push("");
    if (note && note.text) {
      lines.push(note.text);
      lines.push("");
    }
    return lines.join("\n");
  }

  /* Same key persist.js uses for unsynced edits. A shared week is a local
     edit so GET /plan does not paint over it before this browser saves. */
  var SYNC_META_KEY = "ashpaz-khoone.sync.v1";
  var SHARE_VERSION = 1;
  var SHARE_TOKEN_MAX = 24000;

  var FORBIDDEN_KEY = /(api[_-]?key|authorization|token|secret|password|passwd|local[_-]?user|gap[_-]?code|postgres|credential|^env$)/i;
  var SECRET_TEXT = /GAP_CODE|POSTGRES_|api[_-]?key|local[_-]?user[_-]?id|bearer\s+|password\s*[:=]|secret\s*[:=]/i;

  function containsSecret(value, depth) {
    if (depth > 8) return true;
    if (typeof value === "string") return SECRET_TEXT.test(value);
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        if (containsSecret(value[i], depth + 1)) return true;
      }
      return false;
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k += 1) {
      if (FORBIDDEN_KEY.test(keys[k])) return true;
      if (containsSecret(value[keys[k]], depth + 1)) return true;
    }
    return false;
  }

  function safeText(value, limit) {
    var text = cleanLine(value, limit);
    if (!text || SECRET_TEXT.test(text)) return "";
    return text;
  }

  function safeList(value, maxItems, itemLimit) {
    return cleanList(value, maxItems, itemLimit).filter(function (item) {
      return !SECRET_TEXT.test(item);
    });
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder === "function") {
      var encoded = new TextEncoder().encode(text);
      var bytes = [];
      for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded[i]);
      return bytes;
    }
    var escaped = encodeURIComponent(text);
    var fallback = [];
    for (var j = 0; j < escaped.length; j += 1) {
      if (escaped.charAt(j) === "%") {
        fallback.push(parseInt(escaped.slice(j + 1, j + 3), 16));
        j += 2;
      } else {
        fallback.push(escaped.charCodeAt(j));
      }
    }
    return fallback;
  }

  function bytesToString(bytes) {
    if (typeof TextDecoder === "function") {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    }
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function base64UrlEncode(text) {
    var bytes = utf8Bytes(text);
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      var n = (b0 << 16) | (b1 << 8) | b2;
      out += B64.charAt((n >> 18) & 63);
      out += B64.charAt((n >> 12) & 63);
      if (i + 1 < bytes.length) out += B64.charAt((n >> 6) & 63);
      if (i + 2 < bytes.length) out += B64.charAt(n & 63);
    }
    return out;
  }

  function base64UrlDecode(token) {
    var map = Object.create(null);
    for (var i = 0; i < B64.length; i += 1) map[B64.charAt(i)] = i;
    var bytes = [];
    for (var j = 0; j < token.length; j += 4) {
      var c0 = map[token.charAt(j)];
      var c1 = map[token.charAt(j + 1)];
      var has2 = j + 2 < token.length;
      var has3 = j + 3 < token.length;
      var c2 = has2 ? map[token.charAt(j + 2)] : 0;
      var c3 = has3 ? map[token.charAt(j + 3)] : 0;
      if (c0 == null || c1 == null || (has2 && c2 == null) || (has3 && c3 == null)) {
        throw new Error("token");
      }
      var n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
      bytes.push((n >> 16) & 255);
      if (has2) bytes.push((n >> 8) & 255);
      if (has3) bytes.push(n & 255);
    }
    return bytesToString(bytes);
  }

  function recipeBySlot(snapshot, slotId) {
    if (!slotId || !snapshot || !Array.isArray(snapshot.recipes)) return null;
    for (var i = 0; i < snapshot.recipes.length; i += 1) {
      var recipe = snapshot.recipes[i];
      if (!recipe || typeof recipe !== "object") continue;
      var title = safeText(recipe.title, MAX_TITLE);
      if (!title) continue;
      var id = typeof recipe.id === "string" && recipe.id ? recipe.id : "r:" + identityKey(title);
      if (id === slotId) return recipe;
    }
    return null;
  }

  function compactShare(snapshot) {
    var days = [];
    var source = snapshot && typeof snapshot === "object" ? snapshot : {};
    DAYS.forEach(function (day) {
      var slotId = source.slots && typeof source.slots[day.id] === "string" ? source.slots[day.id] : "";
      var recipe = recipeBySlot(source, slotId);
      if (!recipe) return;
      var title = safeText(recipe.title, MAX_TITLE);
      if (!title) return;
      var row = { id: day.id, title: title };
      var cost = recipe.cost_toman;
      if (typeof cost === "number" && isFinite(cost) && cost > 0) row.cost = Math.round(cost);
      if (source.used && source.used[day.id] === true) row.used = true;
      var ingredients = safeList(recipe.ingredients, 16, 80);
      var steps = safeList(recipe.steps, 12, 400);
      if (ingredients.length) row.ingredients = ingredients;
      if (steps.length) row.steps = steps;
      if (containsSecret(row)) return;
      days.push(row);
    });
    return { v: SHARE_VERSION, days: days };
  }

  function shrinkShare(body) {
    var json = JSON.stringify(body);
    if (json.length <= 6000) return json;
    body.days.forEach(function (day) {
      delete day.steps;
    });
    json = JSON.stringify(body);
    if (json.length <= 6000) return json;
    body.days.forEach(function (day) {
      delete day.ingredients;
    });
    return JSON.stringify(body);
  }

  function encodeShare(snapshot) {
    var body = compactShare(snapshot);
    var json = shrinkShare(body);
    if (SECRET_TEXT.test(json) || containsSecret(JSON.parse(json))) {
      json = JSON.stringify({ v: SHARE_VERSION, days: [] });
    }
    return base64UrlEncode(json);
  }

  function planFromShare(parsed) {
    var recipes = [];
    var slots = emptySlots();
    var used = emptyUsed();
    if (!parsed || parsed.v !== SHARE_VERSION || !Array.isArray(parsed.days)) {
      return { recipes: recipes, slots: slots, used: used };
    }
    parsed.days.forEach(function (row) {
      if (!row || typeof row !== "object" || containsSecret(row)) return;
      var day = dayById(typeof row.id === "string" ? row.id : "");
      if (!day) return;
      var recipe = normalizeRecipe({
        title: row.title,
        ingredients: row.ingredients,
        steps: row.steps,
        cost_toman: row.cost,
      });
      if (!recipe) return;
      var known = false;
      for (var i = 0; i < recipes.length; i += 1) {
        if (recipes[i].id === recipe.id) known = true;
      }
      if (!known) recipes.push(recipe);
      slots[day.id] = recipe.id;
      used[day.id] = row.used === true;
    });
    return { recipes: recipes, slots: slots, used: used };
  }

  function decodeShare(token) {
    if (typeof token !== "string") return { ok: false, reason: "token" };
    var raw = token.replace(/\s+/g, "");
    if (!raw || raw.length > SHARE_TOKEN_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) {
      return { ok: false, reason: raw && raw.length > SHARE_TOKEN_MAX ? "size" : "token" };
    }
    var json;
    try {
      json = base64UrlDecode(raw);
    } catch (err) {
      return { ok: false, reason: "token" };
    }
    if (!json || json.length > SHARE_TOKEN_MAX * 2 || SECRET_TEXT.test(json)) {
      return { ok: false, reason: SECRET_TEXT.test(json) ? "secret" : "size" };
    }
    var parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err2) {
      return { ok: false, reason: "token" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "token" };
    }
    if (containsSecret(parsed) || parsed.v !== SHARE_VERSION || !Array.isArray(parsed.days)) {
      return { ok: false, reason: containsSecret(parsed) ? "secret" : "token" };
    }
    var plan = planFromShare(parsed);
    if (containsSecret(plan)) return { ok: false, reason: "secret" };
    var empty = true;
    DAYS.forEach(function (day) {
      if (plan.slots[day.id]) empty = false;
    });
    return { ok: true, empty: empty, plan: plan };
  }

  function shareHref(loc, token) {
    var origin = "";
    var path = "/";
    if (loc && typeof loc === "object") {
      if (typeof loc.origin === "string" && loc.origin && loc.origin !== "null") origin = loc.origin;
      if (typeof loc.pathname === "string" && loc.pathname.charAt(0) === "/") path = loc.pathname;
    }
    var href = origin + path;
    if (!token) return href;
    return href + "#p=" + token;
  }

  function shareTokenFromLocation(loc) {
    if (!loc || typeof loc.hash !== "string") return "";
    var hash = loc.hash.charAt(0) === "#" ? loc.hash.slice(1) : loc.hash;
    if (!hash) return "";
    var pieces = hash.split("&");
    for (var i = 0; i < pieces.length; i += 1) {
      var piece = pieces[i];
      var eq = piece.indexOf("=");
      var key = eq === -1 ? piece : piece.slice(0, eq);
      if (key !== "p") continue;
      var raw = eq === -1 ? "" : piece.slice(eq + 1);
      try {
        return decodeURIComponent(raw.replace(/\+/g, " "));
      } catch (err) {
        return "";
      }
    }
    return "";
  }

  function clearShareHash(loc) {
    if (!loc) return;
    try {
      loc.hash = "";
    } catch (err) {
      /* The week is already loaded. A leftover hash is only a nuisance. */
    }
    var history = global.history;
    if (!history || typeof history.replaceState !== "function") return;
    var path = loc.pathname && typeof loc.pathname === "string" && loc.pathname.charAt(0) === "/" ? loc.pathname : "/";
    var search = typeof loc.search === "string" ? loc.search : "";
    if (SECRET_TEXT.test(search) || FORBIDDEN_KEY.test(search) || /local_user_id/i.test(search)) search = "";
    try {
      history.replaceState(null, "", path + search);
    } catch (err2) {
      /* The hash property was already cleared when the browser allowed it. */
    }
  }

  function markPlanAhead(storage) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return;
    var meta = { pantryRev: 0, pantrySyncedRev: 0, planRev: 0, planSyncedRev: 0 };
    try {
      var raw = storage.getItem(SYNC_META_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          ["pantryRev", "pantrySyncedRev", "planRev", "planSyncedRev"].forEach(function (key) {
            var value = parsed[key];
            if (typeof value === "number" && isFinite(value) && value >= 0) meta[key] = Math.floor(value);
          });
        }
      }
    } catch (err) {
      meta = { pantryRev: 0, pantrySyncedRev: 0, planRev: 0, planSyncedRev: 0 };
    }
    meta.planRev = Math.max(meta.planRev, meta.planSyncedRev) + 1;
    try {
      storage.setItem(SYNC_META_KEY, JSON.stringify(meta));
    } catch (err2) {
      /* The week is in the plan key. A later edit can sync it. */
    }
  }

  function posterOutline(week) {
    var list = Array.isArray(week) ? week : [];
    var days = list.map(function (day) {
      var hasMeal = !!(day && day.recipe && day.recipe.title);
      return {
        id: day && day.id ? day.id : "",
        dayRole: COPY.dayRole,
        dayLabel: day && day.label ? day.label : "",
        mealRole: COPY.mealRole,
        mealLabel: COPY.dinner,
        title: hasMeal ? day.recipe.title : COPY.empty,
        empty: !hasMeal,
        eaten: !!(hasMeal && day.used),
      };
    });
    var filled = days.some(function (day) {
      return !day.empty;
    });
    return {
      brand: "آشپزخونه",
      title: COPY.title,
      range: COPY.posterRange,
      empty: !filled,
      emptyTitle: COPY.emptyPlanTitle,
      emptyHelp: COPY.emptyPlanHelp,
      days: days,
    };
  }

  function createPlan(options) {
    var storage = options && options.storage;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      storage = createMemoryStorage();
    }

    var state = load();

    function load() {
      try {
        var raw = storage.getItem(STORAGE_KEY);
        if (!raw) return { recipes: [], slots: emptySlots(), used: emptyUsed() };
        return sanitize(JSON.parse(raw));
      } catch (err) {
        return { recipes: [], slots: emptySlots(), used: emptyUsed() };
      }
    }

    function planSnapshot() {
      return {
        recipes: state.recipes.map(copyRecipe),
        slots: Object.assign({}, state.slots),
        used: Object.assign({}, state.used),
      };
    }

    function writeLocal() {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(planSnapshot()));
      } catch (err) {
        /* Quota or privacy mode: keep the in-memory plan for this visit. */
      }
    }

    function notifyRemote() {
      var remote = global.AshpazPersist;
      if (!remote || typeof remote.onPlan !== "function") return;
      try {
        remote.onPlan(planSnapshot());
      } catch (err) {
        /* The local plan is already saved. A later load can try the api again. */
      }
    }

    function persist() {
      writeLocal();
      notifyRemote();
    }

    function find(id) {
      for (var i = 0; i < state.recipes.length; i += 1) {
        if (state.recipes[i].id === id) return state.recipes[i];
      }
      return null;
    }

    function sanitize(parsed) {
      var next = { recipes: [], slots: emptySlots(), used: emptyUsed() };
      if (!parsed || typeof parsed !== "object") return next;
      var seen = Object.create(null);
      if (Array.isArray(parsed.recipes)) {
        parsed.recipes.forEach(function (item) {
          var recipe = normalizeRecipe(item);
          if (!recipe || seen[recipe.id]) return;
          seen[recipe.id] = recipe;
          next.recipes.push(recipe);
        });
      }
      DAYS.forEach(function (day) {
        var id = parsed.slots && typeof parsed.slots[day.id] === "string" ? parsed.slots[day.id] : "";
        next.slots[day.id] = seen[id] ? id : null;
        var flagged = parsed.used && parsed.used[day.id] === true;
        next.used[day.id] = !!(next.slots[day.id] && flagged);
      });
      return next;
    }

    function prune() {
      if (state.recipes.length <= MAX_RECIPES) return;
      var assigned = Object.create(null);
      DAYS.forEach(function (day) {
        if (state.slots[day.id]) assigned[state.slots[day.id]] = true;
      });
      var kept = [];
      var rest = [];
      state.recipes.forEach(function (recipe) {
        if (assigned[recipe.id]) kept.push(recipe);
        else rest.push(recipe);
      });
      var room = MAX_RECIPES - kept.length;
      if (room < 0) room = 0;
      if (rest.length > room) rest = rest.slice(rest.length - room);
      state.recipes = kept.concat(rest);
    }

    function upsert(recipe) {
      var existing = find(recipe.id);
      if (existing) {
        existing.title = recipe.title;
        existing.ingredients = recipe.ingredients;
        existing.steps = recipe.steps;
        existing.cost_toman = recipe.cost_toman;
        return existing;
      }
      state.recipes.push(recipe);
      return recipe;
    }

    function week() {
      return DAYS.map(function (day) {
        var recipe = find(state.slots[day.id]);
        return {
          id: day.id,
          label: day.label,
          used: !!state.used[day.id],
          recipe: recipe ? copyRecipe(recipe) : null,
        };
      });
    }

    function spend() {
      var total = 0;
      week().forEach(function (day) {
        if (day.recipe && typeof day.recipe.cost_toman === "number" && day.recipe.cost_toman > 0) {
          total += day.recipe.cost_toman;
        }
      });
      return total;
    }

    return {
      recipes: function () {
        return state.recipes.map(copyRecipe);
      },
      week: week,
      spend: spend,
      remember: function (list) {
        if (!Array.isArray(list)) return [];
        var accepted = [];
        var changed = false;
        var seen = Object.create(null);
        list.forEach(function (item) {
          var recipe = normalizeRecipe(item);
          if (!recipe || seen[recipe.id]) return;
          seen[recipe.id] = true;
          upsert(recipe);
          changed = true;
          accepted.push(recipe.id);
        });
        if (!changed) return [];
        prune();
        persist();
        return accepted
          .map(function (id) {
            var live = find(id);
            return live ? copyRecipe(live) : null;
          })
          .filter(function (recipe) {
            return !!recipe;
          });
      },
      assign: function (dayId, recipeOrId) {
        var day = dayById(dayId);
        if (!day) return { ok: false, reason: "day" };
        var recipe = null;
        if (typeof recipeOrId === "string") {
          recipe = find(recipeOrId);
        } else {
          var normalized = normalizeRecipe(recipeOrId);
          if (!normalized) return { ok: false, reason: "recipe" };
          upsert(normalized);
          recipe = find(normalized.id);
        }
        if (!recipe) return { ok: false, reason: "recipe" };
        var previous = state.slots[day.id];
        state.slots[day.id] = recipe.id;
        if (previous !== recipe.id) state.used[day.id] = false;
        prune();
        persist();
        return {
          ok: true,
          dayId: day.id,
          label: day.label,
          recipe: copyRecipe(recipe),
          replaced: !!(previous && previous !== recipe.id),
        };
      },
      clearDay: function (dayId) {
        var day = dayById(dayId);
        if (!day) return { ok: false, reason: "day" };
        var had = !!state.slots[day.id];
        state.slots[day.id] = null;
        state.used[day.id] = false;
        if (had) persist();
        return { ok: true, dayId: day.id, label: day.label, cleared: had };
      },
      fillEmpty: function () {
        if (!state.recipes.length) return { filled: 0 };
        var cursor = 0;
        var filled = 0;
        DAYS.forEach(function (day) {
          if (state.slots[day.id]) return;
          state.slots[day.id] = state.recipes[cursor % state.recipes.length].id;
          cursor += 1;
          filled += 1;
        });
        if (filled) persist();
        return { filled: filled };
      },
      markdown: function (budget) {
        return markdownDocument(week(), budgetLine(spend(), budget));
      },
      setUsed: function (dayId, eaten) {
        var day = dayById(dayId);
        if (!day) return { ok: false, reason: "day" };
        if (!state.slots[day.id]) return { ok: false, reason: "empty" };
        state.used[day.id] = !!eaten;
        persist();
        var recipe = find(state.slots[day.id]);
        return {
          ok: true,
          dayId: day.id,
          label: day.label,
          used: !!state.used[day.id],
          title: recipe ? recipe.title : "",
        };
      },
      usedTitles: function () {
        var titles = [];
        var seen = Object.create(null);
        week().forEach(function (day) {
          if (!day.used || !day.recipe || !day.recipe.title) return;
          var key = identityKey(day.recipe.title);
          if (!key || seen[key]) return;
          seen[key] = true;
          titles.push(day.recipe.title);
        });
        return titles;
      },
      snapshot: function () {
        return planSnapshot();
      },
      replace: function (parsed) {
        state = sanitize(parsed);
        writeLocal();
        return planSnapshot();
      },
      applyShare: function (token) {
        var decoded = decodeShare(token);
        if (!decoded.ok) return { ok: false, reason: decoded.reason || "token" };
        state = sanitize(decoded.plan);
        writeLocal();
        markPlanAhead(storage);
        notifyRemote();
        var empty = week().every(function (day) {
          return !day.recipe;
        });
        return { ok: true, empty: empty };
      },
      remainingChips: function (pantryItems) {
        var items = Array.isArray(pantryItems) ? pantryItems.slice() : [];
        var lines = [];
        week().forEach(function (day) {
          if (!day.used || !day.recipe || !Array.isArray(day.recipe.ingredients)) return;
          day.recipe.ingredients.forEach(function (line) {
            if (typeof line === "string" && line) lines.push(line);
          });
        });
        if (!lines.length) return items;
        return items.filter(function (chip) {
          for (var i = 0; i < lines.length; i += 1) {
            if (lineUsesChip(chip, lines[i])) return false;
          }
          return true;
        });
      },
    };
  }

  function normalizeBudget(raw) {
    if (raw === "" || raw == null) return null;
    var value = Number(raw);
    if (!isFinite(value) || value < 0) return null;
    return value;
  }

  function readBudget(hooks) {
    if (hooks && typeof hooks.budget === "function") return normalizeBudget(hooks.budget());
    var pantryApi = global.AshpazPantry;
    var pantry = pantryApi && pantryApi.active;
    if (!pantry || typeof pantry.budget !== "function") return null;
    return normalizeBudget(pantry.budget());
  }

  function currentLatest(hooks) {
    if (hooks && typeof hooks.latest === "function") {
      var injected = hooks.latest();
      return Array.isArray(injected) ? injected : [];
    }
    var recipesApi = global.AshpazRecipes;
    var latest = recipesApi && recipesApi.latestRecipes;
    return Array.isArray(latest) ? latest : [];
  }

  function matchTestId(node, testid) {
    var current = node;
    while (current) {
      if (current.dataset && current.dataset.testid === testid) return current;
      current = current.parentNode || current.parentElement || null;
    }
    return null;
  }

  function nodeValue(node, datasetKey, attrName) {
    if (!node) return "";
    if (node.dataset && node.dataset[datasetKey] != null && node.dataset[datasetKey] !== "") {
      return String(node.dataset[datasetKey]);
    }
    if (node.getAttribute) {
      var attr = node.getAttribute(attrName);
      if (attr != null) return String(attr);
    }
    return "";
  }

  function renderWeek(doc, grid, plan) {
    var cards = plan.week().map(function (day) {
      var article = doc.createElement("article");
      article.className =
        "day-card " + (day.recipe ? "is-filled" : "is-empty") + (day.used ? " is-used" : "");
      article.dataset.testid = "day-card";
      article.dataset.day = day.id;
      article.dataset.used = day.used ? "true" : "false";
      article.setAttribute("data-day", day.id);

      var name = doc.createElement("h3");
      name.className = "day-name";
      name.dataset.testid = "day-name";
      name.textContent = day.label;

      var kicker = doc.createElement("p");
      kicker.className = "day-kicker";
      kicker.textContent = COPY.dinner;

      var meal = doc.createElement("p");
      meal.className = "day-meal";
      meal.dataset.testid = "day-meal";
      meal.textContent = day.recipe
        ? day.recipe.title + (day.used ? " — " + COPY.eaten : "")
        : COPY.empty;

      article.append(name, kicker, meal);

      if (day.recipe && typeof day.recipe.cost_toman === "number" && day.recipe.cost_toman > 0) {
        var costLabel = formatApprox(day.recipe.cost_toman);
        if (costLabel) {
          var cost = doc.createElement("p");
          cost.className = "day-cost";
          cost.dataset.testid = "day-cost";
          cost.textContent = costLabel;
          article.append(cost);
        }
      }

      var action = doc.createElement("button");
      action.type = "button";
      action.className = "day-action";
      action.dataset.testid = day.recipe ? "day-swap" : "day-pick";
      action.dataset.day = day.id;
      action.setAttribute("data-day", day.id);
      action.setAttribute("aria-haspopup", "dialog");
      action.setAttribute("aria-controls", "plan-sheet");
      action.textContent = day.recipe ? COPY.swap : COPY.pick;
      action.setAttribute(
        "aria-label",
        (day.recipe ? COPY.swap : COPY.pick) + " " + COPY.dinner + " " + day.label
      );
      article.append(action);

      if (day.recipe) {
        var eaten = doc.createElement("button");
        eaten.type = "button";
        eaten.className = "day-eaten" + (day.used ? " is-on" : "");
        eaten.dataset.testid = "day-eaten";
        eaten.dataset.day = day.id;
        eaten.setAttribute("data-day", day.id);
        eaten.setAttribute("aria-pressed", day.used ? "true" : "false");
        eaten.textContent = COPY.eaten;
        eaten.setAttribute(
          "aria-label",
          day.used
            ? "شام " + day.label + " خورده شد. برای برگرداندن بزنید."
            : "علامت خورده شد برای شام " + day.label
        );
        article.append(eaten);
      }
      return article;
    });
    grid.replaceChildren.apply(grid, cards);
  }

  function choiceRow(doc, choice) {
    var button = doc.createElement("button");
    button.type = "button";
    button.className = "plan-choice";
    button.dataset.testid = "plan-choice";
    button.dataset.choice = choice.id;
    button.setAttribute("data-choice", choice.id);

    var label = doc.createElement("span");
    label.className = "plan-choice-label";
    label.textContent = choice.label;
    button.append(label);

    if (choice.detail) {
      var detail = doc.createElement("span");
      detail.className = "plan-choice-detail";
      detail.textContent = choice.detail;
      button.append(detail);
    }
    if (choice.action) {
      var action = doc.createElement("span");
      action.className = "plan-choice-action";
      action.textContent = choice.action;
      button.append(action);
    }

    var li = doc.createElement("li");
    li.append(button);
    return li;
  }

  function saveMarkdown(doc, filename, text) {
    var BlobCtor = global.Blob;
    var urlApi = global.URL || global.webkitURL;
    if (!doc || !BlobCtor || !urlApi || typeof urlApi.createObjectURL !== "function") return;
    var blob = new BlobCtor([text], { type: "text/markdown;charset=utf-8" });
    var url = urlApi.createObjectURL(blob);
    var link = doc.createElement("a");
    link.href = url;
    link.download = filename;
    if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(link);
    if (typeof link.click === "function") link.click();
    if (typeof link.remove === "function") link.remove();
    else if (link.parentNode && typeof link.parentNode.removeChild === "function") {
      link.parentNode.removeChild(link);
    }
    urlApi.revokeObjectURL(url);
  }

  function setPrintMode(doc, mode) {
    var body = doc && doc.body;
    if (body && body.dataset) body.dataset.print = mode || "";
  }

  function watchPrintEnd(doc) {
    var view = doc && doc.defaultView;
    if (!view || typeof view.addEventListener !== "function" || view.__ashpazPrintWatch) return;
    view.__ashpazPrintWatch = true;
    view.addEventListener("afterprint", function () {
      setPrintMode(doc, "");
    });
  }

  function emitPlan(doc) {
    if (!doc || typeof doc.dispatchEvent !== "function") return;
    var event;
    try {
      event =
        typeof CustomEvent === "function"
          ? new CustomEvent("ashpaz-plan-changed")
          : { type: "ashpaz-plan-changed" };
    } catch (err) {
      event = { type: "ashpaz-plan-changed" };
    }
    try {
      doc.dispatchEvent(event);
    } catch (err2) {
      /* The week is already saved. Opening مواد خرید reads it again. */
    }
  }

  function mount(doc, plan, hooks) {
    hooks = hooks || {};
    var incoming = hooks.shared || null;
    if (!hooks.shared && hooks.location && plan && typeof plan.applyShare === "function") {
      incoming = consumeShareLocation(plan, hooks.location) || incoming;
    }
    var grid = doc.getElementById("week-grid");
    var sheet = doc.getElementById("plan-sheet");
    var titleEl = doc.getElementById("plan-sheet-title");
    var hintEl = doc.getElementById("plan-sheet-hint");
    var list = doc.getElementById("plan-sheet-list");
    var status = doc.getElementById("plan-status");
    var budgetEl = doc.getElementById("plan-budget");
    var buildBtn = doc.getElementById("build-plan");
    var exportBtn = doc.getElementById("plan-export");
    var shareBtn = doc.getElementById("plan-share");
    var shareBox = doc.getElementById("plan-share-box");
    var shareInput = doc.getElementById("plan-share-url");
    var closeBtn = doc.getElementById("plan-sheet-close");
    var cancelBtn = doc.getElementById("plan-sheet-cancel");
    var budgetInput = doc.getElementById("week-budget");
    if (!grid || !sheet || !titleEl || !list || !plan) return;

    var onChoice = null;

    function setStatus(message) {
      if (status) status.textContent = message || "";
    }

    function renderBudget() {
      if (!budgetEl) return;
      var note = budgetLine(plan.spend(), readBudget(hooks));
      if (!note) {
        budgetEl.hidden = true;
        budgetEl.textContent = "";
        if (budgetEl.classList) budgetEl.classList.toggle("is-over", false);
        return;
      }
      budgetEl.hidden = false;
      budgetEl.textContent = note.text;
      if (budgetEl.classList) budgetEl.classList.toggle("is-over", note.over);
    }

    function renderEmpty() {
      var banner = doc.getElementById("plan-empty");
      if (!banner) return;
      var filled = plan.week().some(function (day) {
        return !!(day && day.recipe);
      });
      banner.hidden = filled;
    }

    function render() {
      renderWeek(doc, grid, plan);
      renderEmpty();
      renderBudget();
      emitPlan(doc);
    }

    function reveal() {
      var section = doc.getElementById("plan");
      if (!section || typeof section.scrollIntoView !== "function") return;
      try {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        section.scrollIntoView();
      }
    }

    function closeSheet() {
      sheet.hidden = true;
      if (sheet.dataset) sheet.dataset.mode = "";
      onChoice = null;
    }

    function openSheet(opts) {
      titleEl.textContent = opts.title;
      if (hintEl) {
        hintEl.textContent = opts.hint || "";
        hintEl.hidden = !opts.hint;
      }
      var rows = (opts.choices || []).map(function (choice) {
        return choiceRow(doc, choice);
      });
      list.replaceChildren.apply(list, rows);
      onChoice = typeof opts.onChoice === "function" ? opts.onChoice : null;
      if (sheet.dataset) sheet.dataset.mode = opts.mode || "";
      if (shareBox) shareBox.hidden = !opts.share;
      if (opts.share) fillShareField();
      sheet.hidden = false;
      if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    }

    function syncLatest() {
      var latest = currentLatest(hooks);
      if (latest.length) plan.remember(latest);
    }

    function openAssign(recipe) {
      syncLatest();
      var accepted = plan.remember([recipe]);
      var normalized = accepted[0];
      if (!normalized) return;
      var choices = plan.week().map(function (day) {
        var same = day.recipe && day.recipe.id === normalized.id;
        var action = COPY.add;
        if (same) action = COPY.current;
        else if (day.recipe) action = COPY.swap;
        return {
          id: day.id,
          label: day.label,
          detail: day.recipe ? day.recipe.title : COPY.empty,
          action: action,
        };
      });
      openSheet({
        mode: "assign",
        title: COPY.addToPlan,
        hint: "«" + normalized.title + "» را برای کدام روز می‌خواهید؟",
        choices: choices,
        onChoice: function (dayId) {
          var result = plan.assign(dayId, normalized.id);
          render();
          reveal();
          if (!result.ok) return;
          if (result.replaced) setStatus("شام " + result.label + " جایگزین شد.");
          else setStatus("«" + result.recipe.title + "» برای " + result.label + " ثبت شد.");
        },
      });
    }

    function openSwap(dayId) {
      syncLatest();
      var day = null;
      plan.week().forEach(function (item) {
        if (item.id === dayId) day = item;
      });
      if (!day) return;
      var recipes = plan.recipes();
      if (!recipes.length) {
        openSheet({
          mode: "swap",
          title: day.recipe ? COPY.swap : COPY.pick,
          hint: COPY.noRecipes,
          choices: [],
          onChoice: function () {},
        });
        return;
      }
      var choices = recipes.map(function (recipe) {
        var same = day.recipe && day.recipe.id === recipe.id;
        var detail = "";
        if (!same && recipe.cost_toman) detail = formatApprox(recipe.cost_toman);
        return {
          id: recipe.id,
          label: recipe.title,
          detail: same ? COPY.current : detail,
          action: same ? COPY.current : COPY.swap,
        };
      });
      if (day.recipe) {
        choices.push({ id: "clear", label: COPY.empty, detail: "", action: COPY.clear });
      }
      openSheet({
        mode: "swap",
        title: day.recipe ? COPY.swap : COPY.pick,
        hint: day.recipe
          ? "شام " + day.label + " را عوض کنید."
          : "برای شام " + day.label + " یک غذا انتخاب کنید.",
        choices: choices,
        onChoice: function (choice) {
          if (choice === "clear") {
            var cleared = plan.clearDay(dayId);
            render();
            if (cleared.ok) setStatus("شام " + cleared.label + " خالی شد.");
            return;
          }
          var result = plan.assign(dayId, choice);
          render();
          if (!result.ok) return;
          if (result.replaced) setStatus("شام " + result.label + " جایگزین شد.");
          else setStatus("«" + result.recipe.title + "» برای " + result.label + " ثبت شد.");
        },
      });
    }

    function doPrint() {
      setPrintMode(doc, "plan");
      if (typeof hooks.print === "function") {
        hooks.print();
        return;
      }
      var view = doc.defaultView;
      if (view && typeof view.print === "function") view.print();
      else if (typeof global.print === "function") global.print();
    }

    function doDownload() {
      var text = plan.markdown(readBudget(hooks));
      if (typeof hooks.download === "function") {
        hooks.download(text, COPY.filename);
        return;
      }
      saveMarkdown(doc, COPY.filename, text);
    }

    function pageLocation() {
      if (hooks.location) return hooks.location;
      try {
        if (global.location && typeof global.location.pathname === "string") return global.location;
      } catch (err) {
        /* Tests and locked-down pages still get a path-only link. */
      }
      return null;
    }

    function fillShareField() {
      var href = shareHref(pageLocation(), encodeShare(plan.snapshot()));
      if (shareInput) {
        shareInput.value = href;
        if (typeof shareInput.setAttribute === "function") shareInput.setAttribute("value", href);
      }
      return href;
    }

    function selectCopy(text) {
      if (!doc || typeof doc.createElement !== "function" || !doc.body) return false;
      if (typeof doc.execCommand !== "function") return false;
      var area = doc.createElement("textarea");
      area.value = text;
      if (typeof area.setAttribute === "function") area.setAttribute("readonly", "readonly");
      if (typeof doc.body.appendChild === "function") doc.body.appendChild(area);
      var ok = false;
      try {
        if (typeof area.select === "function") area.select();
        ok = !!doc.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      if (typeof area.remove === "function") area.remove();
      else if (area.parentNode && typeof area.parentNode.removeChild === "function") {
        area.parentNode.removeChild(area);
      }
      return ok;
    }

    function copyText(text, done) {
      if (hooks && typeof hooks.copy === "function") {
        try {
          var result = hooks.copy(text);
          if (result && typeof result.then === "function") {
            result.then(
              function () {
                done(true);
              },
              function () {
                done(false);
              }
            );
            return;
          }
          done(result !== false);
        } catch (err) {
          done(false);
        }
        return;
      }
      var nav = global.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        try {
          var pending = nav.clipboard.writeText(text);
          if (pending && typeof pending.then === "function") {
            pending.then(
              function () {
                done(true);
              },
              function () {
                done(selectCopy(text));
              }
            );
            return;
          }
        } catch (err2) {
          /* Fall through to the readonly field. */
        }
      }
      done(selectCopy(text));
    }

    function focusShareField() {
      if (!shareInput || typeof shareInput.focus !== "function") return;
      shareInput.focus();
      if (typeof shareInput.select === "function") shareInput.select();
    }

    function doShare() {
      var href = fillShareField();
      copyText(href, function (ok) {
        if (ok) {
          setStatus(COPY.shareCopied);
          return;
        }
        if (sheet.hidden) openExport();
        else if (shareBox) shareBox.hidden = false;
        setStatus(COPY.shareReady);
        focusShareField();
      });
    }

    function openExport() {
      openSheet({
        mode: "export",
        title: COPY.export,
        hint: COPY.exportHint,
        share: true,
        choices: [
          { id: "print", label: COPY.print, detail: "پوستر A4، روز و وعده", action: COPY.print },
          { id: "download", label: COPY.download, detail: "روزها و نام غذاها", action: "دانلود" },
        ],
        onChoice: function (choice) {
          if (choice === "print") doPrint();
          if (choice === "download") doDownload();
        },
      });
    }

    function onBuild() {
      syncLatest();
      var result = plan.fillEmpty();
      render();
      reveal();
      if (!plan.recipes().length) setStatus(COPY.needRecipes);
      else if (result.filled > 0) setStatus(COPY.filledWeek);
      else setStatus(COPY.weekFull);
    }

    function recipeIndex(button) {
      var raw = nodeValue(button, "recipeIndex", "data-recipe-index");
      var index = Number(raw);
      if (!isFinite(index) || index < 0 || Math.floor(index) !== index) return -1;
      return index;
    }

    watchPrintEnd(doc);
    if (buildBtn) buildBtn.addEventListener("click", onBuild);
    if (exportBtn) exportBtn.addEventListener("click", openExport);
    if (shareBtn) shareBtn.addEventListener("click", doShare);
    if (closeBtn) closeBtn.addEventListener("click", closeSheet);
    if (cancelBtn) cancelBtn.addEventListener("click", closeSheet);
    if (budgetInput) budgetInput.addEventListener("input", renderBudget);

    sheet.addEventListener("click", function (event) {
      if (event && event.target === sheet) closeSheet();
    });

    doc.addEventListener("keydown", function (event) {
      if (sheet.hidden) return;
      if (event && event.key === "Escape") {
        if (event.preventDefault) event.preventDefault();
        closeSheet();
      }
    });

    doc.addEventListener("ashpaz-recipes", function (event) {
      var detail = event && event.detail;
      var list = detail && detail.recipes;
      if (!Array.isArray(list)) return;
      plan.remember(list);
      render();
      var hasMeal = plan.week().some(function (day) {
        return !!(day && day.recipe);
      });
      if (!hasMeal || !list.length) return;
      if (detail.full) setStatus(COPY.fullIdeas);
      else if (detail.skip && detail.skip.length) setStatus(COPY.freshIdeas);
    });

    doc.addEventListener("click", function (event) {
      var target = event && event.target;
      if (!target) return;
      var eaten = matchTestId(target, "day-eaten");
      if (eaten) {
        var eatenDay = nodeValue(eaten, "day", "data-day");
        var current = null;
        plan.week().forEach(function (day) {
          if (day.id === eatenDay) current = day;
        });
        var result = plan.setUsed(eatenDay, !(current && current.used));
        render();
        if (!result.ok) return;
        if (result.used) {
          setStatus("شام " + result.label + " خورده شد. پیشنهاد بعدی آن را تکرار نمی‌کند.");
        } else {
          setStatus("شام " + result.label + " دوباره در پیشنهادها می‌آید.");
        }
        return;
      }
      var add = matchTestId(target, "add-to-plan");
      if (add && !add.disabled) {
        var latest = currentLatest(hooks);
        var recipe = latest[recipeIndex(add)];
        if (recipe) openAssign(recipe);
        return;
      }
      var dayButton = matchTestId(target, "day-swap") || matchTestId(target, "day-pick");
      if (dayButton) {
        var dayId = nodeValue(dayButton, "day", "data-day");
        if (dayId) openSwap(dayId);
        return;
      }
      var shareHit = matchTestId(target, "plan-share-copy");
      if (shareHit) {
        doShare();
        return;
      }
      if (sheet.hidden) return;
      var choice = matchTestId(target, "plan-choice");
      if (!choice) return;
      var id = nodeValue(choice, "choice", "data-choice");
      var handler = onChoice;
      closeSheet();
      if (handler && id) handler(id);
    });

    doc.addEventListener("ashpaz-plan-changed", function (event) {
      var detail = (event && event.detail) || {};
      if (detail.source !== "remote" && detail.source !== "share") return;
      render();
      if (!detail.shared) return;
      if (detail.shared.ok && detail.shared.empty) setStatus(COPY.shareEmptyOpened);
      else if (detail.shared.ok) setStatus(COPY.shareOpened);
      else if (detail.shared.ok === false) setStatus(COPY.shareBad);
    });

    render();
    if (incoming && incoming.ok && incoming.empty) setStatus(COPY.shareEmptyOpened);
    else if (incoming && incoming.ok) setStatus(COPY.shareOpened);
    else if (incoming && incoming.ok === false) setStatus(COPY.shareBad);
  }

  function consumeShareLocation(plan, loc) {
    var token = shareTokenFromLocation(loc);
    if (!token || !plan || typeof plan.applyShare !== "function") return null;
    var shared = plan.applyShare(token);
    clearShareHash(loc);
    return shared;
  }

  function announceShare(shared) {
    if (!shared || typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
    var event;
    try {
      event =
        typeof CustomEvent === "function"
          ? new CustomEvent("ashpaz-plan-changed", { detail: { source: "share", shared: shared } })
          : { type: "ashpaz-plan-changed", detail: { source: "share", shared: shared } };
    } catch (err) {
      event = { type: "ashpaz-plan-changed", detail: { source: "share", shared: shared } };
    }
    try {
      document.dispatchEvent(event);
    } catch (err2) {
      /* The week is already stored. The next paint reads it. */
    }
  }

  function watchShareHash() {
    if (!global || typeof global.addEventListener !== "function" || global.__ashpazShareWatch) return;
    global.__ashpazShareWatch = true;
    global.addEventListener("hashchange", function () {
      var plan = api.active;
      var loc = null;
      try {
        loc = global.location;
      } catch (err) {
        loc = null;
      }
      var shared = consumeShareLocation(plan, loc);
      if (shared) announceShare(shared);
    });
  }

  function boot() {
    var storage = createMemoryStorage();
    try {
      if (global.localStorage) {
        var probe = "ashpaz-khoone.plan.probe";
        global.localStorage.setItem(probe, "1");
        global.localStorage.removeItem(probe);
        storage = global.localStorage;
      }
    } catch (err) {
      storage = createMemoryStorage();
    }
    var plan = createPlan({ storage: storage });
    var loc = null;
    try {
      loc = global.location;
    } catch (err) {
      loc = null;
    }
    var shared = consumeShareLocation(plan, loc);
    api.active = plan;
    mount(document, plan, { shared: shared });
    watchShareHash();
  }

  var api = {
    COPY: COPY,
    DAYS: DAYS,
    STORAGE_KEY: STORAGE_KEY,
    SYNC_META_KEY: SYNC_META_KEY,
    MAX_RECIPES: MAX_RECIPES,
    createPlan: createPlan,
    createMemoryStorage: createMemoryStorage,
    budgetLine: budgetLine,
    renderWeek: renderWeek,
    encodeShare: encodeShare,
    decodeShare: decodeShare,
    shareHref: shareHref,
    shareTokenFromLocation: shareTokenFromLocation,
    posterOutline: posterOutline,
    mount: mount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazPlan = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
