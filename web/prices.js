/* Okala prices for آشپزخونه.
   The refresh button asks the api to update stored unit prices.
   Recipe, week, and shopping costs use those prices when they are fresh.
   A miss or a stale row falls back to the GapGPT estimate, or to the last
   stored price on the shopping line. This file never sees an API key.
   Full basket prefill is not available: the cart helper copies names and
   opens okala.com or a product page. */
(function (global) {
  "use strict";

  var STORAGE_KEY = "ashpaz-khoone.okala-prices.v1";
  var ENDPOINT = "/api/prices";
  var HOME_URL = "https://www.okala.com/";
  var COPY_LIMIT = 10;
  var MAX_NAMES = 40;
  var DEFAULT_TTL = 86400;

  var SEED = ["برنج", "پیاز", "عدس", "لوبیا", "سیب‌زمینی", "گوجه‌فرنگی", "ماست", "روغن"];

  var COPY = {
    refresh: "به‌روزرسانی قیمت‌ها",
    refreshing: "در حال به‌روزرسانی قیمت‌ها…",
    live: "قیمت‌های اُکالا به‌روز شد.",
    fixture: "قیمت‌ها از نمونه ذخیره‌شده اُکالا آمد.",
    ready: "قیمت‌های اُکالا آماده‌اند.",
    throttled: "قیمت‌ها همین تازگی به‌روز شده‌اند.",
    degraded: "اُکالا پاسخ نداد. آخرین قیمت ذخیره‌شده مانده است.",
    degradedEmpty: "اُکالا پاسخ نداد. برآورد قبلی می‌ماند.",
    offline: "ارتباط با سرور برقرار نشد. برآورد قبلی می‌ماند.",
    unmatched: "در اُکالا پیدا نشد: ",
    more: " و موارد دیگر",
    staleNote: "قیمت اُکالا کهنه است",
    cartTitle: "سبد اُکالا",
    cartMessage:
      "سبد اُکالا از اینجا پر نمی‌شود. نام‌ها را کپی کنید و در جست‌وجوی لیستی اُکالا بگذارید. پرداخت اینجا انجام نمی‌شود.",
    cartTruncated: "جست‌وجوی لیستی اُکالا ده نام را با هم می‌گیرد. ده نام اول کپی می‌شود.",
    copy: "کپی فهرست برای اُکالا",
    copied: "فهرست برای اُکالا کپی شد.",
    copyFailed: "کپی انجام نشد. نام‌ها را از فهرست بردارید.",
    open: "باز کردن اُکالا",
    view: "مشاهده",
    emptyCart: "فهرست خرید خالی است.",
  };

  var catalog = {
    items: [],
    unmatched: [],
    ttl_seconds: DEFAULT_TTL,
    origin: "",
  };

  function toAsciiDigits(value) {
    return String(value == null ? "" : value)
      .replace(/[۰-۹]/g, function (digit) {
        return String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit));
      })
      .replace(/[٠-٩]/g, function (digit) {
        return String("٠١٢٣٤٥٦٧٨٩".indexOf(digit));
      });
  }

  function toPersianDigits(value) {
    return String(value).replace(/\d/g, function (digit) {
      return "۰۱۲۳۴۵۶۷۸۹"[Number(digit)];
    });
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

  function tokens(value) {
    return displayName(value)
      .replace(/\u200c/g, " ")
      .split(/\s+/)
      .map(identityKey)
      .filter(Boolean);
  }

  function money(value) {
    var rounded = Math.round(value);
    var grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
    return toPersianDigits(grouped);
  }

  function labelFor(source, toman) {
    if (!(toman > 0)) return "";
    var text = money(toman) + " تومان";
    if (source === "okala") return text + " · اُکالا";
    if (source === "partial") return text + " · بخشی از اُکالا";
    return "حدود " + text;
  }

  function safeProductUrl(url) {
    if (typeof url !== "string") return "";
    if (/^https:\/\/www\.okala\.com\/product\/\d+$/.test(url)) return url;
    return "";
  }

  function momentOf(now) {
    if (now instanceof Date) return now.getTime();
    if (typeof now === "number" && isFinite(now)) return now;
    return Date.now();
  }

  function isStale(item, now) {
    if (!item || !item.matched) return false;
    var fetched = Date.parse(item.fetched_at || "");
    if (!isFinite(fetched)) return item.stale === true;
    var ttl = (catalog.ttl_seconds || DEFAULT_TTL) * 1000;
    return momentOf(now) - fetched > ttl;
  }

  function lookup(name) {
    var query = tokens(name);
    if (!query.length) return null;
    var best = null;
    var bestLen = -1;
    catalog.items.forEach(function (row) {
      if (!row || !row.matched) return;
      var rowTokens = tokens(row.name);
      if (!rowTokens.length || query.length < rowTokens.length) return;
      for (var i = 0; i < rowTokens.length; i += 1) {
        if (query[i] !== rowTokens[i]) return;
      }
      if (rowTokens.length > bestLen) {
        best = row;
        bestLen = rowTokens.length;
      }
    });
    return best;
  }

  function toBase(qty, unit) {
    if (typeof qty !== "number" || !isFinite(qty) || qty < 0) return null;
    if (unit === "گرم") return { unit: "کیلوگرم", qty: qty / 1000 };
    if (unit === "کیلو" || unit === "کیلوگرم") return { unit: "کیلوگرم", qty: qty };
    if (unit === "میلی‌لیتر" || unit === "میلی لیتر") return { unit: "لیتر", qty: qty / 1000 };
    if (unit === "لیتر") return { unit: "لیتر", qty: qty };
    if (unit === "عدد") return { unit: "عدد", qty: qty };
    return null;
  }

  function simpleParse(raw) {
    var text = toAsciiDigits(displayName(raw));
    var match = text.match(/^(\d+(?:[.,]\d+)?)\s*(کیلوگرم|کیلو|میلی‌لیتر|میلی لیتر|گرم|لیتر|عدد)?\s*(.+)$/);
    if (!match) {
      var name = displayName(text);
      return name ? { qty: null, unit: "", name: name } : null;
    }
    var qty = Number(match[1].replace(",", "."));
    if (!isFinite(qty)) qty = null;
    var name = displayName(match[3]);
    if (!name) return null;
    return { qty: qty, unit: match[2] || "", name: name };
  }

  function parsedLines(recipe) {
    var raw = recipe && recipe.ingredients;
    if (!Array.isArray(raw)) return [];
    var shop = global.AshpazShop;
    var parsed = [];
    raw.forEach(function (line) {
      if (shop && typeof shop.expandLine === "function") {
        shop.expandLine(line).forEach(function (item) {
          if (item) parsed.push(item);
        });
        return;
      }
      var simple = simpleParse(line);
      if (simple) parsed.push(simple);
    });
    return parsed;
  }

  function scaleContext(recipe, household) {
    var shared = global.AshpazHousehold;
    var people = shared && typeof shared.householdOrDefault === "function" ? shared.householdOrDefault(household) : 4;
    var factor = shared && typeof shared.scaleFactor === "function" ? shared.scaleFactor(people, recipe && recipe.servings) : 1;
    var estimate = null;
    if (recipe && typeof recipe.cost_toman === "number" && isFinite(recipe.cost_toman) && recipe.cost_toman > 0) {
      estimate =
        shared && typeof shared.scaleCost === "function"
          ? shared.scaleCost(recipe.cost_toman, people, recipe.servings)
          : Math.round(recipe.cost_toman * factor);
    }
    return { people: people, factor: factor, estimate: estimate };
  }

  function lineCost(row, qty, unit) {
    var converted = toBase(qty, unit || "");
    var pack = row && row.pack_quantity;
    var packPrice = row && row.pack_price_toman;
    if (!converted || !row || converted.unit !== row.unit || !(pack > 0) || !(packPrice > 0)) return null;
    return (packPrice * converted.qty) / pack;
  }

  function quoteRecipe(recipe, household, now) {
    var scale = scaleContext(recipe, household);
    var total = 0;
    var priced = 0;
    var missing = 0;
    var sawStale = false;
    parsedLines(recipe).forEach(function (line) {
      if (line.qty == null || !isFinite(line.qty)) return;
      var row = lookup(line.name);
      if (!row) {
        missing += 1;
        return;
      }
      if (isStale(row, now)) {
        sawStale = true;
        missing += 1;
        return;
      }
      var cost = lineCost(row, line.qty * scale.factor, line.unit);
      if (cost == null) {
        missing += 1;
        return;
      }
      total += cost;
      priced += 1;
    });
    var source = "estimate";
    var toman = scale.estimate || 0;
    if (priced > 0 && missing === 0) {
      source = "okala";
      toman = Math.round(total);
    } else if (priced > 0) {
      source = "partial";
      toman = Math.round(total);
    }
    return {
      source: source,
      toman: toman,
      estimate_toman: scale.estimate,
      stale: sawStale && source === "estimate",
      label: labelFor(source, toman),
      priced_lines: priced,
      missing_lines: missing,
    };
  }

  function unitPhrase(row) {
    if (!row || !(row.unit_price_toman > 0) || !row.unit) return "";
    return "هر " + row.unit + " " + money(row.unit_price_toman) + " تومان · اُکالا";
  }

  function priceParts(name, parts, now) {
    var row = lookup(name);
    if (!row) return { source: "missing", label: "", toman: 0, productUrl: "" };
    var url = safeProductUrl(row.product_url);
    if (isStale(row, now)) {
      var staleLabel = unitPhrase(row);
      return {
        source: "stale",
        label: staleLabel ? staleLabel + " · کهنه" : COPY.staleNote,
        toman: 0,
        productUrl: url,
      };
    }
    var total = 0;
    var priced = 0;
    (Array.isArray(parts) ? parts : []).forEach(function (part) {
      if (!part || part.qty == null || !isFinite(part.qty)) return;
      var cost = lineCost(row, part.qty, part.unit);
      if (cost == null) return;
      total += cost;
      priced += 1;
    });
    if (priced > 0) {
      var toman = Math.round(total);
      return { source: "okala", label: labelFor("okala", toman), toman: toman, productUrl: url };
    }
    var phrase = unitPhrase(row);
    if (phrase) return { source: "okala", label: phrase, toman: row.unit_price_toman, productUrl: url, unitOnly: true };
    return { source: "missing", label: "", toman: 0, productUrl: url };
  }

  function cartAssist(items) {
    var list = Array.isArray(items) ? items : [];
    var copy = [];
    var rows = [];
    list.forEach(function (item) {
      var name = displayName(typeof item === "string" ? item : item && item.name);
      if (!name) return;
      if (copy.length < COPY_LIMIT) copy.push(name);
      var row = lookup(name);
      var stale = row && isStale(row);
      var url = row ? safeProductUrl(row.product_url) : "";
      rows.push({
        name: name,
        quantity_label: item && item.quantityLabel ? String(item.quantityLabel) : "",
        matched: !!(row && row.matched && !stale),
        product_url: url,
        priceLabel: row && !stale ? unitPhrase(row) : "",
      });
    });
    var message = COPY.cartMessage;
    if (list.length > COPY_LIMIT) message += " " + COPY.cartTruncated;
    return {
      prefill: false,
      checkout: false,
      homepage: HOME_URL,
      copy_text: copy.join("\n"),
      truncated: list.length > COPY_LIMIT,
      message: message,
      items: rows,
    };
  }

  function applyCatalog(body, options) {
    options = options || {};
    var next = body && typeof body === "object" ? body : {};
    catalog.items = Array.isArray(next.items) ? next.items.filter(function (item) { return item && item.matched; }) : [];
    catalog.unmatched = Array.isArray(next.unmatched) ? next.unmatched.slice() : [];
    catalog.ttl_seconds = next.ttl_seconds > 0 ? next.ttl_seconds : DEFAULT_TTL;
    catalog.origin = next.origin || "";
    var storage = options.storage;
    if (storage && typeof storage.setItem === "function") {
      try {
        storage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            items: catalog.items,
            unmatched: catalog.unmatched,
            ttl_seconds: catalog.ttl_seconds,
            origin: catalog.origin,
          })
        );
      } catch (err) {
        /* A full browser store must not block the estimate fallback. */
      }
    }
    return catalog;
  }

  function loadStored(storage) {
    if (!storage || typeof storage.getItem !== "function") return null;
    try {
      var parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "");
      if (!parsed || !Array.isArray(parsed.items)) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function statusText(body, hasItems) {
    if (!body || typeof body !== "object") return hasItems ? COPY.degraded : COPY.degradedEmpty;
    if (body.throttled) return COPY.throttled;
    if (body.degraded) return hasItems ? COPY.degraded : COPY.degradedEmpty;
    if (body.origin === "live") return COPY.live;
    if (body.origin === "fixture") return COPY.fixture;
    return hasItems ? COPY.ready : "";
  }

  function unmatchedText(names) {
    if (!names || !names.length) return "";
    var shown = names.slice(0, 8).join("، ");
    if (names.length > 8) shown += COPY.more;
    return COPY.unmatched + shown;
  }

  function dedupeNames(list) {
    var seen = Object.create(null);
    var names = [];
    list.forEach(function (item) {
      var name = displayName(item);
      var key = identityKey(name);
      if (!key || key.length < 2 || seen[key] || names.length >= MAX_NAMES) return;
      seen[key] = true;
      names.push(name);
    });
    return names;
  }

  function collectNames() {
    var names = SEED.slice();
    var pantryApi = global.AshpazPantry;
    var pantry = pantryApi && pantryApi.active;
    if (pantry && typeof pantry.items === "function") names = names.concat(pantry.items());
    var planApi = global.AshpazPlan;
    var shopApi = global.AshpazShop;
    var plan = planApi && planApi.active;
    if (shopApi && plan && typeof plan.week === "function" && typeof shopApi.buildShoppingList === "function") {
      var people = pantry && typeof pantry.household === "function" ? pantry.household() : undefined;
      var list = shopApi.buildShoppingList(pantry && pantry.items ? pantry.items() : [], plan.week(), people);
      (list.categories || []).forEach(function (cat) {
        (cat.items || []).forEach(function (item) {
          names.push(item.name);
        });
      });
    }
    return dedupeNames(names);
  }

  function notify(doc) {
    if (!doc || typeof doc.dispatchEvent !== "function") return;
    var detail = { items: catalog.items.slice(), unmatched: catalog.unmatched.slice() };
    var event;
    if (typeof global.CustomEvent === "function") {
      event = new global.CustomEvent("ashpaz-prices-changed", { detail: detail });
    } else {
      event = { type: "ashpaz-prices-changed", detail: detail };
    }
    doc.dispatchEvent(event);
  }

  function paint(doc, message) {
    var status = doc && doc.getElementById && doc.getElementById("price-status");
    var unmatched = doc && doc.getElementById && doc.getElementById("price-unmatched");
    if (status && message != null) status.textContent = message;
    if (unmatched) {
      var text = unmatchedText(catalog.unmatched);
      unmatched.hidden = !text;
      unmatched.textContent = text;
    }
  }

  function storageOf() {
    try {
      if (global.localStorage) return global.localStorage;
    } catch (err) {
      return null;
    }
    return null;
  }

  function mount(doc, hooks) {
    hooks = hooks || {};
    var button = doc.getElementById("price-refresh");
    var storage = hooks.storage || storageOf();
    var busy = false;

    function remember(body) {
      applyCatalog(body, { storage: storage });
      notify(doc);
    }

    var cached = loadStored(storage);
    if (cached) {
      remember(cached);
      paint(doc, catalog.items.length ? COPY.ready : "");
    }

    function refresh() {
      if (busy) return;
      busy = true;
      if (button) button.disabled = true;
      paint(doc, COPY.refreshing);
      var request =
        typeof hooks.refresh === "function"
          ? hooks.refresh(collectNames())
          : fetch(ENDPOINT + "/refresh", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ names: collectNames(), force: true }),
            }).then(function (res) {
              return res.json().then(function (body) {
                return { ok: res.ok, body: body };
              });
            });
      Promise.resolve(request)
        .then(function (result) {
          var body = result && result.body;
          if (body && body.ok && (body.items || body.unmatched)) {
            var had = catalog.items.length;
            remember(body);
            paint(doc, statusText(body, catalog.items.length || had));
            return;
          }
          paint(doc, catalog.items.length ? COPY.degraded : COPY.degradedEmpty);
        })
        .catch(function () {
          paint(doc, catalog.items.length ? COPY.degraded : COPY.offline);
        })
        .then(function () {
          busy = false;
          if (button) button.disabled = false;
        });
    }

    if (button) button.addEventListener("click", refresh);

    if (typeof hooks.autoload === "function") {
      hooks.autoload();
    } else if (typeof hooks.refresh !== "function" && typeof global.fetch === "function") {
      fetch(ENDPOINT, { headers: { Accept: "application/json" } })
        .then(function (res) {
          if (!res.ok) throw new Error("status");
          return res.json();
        })
        .then(function (body) {
          if (!body || !body.ok) return;
          remember(body);
          if (!button || !doc.getElementById("price-status") || !doc.getElementById("price-status").textContent) {
            paint(doc, catalog.items.length ? COPY.ready : "");
          }
        })
        .catch(function () {
          if (!catalog.items.length) paint(doc, "");
        });
    }

    return { refresh: refresh };
  }

  var api = {
    COPY: COPY,
    SEED: SEED,
    STORAGE_KEY: STORAGE_KEY,
    quoteRecipe: quoteRecipe,
    priceParts: priceParts,
    cartAssist: cartAssist,
    applyCatalog: applyCatalog,
    lookup: lookup,
    isStale: isStale,
    labelFor: labelFor,
    safeProductUrl: safeProductUrl,
    collectNames: collectNames,
    statusText: statusText,
    unmatchedText: unmatchedText,
    mount: mount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazPrices = api;

  function boot() {
    api.active = true;
    mount(document);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
