/* Seven-day dinner plan for آشپزخونه (US-06, US-07).
   Recipes already on the page can be assigned to شنبه–جمعه.
   State stays in localStorage. Print and Markdown export are
   client-side. This file does not call GapGPT and never sees the API key. */
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
    cancel: "انصراف",
    clear: "خالی کردن",
    current: "فعلی",
    filledWeek: "شام هر روز این هفته چیده شد.",
    needRecipes: "برای چیدن برنامه، اول «پیشنهاد دستور» را بزنید.",
    weekFull: "هر هفت روز شام دارد. برای عوض کردن، «جایگزین» را بزنید.",
    noRecipes: "هنوز دستوری نیست. اول «پیشنهاد دستور» را بزنید.",
    exportHint:
      "چاپ، پس‌زمینه سفید و خط فارسی است و بقیه صفحه را پنهان می‌کند. خروجی یک فایل مارک‌داون از روزها و نام غذاهاست.",
    filename: "برنامه-۷-روزه.md",
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

  function createPlan(options) {
    var storage = options && options.storage;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      storage = createMemoryStorage();
    }

    var state = load();

    function load() {
      try {
        var raw = storage.getItem(STORAGE_KEY);
        if (!raw) return { recipes: [], slots: emptySlots() };
        return sanitize(JSON.parse(raw));
      } catch (err) {
        return { recipes: [], slots: emptySlots() };
      }
    }

    function persist() {
      try {
        storage.setItem(
          STORAGE_KEY,
          JSON.stringify({ recipes: state.recipes, slots: state.slots })
        );
      } catch (err) {
        /* Quota or privacy mode: keep the in-memory plan for this visit. */
      }
    }

    function find(id) {
      for (var i = 0; i < state.recipes.length; i += 1) {
        if (state.recipes[i].id === id) return state.recipes[i];
      }
      return null;
    }

    function sanitize(parsed) {
      var next = { recipes: [], slots: emptySlots() };
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
      article.className = "day-card " + (day.recipe ? "is-filled" : "is-empty");
      article.dataset.testid = "day-card";
      article.dataset.day = day.id;
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
      meal.textContent = day.recipe ? day.recipe.title : COPY.empty;

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

  function mount(doc, plan, hooks) {
    hooks = hooks || {};
    var grid = doc.getElementById("week-grid");
    var sheet = doc.getElementById("plan-sheet");
    var titleEl = doc.getElementById("plan-sheet-title");
    var hintEl = doc.getElementById("plan-sheet-hint");
    var list = doc.getElementById("plan-sheet-list");
    var status = doc.getElementById("plan-status");
    var budgetEl = doc.getElementById("plan-budget");
    var buildBtn = doc.getElementById("build-plan");
    var exportBtn = doc.getElementById("plan-export");
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

    function render() {
      renderWeek(doc, grid, plan);
      renderBudget();
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

    function openExport() {
      openSheet({
        mode: "export",
        title: COPY.export,
        hint: COPY.exportHint,
        choices: [
          { id: "print", label: COPY.print, detail: "پس‌زمینه سفید، فقط برنامه", action: COPY.print },
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

    if (buildBtn) buildBtn.addEventListener("click", onBuild);
    if (exportBtn) exportBtn.addEventListener("click", openExport);
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
      if (Array.isArray(list)) plan.remember(list);
    });

    doc.addEventListener("click", function (event) {
      var target = event && event.target;
      if (!target) return;
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
      if (sheet.hidden) return;
      var choice = matchTestId(target, "plan-choice");
      if (!choice) return;
      var id = nodeValue(choice, "choice", "data-choice");
      var handler = onChoice;
      closeSheet();
      if (handler && id) handler(id);
    });

    render();
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
    api.active = plan;
    mount(document, plan);
  }

  var api = {
    COPY: COPY,
    DAYS: DAYS,
    STORAGE_KEY: STORAGE_KEY,
    MAX_RECIPES: MAX_RECIPES,
    createPlan: createPlan,
    createMemoryStorage: createMemoryStorage,
    budgetLine: budgetLine,
    renderWeek: renderWeek,
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
