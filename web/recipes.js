/* Recipe suggestions for آشپزخونه (US-05, US-10).
   Reads the active pantry (chips + week budget) and asks POST /api/recipes/generate.
   «پیشنهاد دستور» is leftover-aware: remaining chips and eaten meals.
   «بازتولید کامل» sends the full pantry and does not skip those meals.
   خورده شد is per meal (صبحانه، ناهار، شام). Older dinner-only weeks
   still skip that شام, because it loads as the dinner slot.
   Diet chips (گیاهی، بدون پیاز، مناسب دیابت) are toggles on the pantry.
   An active combination is sent as filters and kept with the pantry snapshot.
   After the cards render, POST /api/recipes/nutrition asks for a rough
   per-serving estimate. That call can fail without removing the cards.
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
    leftoverNote: "از مواد باقی‌مانده، بدون تکرار وعده‌های خورده‌شده.",
    fullNote: "بازتولید کامل، با همه مواد و همان بودجه هفته.",
    dietLead: "با محدودیت ",
    nutritionPending: "در حال برآورد کالری…",
    nutritionDisclaimer: "این عددها برآورد هوش مصنوعی هستند، نه مقدار دقیق غذا.",
  };

  var ERROR_COPY = {
    empty_ingredients: "برای پیشنهاد دستور، حداقل یک ماده به آشپزخانه اضافه کنید.",
    no_remaining:
      "بعد از وعده‌های خورده‌شده ماده‌ای نمانده. یک ماده اضافه کنید یا «بازتولید کامل» را بزنید.",
    invalid_budget: "بودجه هفته درست نیست. یک عدد به تومان وارد کنید.",
    invalid_household: "تعداد نفرات درست نیست. عددی از ۱ تا ۱۲ وارد کنید.",
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
    invalid_household: true,
    invalid_request: true,
  };

  var DIET_ORDER = ["vegetarian", "no_onion", "diabetic"];
  var DIET_LABELS = {
    vegetarian: "گیاهی",
    no_onion: "بدون پیاز",
    diabetic: "مناسب دیابت",
  };
  var DIET_BUTTONS = {
    vegetarian: "diet-vegetarian",
    no_onion: "diet-no-onion",
    diabetic: "diet-diabetic",
  };

  var REQUEST_TIMEOUT_MS = 100000;
  var NUTRITION_TIMEOUT_MS = 35000;
  var ENDPOINT = "/api/recipes/generate";
  var NUTRITION_ENDPOINT = "/api/recipes/nutrition";
  var MAX_KCAL = 5000;
  var MAX_MACRO = 500;
  var nutritionCache = Object.create(null);

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
        var meals = day && Array.isArray(day.meals) ? day.meals : [];
        if (!meals.length && day && day.recipe) {
          meals = [{ recipe: day.recipe, used: day.used }];
        }
        meals.forEach(function (meal) {
          if (!meal || !meal.used || !meal.recipe || typeof meal.recipe.title !== "string") return;
          used = true;
          var title = meal.recipe.title.replace(/\s+/g, " ").trim();
          if (!title) return;
          var key = identityKey(title);
          if (!key || seen[key]) return;
          seen[key] = true;
          skip.push(title);
        });
      });
    }
    var remaining = items.slice();
    if (used && planApi && typeof planApi.remainingChips === "function") {
      var next = planApi.remainingChips(items);
      if (Array.isArray(next)) remaining = next.slice();
    }
    return { remaining: remaining, skip: skip, used: used };
  }

  function emptyFilters() {
    return { vegetarian: false, no_onion: false, diabetic: false };
  }

  function readFilters(pantry) {
    var filters = emptyFilters();
    if (!pantry || typeof pantry.filters !== "function") return filters;
    var raw = pantry.filters();
    if (!raw || typeof raw !== "object") return filters;
    DIET_ORDER.forEach(function (key) {
      filters[key] = raw[key] === true;
    });
    return filters;
  }

  function filtersActive(filters) {
    return DIET_ORDER.some(function (key) {
      return !!(filters && filters[key]);
    });
  }

  function dietStatus(filters) {
    if (!filtersActive(filters)) return "";
    var labels = [];
    DIET_ORDER.forEach(function (key) {
      if (filters[key]) labels.push(DIET_LABELS[key]);
    });
    return COPY.dietLead + labels.join("، ") + ".";
  }

  function currentHousehold(pantry) {
    var shared = global.AshpazHousehold;
    var fallback = shared && shared.DEFAULT_HOUSEHOLD ? shared.DEFAULT_HOUSEHOLD : 4;
    if (!pantry || typeof pantry.household !== "function") return fallback;
    if (shared && typeof shared.parseHousehold === "function") {
      var parsed = shared.parseHousehold(pantry.household());
      return parsed == null ? fallback : parsed;
    }
    var number = Number(pantry.household());
    if (!isFinite(number)) return fallback;
    return number;
  }

  function scaleLine(line, household, servings) {
    var shared = global.AshpazHousehold;
    if (!shared || typeof shared.scaleIngredientLine !== "function" || typeof shared.scaleFactor !== "function") {
      return line;
    }
    return shared.scaleIngredientLine(line, shared.scaleFactor(household, servings));
  }

  function scaleCardCost(cost, household, servings) {
    var shared = global.AshpazHousehold;
    if (typeof cost !== "number" || !shared || typeof shared.scaleCost !== "function") return cost;
    return shared.scaleCost(cost, household, servings);
  }

  function peoplePhrase(household) {
    var shared = global.AshpazHousehold;
    if (shared && typeof shared.peoplePhrase === "function") return shared.peoplePhrase(household);
    return "";
  }

  function readServings(value, fallback) {
    var shared = global.AshpazHousehold;
    if (!shared || typeof shared.parseHousehold !== "function") return null;
    var parsed = shared.parseHousehold(value);
    if (parsed != null) return parsed;
    return shared.parseHousehold(fallback);
  }

  function withFilters(payload, pantry) {
    var filters = readFilters(pantry);
    if (filtersActive(filters)) payload.filters = filters;
    return payload;
  }

  function buildGeneratePayload(pantry, mode) {
    var items = pantry.items().slice();
    var raw = pantry.budget();
    var budget = null;
    if (raw !== "" && raw != null) {
      var number = Number(raw);
      if (isFinite(number)) budget = number;
    }
    var household = currentHousehold(pantry);
    var full = !!(mode && mode.full);
    if (full) {
      return withFilters({ ingredients: items, budget: budget, household: household, full: true }, pantry);
    }
    var leftovers = readLeftovers(pantry);
    if (!leftovers.used) {
      return withFilters({ ingredients: items, budget: budget, household: household }, pantry);
    }
    return withFilters(
      {
        ingredients: items,
        budget: budget,
        household: household,
        remaining: leftovers.remaining,
        skip: leftovers.skip,
        full: false,
      },
      pantry
    );
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

  function clearNutritionCache() {
    nutritionCache = Object.create(null);
  }

  function nutritionCacheKey(card) {
    return JSON.stringify({
      title: card.title,
      ingredients: card.ingredients,
      steps: card.steps,
    });
  }

  function formatGroupedNumber(value) {
    var grouped = String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
    return toPersianDigits(grouped);
  }

  function formatKcal(value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0 || value > MAX_KCAL) return "";
    return "حدود " + formatGroupedNumber(value) + " کیلوکالری در هر وعده";
  }

  function formatMacroGrams(value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0 || value > MAX_MACRO) return "";
    return toPersianDigits(Math.round(value));
  }

  function formatMacros(estimate) {
    if (!estimate || typeof estimate !== "object") return "";
    var parts = [];
    var protein = formatMacroGrams(estimate.protein_g);
    var carbs = formatMacroGrams(estimate.carbs_g);
    var fat = formatMacroGrams(estimate.fat_g);
    if (protein) parts.push("پروتئین " + protein + " گرم");
    if (carbs) parts.push("کربوهیدرات " + carbs + " گرم");
    if (fat) parts.push("چربی " + fat + " گرم");
    return parts.join("، ");
  }

  function readEstimate(raw) {
    if (!raw || typeof raw !== "object") return null;
    var kcalText = formatKcal(raw.kcal);
    if (!kcalText) return null;
    var estimate = { kcal: Math.round(raw.kcal) };
    ["protein_g", "carbs_g", "fat_g"].forEach(function (key) {
      if (formatMacroGrams(raw[key])) estimate[key] = Math.round(raw[key]);
    });
    return estimate;
  }

  function childByTestId(node, id) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.length; i += 1) {
      var child = node.children[i];
      if (child && child.dataset && child.dataset.testid === id) return child;
    }
    return null;
  }

  function createNutritionBlock(doc) {
    var block = doc.createElement("div");
    block.className = "recipe-nutrition";
    block.dataset.testid = "recipe-nutrition";
    block.hidden = true;
    block.setAttribute("aria-label", "برآورد تغذیه");

    var pending = doc.createElement("p");
    pending.className = "nutrition-pending";
    pending.dataset.testid = "recipe-nutrition-pending";
    pending.hidden = true;

    var kcal = doc.createElement("p");
    kcal.className = "nutrition-kcal";
    kcal.dataset.testid = "recipe-kcal";
    kcal.hidden = true;

    var macros = doc.createElement("p");
    macros.className = "nutrition-macros";
    macros.dataset.testid = "recipe-macros";
    macros.hidden = true;

    var note = doc.createElement("p");
    note.className = "nutrition-note";
    note.dataset.testid = "recipe-nutrition-note";
    note.hidden = true;

    block.append(pending, kcal, macros, note);
    return block;
  }

  function hideNutrition(block) {
    if (!block) return;
    block.hidden = true;
    block.setAttribute("aria-hidden", "true");
    ["recipe-nutrition-pending", "recipe-kcal", "recipe-macros", "recipe-nutrition-note"].forEach(
      function (id) {
        var node = childByTestId(block, id);
        if (!node) return;
        node.hidden = true;
        node.textContent = "";
      }
    );
  }

  function paintNutritionPending(block) {
    if (!block) return;
    block.hidden = false;
    block.setAttribute("aria-hidden", "false");
    var pending = childByTestId(block, "recipe-nutrition-pending");
    var kcal = childByTestId(block, "recipe-kcal");
    var macros = childByTestId(block, "recipe-macros");
    var note = childByTestId(block, "recipe-nutrition-note");
    if (pending) {
      pending.hidden = false;
      pending.textContent = COPY.nutritionPending;
    }
    [kcal, macros, note].forEach(function (node) {
      if (!node) return;
      node.hidden = true;
      node.textContent = "";
    });
  }

  function paintNutrition(block, estimate) {
    if (!block) return;
    var text = formatKcal(estimate && estimate.kcal);
    if (!text) {
      hideNutrition(block);
      return;
    }
    block.hidden = false;
    block.setAttribute("aria-hidden", "false");
    var pending = childByTestId(block, "recipe-nutrition-pending");
    var kcal = childByTestId(block, "recipe-kcal");
    var macros = childByTestId(block, "recipe-macros");
    var note = childByTestId(block, "recipe-nutrition-note");
    if (pending) {
      pending.hidden = true;
      pending.textContent = "";
    }
    if (kcal) {
      kcal.hidden = false;
      kcal.textContent = text;
    }
    var macroText = formatMacros(estimate);
    if (macros) {
      macros.hidden = !macroText;
      macros.textContent = macroText;
    }
    if (note) {
      note.hidden = false;
      note.textContent = COPY.nutritionDisclaimer;
    }
  }

  function applyNutrition(grid, estimates) {
    var cards = grid && grid._recipeCards;
    if (!cards) return;
    for (var i = 0; i < cards.length; i += 1) {
      var block = childByTestId(cards[i], "recipe-nutrition");
      var estimate = readEstimate(estimates && estimates[i]);
      if (estimate) paintNutrition(block, estimate);
      else hideNutrition(block);
    }
  }

  function showNutritionProgress(grid, known) {
    var cards = grid && grid._recipeCards;
    if (!cards) return;
    for (var i = 0; i < cards.length; i += 1) {
      var block = childByTestId(cards[i], "recipe-nutrition");
      if (known[i]) paintNutrition(block, known[i]);
      else paintNutritionPending(block);
    }
  }

  function selectRecipes(recipes, servingsFallback) {
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
      var servings = readServings(recipe.servings, servingsFallback);
      if (servings != null) card.servings = servings;
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

  function renderRecipeGrid(doc, grid, recipes, household) {
    api.latestRecipes = recipes;
    var people =
      household == null ? currentHousehold(global.AshpazPantry && global.AshpazPantry.active) : household;
    var fragment = doc.createDocumentFragment();
    var rendered = [];
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
      var costLabel = formatCostToman(scaleCardCost(card.cost_toman, people, card.servings));
      if (costLabel) {
        var badge = doc.createElement("span");
        badge.className = "cost-badge";
        badge.dataset.testid = "recipe-cost";
        badge.textContent = costLabel;
        head.append(badge);
      }
      var phrase = peoplePhrase(people);
      if (phrase) {
        var peopleEl = doc.createElement("p");
        peopleEl.className = "recipe-people";
        peopleEl.dataset.testid = "recipe-people";
        peopleEl.textContent = phrase;
        head.append(peopleEl);
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
        li.textContent = scaleLine(name, people, card.servings);
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

      var nutrition = createNutritionBlock(doc);
      article.append(head, nutrition, ingredientLabel, tags, stepLabel, steps, plan);
      fragment.append(article);
      rendered.push(article);
    });
    grid._recipeCards = rendered;
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

    clearNutritionCache();
    var gate = createSubmitGate();
    var lastFull = false;
    var request = typeof fetchImpl === "function" ? fetchImpl : null;
    var nutritionTicket = 0;
    var nutritionAbort = null;

    function invalidateNutrition() {
      nutritionTicket += 1;
      if (nutritionAbort) {
        try {
          nutritionAbort.abort();
        } catch (err) {
          /* The in-flight estimate is already ignored via nutritionTicket. */
        }
        nutritionAbort = null;
      }
    }

    function rememberedEstimates(recipes) {
      return recipes.map(function (card) {
        return nutritionCache[nutritionCacheKey(card)] || null;
      });
    }

    function requestNutrition(recipes) {
      var ticket = ++nutritionTicket;
      var known = rememberedEstimates(recipes);
      var missing = known.some(function (item) {
        return !item;
      });
      if (!missing) {
        applyNutrition(grid, known);
        return;
      }
      showNutritionProgress(grid, known);
      if (typeof request !== "function") {
        applyNutrition(grid, known);
        return;
      }

      var controller = null;
      try {
        controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      } catch (err) {
        controller = null;
      }
      nutritionAbort = controller;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
      }, NUTRITION_TIMEOUT_MS);
      var options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          recipes: recipes.map(function (card) {
            return {
              title: card.title,
              ingredients: card.ingredients,
              steps: card.steps,
            };
          }),
        }),
      };
      if (controller) options.signal = controller.signal;

      var pending = null;
      try {
        pending = request(NUTRITION_ENDPOINT, options);
      } catch (err) {
        clearTimeout(timer);
        if (nutritionAbort === controller) nutritionAbort = null;
        if (ticket === nutritionTicket) applyNutrition(grid, known);
        return;
      }

      Promise.resolve(pending)
        .then(function (response) {
          return response.text().then(function (text) {
            return { response: response, text: text };
          });
        })
        .then(function (result) {
          if (ticket !== nutritionTicket) return;
          var body = null;
          try {
            body = result.text ? JSON.parse(result.text) : null;
          } catch (err) {
            body = null;
          }
          var fresh = null;
          if (result.response && result.response.ok && body && body.ok !== false && Array.isArray(body.estimates)) {
            fresh = body.estimates.map(readEstimate);
          }
          if (!fresh) {
            applyNutrition(grid, known);
            return;
          }
          var merged = recipes.map(function (card, index) {
            var next = fresh[index] || known[index] || null;
            if (fresh[index]) nutritionCache[nutritionCacheKey(card)] = fresh[index];
            return next;
          });
          applyNutrition(grid, merged);
        })
        .catch(function () {
          if (ticket !== nutritionTicket) return;
          applyNutrition(grid, known);
        })
        .then(function () {
          clearTimeout(timer);
          if (nutritionAbort === controller) nutritionAbort = null;
        });
    }

    function dietButtons() {
      var buttons = [];
      DIET_ORDER.forEach(function (key) {
        var button = doc.getElementById(DIET_BUTTONS[key]);
        if (button) buttons.push(button);
      });
      return buttons;
    }

    function paintDietChips() {
      var filters = readFilters(pantry);
      DIET_ORDER.forEach(function (key) {
        var button = doc.getElementById(DIET_BUTTONS[key]);
        if (!button) return;
        var on = filters[key] === true;
        button.setAttribute("aria-pressed", on ? "true" : "false");
        if (button.classList) button.classList.toggle("is-on", on);
      });
    }

    function bindDietChips() {
      paintDietChips();
      DIET_ORDER.forEach(function (key) {
        var button = doc.getElementById(DIET_BUTTONS[key]);
        if (!button || typeof button.addEventListener !== "function") return;
        button.addEventListener("click", function () {
          if (gate.isBusy()) return;
          if (!pantry || typeof pantry.setFilter !== "function") return;
          var current = readFilters(pantry);
          pantry.setFilter(key, !current[key]);
          paintDietChips();
        });
      });
      if (typeof doc.addEventListener === "function") {
        doc.addEventListener("ashpaz-pantry-changed", function () {
          paintDietChips();
          if (grid && !grid.hidden && api.latestRecipes && api.latestRecipes.length) {
            renderRecipeGrid(doc, grid, api.latestRecipes);
            applyNutrition(grid, rememberedEstimates(api.latestRecipes));
          }
        });
      }
    }

    function setBusy(busy) {
      suggestBtn.disabled = busy;
      if (fullBtn) fullBtn.disabled = busy;
      if (retryBtn) retryBtn.disabled = busy;
      dietButtons().forEach(function (button) {
        button.disabled = busy;
      });
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
      invalidateNutrition();
      status.textContent = "";
      errorText.textContent = sanitizeDisplay(message);
      errorBox.hidden = false;
      setHint(hint);
      if (emptyBox) emptyBox.hidden = true;
      if (skeleton) skeleton.hidden = true;
      grid.hidden = true;
      grid.replaceChildren();
      grid._recipeCards = [];
    }

    function showLoading() {
      invalidateNutrition();
      errorBox.hidden = true;
      setHint("");
      if (emptyBox) emptyBox.hidden = true;
      if (skeleton) skeleton.hidden = false;
      grid.hidden = true;
      grid.replaceChildren();
      grid._recipeCards = [];
      status.textContent = COPY.loading;
    }

    function showRecipes(recipes, payload) {
      errorBox.hidden = true;
      setHint("");
      var notes = [];
      if (payload && payload.full) notes.push(COPY.fullNote);
      else if (payload && payload.skip && payload.skip.length) notes.push(COPY.leftoverNote);
      var diet = dietStatus(payload && payload.filters);
      if (diet) notes.push(diet);
      status.textContent = notes.join(" ");
      if (emptyBox) emptyBox.hidden = true;
      if (skeleton) skeleton.hidden = true;
      renderRecipeGrid(doc, grid, recipes);
      publishRecipes(doc, recipes, payload);
      grid.hidden = false;
      try {
        requestNutrition(recipes);
      } catch (err) {
        applyNutrition(grid, []);
      }
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
          var recipes = selectRecipes(body.recipes, body.household != null ? body.household : payload.household);
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
    bindDietChips();
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
    NUTRITION_ENDPOINT: NUTRITION_ENDPOINT,
    clearNutritionCache: clearNutritionCache,
    formatKcal: formatKcal,
    formatMacros: formatMacros,
    readEstimate: readEstimate,
    applyNutrition: applyNutrition,
    DIET_LABELS: DIET_LABELS,
    dietStatus: dietStatus,
    readFilters: readFilters,
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
