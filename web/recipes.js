/* Recipe suggestions for آشپزخونه (US-05, US-10).
   Reads the active pantry (chips + week budget) and asks POST /api/recipes/generate.
   «پیشنهاد دستور» is leftover-aware: remaining chips and eaten dinners.
   «بازتولید کامل» sends the full pantry and does not skip those dinners.
   The API key stays on the server. This file never sees it. */
(function (global) {
  "use strict";

  var COPY = {
    suggest: "پیشنهاد دستور",
    full: "بازتولید کامل",
    loading: "در حال پختن ایده‌ها…",
    retry: "تلاش دوباره",
    addToPlan: "افزودن به برنامه",
    ingredients: "مواد",
    steps: "مراحل",
    leftoverNote: "از مواد باقی‌مانده، بدون تکرار شام‌های خورده‌شده.",
    fullNote: "بازتولید کامل، با همه مواد و همان بودجه هفته.",
  };

  var ERROR_COPY = {
    empty_ingredients: "برای پیشنهاد دستور، حداقل یک ماده به آشپزخانه اضافه کنید.",
    no_remaining:
      "بعد از شام‌های خورده‌شده ماده‌ای نمانده. یک ماده اضافه کنید یا «بازتولید کامل» را بزنید.",
    invalid_budget: "بودجه هفته درست نیست. یک عدد به تومان وارد کنید.",
    not_configured: "سرویس پیشنهاد دستور هنوز آماده نیست.",
    invalid_config: "سرویس پیشنهاد دستور هنوز آماده نیست.",
    unauthorized: "سرویس پیشنهاد دستور پاسخ نداد. دوباره تلاش کنید.",
    timeout: "زمان آماده‌کردن ایده‌ها تمام شد. دوباره تلاش کنید.",
    bad_response: "این بار دستورها درست نرسیدند. دوباره تلاش کنید.",
    upstream_unavailable: "الان نمی‌توانیم به سرویس وصل شویم. دوباره تلاش کنید.",
    upstream_error: "الان نمی‌توانیم دستور پیشنهاد کنیم. دوباره تلاش کنید.",
    invalid_request: "درخواست پیشنهاد دستور درست نبود. دوباره تلاش کنید.",
    network: "ارتباط با سرور برقرار نشد. دوباره تلاش کنید.",
    internal_error: "پیشنهاد دستور انجام نشد. دوباره تلاش کنید.",
    default: "پیشنهاد دستور انجام نشد. دوباره تلاش کنید.",
  };

  // Shown with service failures. Names the env var; never a key value.
  var SERVICE_HINT =
    "اگر این خطا ماند، GAP_CODE_API_KEY را در محیط بررسی کنید و لاگ docker compose را ببینید. مقدار کلید اینجا نشان داده نمی‌شود.";

  var LOCAL_ERRORS = {
    empty_ingredients: true,
    no_remaining: true,
    invalid_budget: true,
    invalid_request: true,
  };

  var REQUEST_TIMEOUT_MS = 100000;
  var ENDPOINT = "/api/recipes/generate";

  function toPersianDigits(value) {
    return String(value).replace(/\d/g, function (digit) {
      return "۰۱۲۳۴۵۶۷۸۹"[Number(digit)];
    });
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
    if (!Array.isArray(value)) return null;
    var items = [];
    for (var i = 0; i < value.length && items.length < maxItems; i += 1) {
      var text = cleanLine(value[i], itemLimit);
      if (text) items.push(text);
    }
    return items.length ? items : null;
  }

  function identityKey(value) {
    var pantryApi = global.AshpazPantry;
    if (pantryApi && typeof pantryApi.identityKey === "function") return pantryApi.identityKey(value);
    return String(value || "")
      .replace(/[\u200e\u200f\u200c\u200d]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function readLeftovers(pantry) {
    var items = pantry.items().slice();
    var planApi = global.AshpazPlan && global.AshpazPlan.active;
    var skip = [];
    var seen = Object.create(null);
    var used = false;
    if (planApi && typeof planApi.week === "function") {
      planApi.week().forEach(function (day) {
        if (!day || !day.used || !day.recipe || typeof day.recipe.title !== "string") return;
        used = true;
        var title = day.recipe.title.replace(/\s+/g, " ").trim();
        if (!title) return;
        var key = identityKey(title);
        if (!key || seen[key]) return;
        seen[key] = true;
        skip.push(title);
      });
    }
    var remaining = items.slice();
    if (used && planApi && typeof planApi.remainingChips === "function") {
      var next = planApi.remainingChips(items);
      if (Array.isArray(next)) remaining = next.slice();
    }
    return { remaining: remaining, skip: skip, used: used };
  }

  function buildGeneratePayload(pantry, mode) {
    var items = pantry.items().slice();
    var raw = pantry.budget();
    var budget = null;
    if (raw !== "" && raw != null) {
      var number = Number(raw);
      if (isFinite(number)) budget = number;
    }
    var full = !!(mode && mode.full);
    if (full) return { ingredients: items, budget: budget, full: true };
    var leftovers = readLeftovers(pantry);
    if (!leftovers.used) return { ingredients: items, budget: budget };
    return {
      ingredients: items,
      budget: budget,
      remaining: leftovers.remaining,
      skip: leftovers.skip,
      full: false,
    };
  }

  function sanitizeDisplay(text) {
    var value = String(text == null ? "" : text);
    value = value.replace(/bearer\s+\S+/gi, "");
    value = value.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "");
    value = value.replace(/Traceback \(most recent call last\)[\s\S]*/g, "");
    return value
      .split("\n")
      .filter(function (line) {
        return !/^\s*at\s+\S+/.test(line) && !/File ".*", line \d+/.test(line);
      })
      .join("\n")
      .trim();
  }

  function messageForFailure(_status, body) {
    // Mapped Persian copy only. body.message is ignored so a key or stack cannot surface.
    var code = body && typeof body.error === "string" ? body.error : "";
    var message = Object.prototype.hasOwnProperty.call(ERROR_COPY, code)
      ? ERROR_COPY[code]
      : ERROR_COPY.default;
    return sanitizeDisplay(message);
  }

  function hintForFailure(body) {
    var code = body && typeof body.error === "string" ? body.error : "";
    if (LOCAL_ERRORS[code]) return "";
    return sanitizeDisplay(SERVICE_HINT);
  }

  function formatCostToman(value) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) return "";
    var rounded = Math.round(value);
    var grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
    return "حدود " + toPersianDigits(grouped) + " تومان";
  }

  function selectRecipes(recipes) {
    if (!Array.isArray(recipes)) return null;
    var selected = [];
    for (var i = 0; i < recipes.length && selected.length < 6; i += 1) {
      var recipe = recipes[i];
      if (!recipe || typeof recipe !== "object") continue;
      var title = cleanLine(recipe.title, 120);
      var ingredients = cleanList(recipe.ingredients, 16, 80);
      var steps = cleanList(recipe.steps, 12, 400);
      if (!title || !ingredients || !steps) continue;
      var card = { title: title, ingredients: ingredients, steps: steps };
      if (
        typeof recipe.cost_toman === "number" &&
        isFinite(recipe.cost_toman) &&
        recipe.cost_toman >= 0
      ) {
        card.cost_toman = Math.round(recipe.cost_toman);
      }
      selected.push(card);
    }
    if (selected.length < 3) return null;
    return selected;
  }

  function createSubmitGate() {
    var busy = false;
    return {
      isBusy: function () {
        return busy;
      },
      begin: function () {
        if (busy) return false;
        busy = true;
        return true;
      },
      end: function () {
        busy = false;
      },
    };
  }

  function publishRecipes(doc, recipes, meta) {
    if (!doc || typeof doc.dispatchEvent !== "function") return;
    var detail = { recipes: recipes };
    if (meta && meta.full) detail.full = true;
    if (meta && Array.isArray(meta.skip) && meta.skip.length) detail.skip = meta.skip.slice();
    var event;
    if (typeof CustomEvent === "function") {
      event = new CustomEvent("ashpaz-recipes", { detail: detail });
    } else {
      event = { type: "ashpaz-recipes", detail: detail };
    }
    doc.dispatchEvent(event);
  }

  function renderRecipeGrid(doc, grid, recipes) {
    api.latestRecipes = recipes;
    var fragment = doc.createDocumentFragment();
    recipes.forEach(function (card, index) {
      var article = doc.createElement("article");
      article.className = "recipe-card";
      article.dataset.testid = "recipe-card";

      var head = doc.createElement("header");
      head.className = "recipe-card-head";

      var title = doc.createElement("h3");
      title.dataset.testid = "recipe-title";
      title.textContent = card.title;

      head.append(title);
      var costLabel = formatCostToman(card.cost_toman);
      if (costLabel) {
        var badge = doc.createElement("span");
        badge.className = "cost-badge";
        badge.dataset.testid = "recipe-cost";
        badge.textContent = costLabel;
        head.append(badge);
      }

      var ingredientLabel = doc.createElement("p");
      ingredientLabel.className = "recipe-kicker";
      ingredientLabel.textContent = COPY.ingredients;

      var tags = doc.createElement("ul");
      tags.className = "recipe-tags";
      tags.setAttribute("aria-label", COPY.ingredients + " " + card.title);
      card.ingredients.forEach(function (name) {
        var li = doc.createElement("li");
        li.dataset.testid = "recipe-ingredient";
        li.textContent = name;
        tags.append(li);
      });

      var stepLabel = doc.createElement("p");
      stepLabel.className = "recipe-kicker";
      stepLabel.textContent = COPY.steps;

      var steps = doc.createElement("ol");
      steps.className = "recipe-steps";
      steps.setAttribute("aria-label", COPY.steps + " " + card.title);
      card.steps.forEach(function (step) {
        var li = doc.createElement("li");
        li.dataset.testid = "recipe-step";
        li.textContent = step;
        steps.append(li);
      });

      var plan = doc.createElement("button");
      plan.type = "button";
      plan.className = "plan-button";
      plan.disabled = false;
      plan.dataset.testid = "add-to-plan";
      plan.dataset.recipeIndex = String(index);
      plan.setAttribute("data-recipe-index", String(index));
      plan.setAttribute("aria-haspopup", "dialog");
      plan.setAttribute("aria-controls", "plan-sheet");
      plan.textContent = COPY.addToPlan;

      article.append(head, ingredientLabel, tags, stepLabel, steps, plan);
      fragment.append(article);
    });
    grid.replaceChildren(fragment);
  }

  function mount(doc, pantry, fetchImpl) {
    var suggestBtn = doc.getElementById("suggest");
    var fullBtn = doc.getElementById("regenerate-full");
    var retryBtn = doc.getElementById("recipe-retry");
    var status = doc.getElementById("recipe-status");
    var errorBox = doc.getElementById("recipe-error");
    var errorText = doc.getElementById("recipe-error-text");
    var hintEl = doc.getElementById("recipe-error-hint");
    var emptyBox = doc.getElementById("recipe-empty");
    var skeleton = doc.getElementById("recipe-skeleton");
    var grid = doc.getElementById("recipe-grid");
    var panel = doc.getElementById("recipes");
    if (!suggestBtn || !status || !errorBox || !errorText || !grid || !pantry) return;

    var gate = createSubmitGate();
    var lastFull = false;
    var request = typeof fetchImpl === "function" ? fetchImpl : null;

    function setBusy(busy) {
      suggestBtn.disabled = busy;
      if (fullBtn) fullBtn.disabled = busy;
      if (retryBtn) retryBtn.disabled = busy;
      suggestBtn.setAttribute("aria-busy", busy ? "true" : "false");
      if (fullBtn) fullBtn.setAttribute("aria-busy", busy ? "true" : "false");
      if (panel) panel.setAttribute("aria-busy", busy ? "true" : "false");
      if (panel) panel.classList.toggle("is-busy", busy);
    }

    function setHint(hint) {
      if (!hintEl) return;
      var safe = sanitizeDisplay(hint || "");
      hintEl.textContent = safe;
      hintEl.hidden = !safe;
    }

    function showError(message, hint) {
      status.textContent = "";
      errorText.textContent = sanitizeDisplay(message);
      errorBox.hidden = false;
      setHint(hint);
      if (emptyBox) emptyBox.hidden = true;
      if (skeleton) skeleton.hidden = true;
      grid.hidden = true;
      grid.replaceChildren();
    }

    function showLoading() {
      errorBox.hidden = true;
      setHint("");
      if (emptyBox) emptyBox.hidden = true;
      if (skeleton) skeleton.hidden = false;
      grid.hidden = true;
      grid.replaceChildren();
      status.textContent = COPY.loading;
    }

    function showRecipes(recipes, payload) {
      errorBox.hidden = true;
      setHint("");
      var note = "";
      if (payload && payload.full) note = COPY.fullNote;
      else if (payload && payload.skip && payload.skip.length) note = COPY.leftoverNote;
      status.textContent = note;
      if (emptyBox) emptyBox.hidden = true;
      if (skeleton) skeleton.hidden = true;
      renderRecipeGrid(doc, grid, recipes);
      publishRecipes(doc, recipes, payload);
      grid.hidden = false;
    }

    function showIdle() {
      errorBox.hidden = true;
      setHint("");
      if (skeleton) skeleton.hidden = true;
      if (emptyBox) emptyBox.hidden = false;
      grid.hidden = true;
      status.textContent = "";
    }

    function finish(timer) {
      clearTimeout(timer);
      gate.end();
      setBusy(false);
    }

    function run(full) {
      if (!gate.begin()) return;
      lastFull = !!full;
      var payload = buildGeneratePayload(pantry, { full: lastFull });
      if (!payload.ingredients.length) {
        gate.end();
        showError(
          messageForFailure(400, { error: "empty_ingredients" }),
          hintForFailure({ error: "empty_ingredients" })
        );
        return;
      }
      if (!payload.full && Array.isArray(payload.remaining) && !payload.remaining.length) {
        gate.end();
        showError(
          messageForFailure(400, { error: "no_remaining" }),
          hintForFailure({ error: "no_remaining" })
        );
        return;
      }
      if (!request) {
        gate.end();
        showError(messageForFailure(0, { error: "network" }), hintForFailure({ error: "network" }));
        return;
      }

      setBusy(true);
      showLoading();
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
      }, REQUEST_TIMEOUT_MS);

      var options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      };
      if (controller) options.signal = controller.signal;

      request(ENDPOINT, options)
        .then(function (response) {
          return response.text().then(function (text) {
            return { response: response, text: text };
          });
        })
        .then(function (result) {
          var body = null;
          try {
            body = result.text ? JSON.parse(result.text) : null;
          } catch (err) {
            body = null;
          }
          if (!result.response.ok || !body || body.ok === false) {
            showError(messageForFailure(result.response.status, body), hintForFailure(body));
            return;
          }
          var recipes = selectRecipes(body.recipes);
          if (!recipes) {
            showError(
              messageForFailure(502, { error: "bad_response" }),
              hintForFailure({ error: "bad_response" })
            );
            return;
          }
          showRecipes(recipes, payload);
        })
        .catch(function (err) {
          var aborted = err && (err.name === "AbortError" || err.code === 20);
          var code = aborted ? "timeout" : "network";
          showError(messageForFailure(0, { error: code }), hintForFailure({ error: code }));
        })
        .then(function () {
          finish(timer);
        });
    }

    suggestBtn.addEventListener("click", function () {
      run(false);
    });
    if (fullBtn) {
      fullBtn.addEventListener("click", function () {
        run(true);
      });
    }
    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        run(lastFull);
      });
    }
    showIdle();
  }

  function boot() {
    var pantryApi = global.AshpazPantry;
    if (!pantryApi || !pantryApi.active) return;
    var fetchImpl = typeof global.fetch === "function" ? global.fetch.bind(global) : null;
    mount(document, pantryApi.active, fetchImpl);
  }

  var api = {
    COPY: COPY,
    ERROR_COPY: ERROR_COPY,
    SERVICE_HINT: SERVICE_HINT,
    ENDPOINT: ENDPOINT,
    buildGeneratePayload: buildGeneratePayload,
    readLeftovers: readLeftovers,
    sanitizeDisplay: sanitizeDisplay,
    messageForFailure: messageForFailure,
    hintForFailure: hintForFailure,
    formatCostToman: formatCostToman,
    selectRecipes: selectRecipes,
    createSubmitGate: createSubmitGate,
    renderRecipeGrid: renderRecipeGrid,
    mount: mount,
    latestRecipes: [],
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazRecipes = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
