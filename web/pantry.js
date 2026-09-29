/* Client-side pantry for آشپزخونه (US-02 chips, US-04 week budget stub).
   State stays in localStorage. Recipe generation is out of scope. */
(function (global) {
  "use strict";

  var STORAGE_KEY = "ashpaz-khoone.pantry.v1";
  var MAX_NAME_LENGTH = 40;
  var MAX_BUDGET = 1000000000000;

  var SEED_STAPLES = Object.freeze([
    "برنج",
    "پیاز",
    "عدس",
    "لوبیا",
    "سیب\u200cزمینی",
    "گوجه\u200cفرنگی",
    "ماست",
    "روغن",
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
    return displayName(value)
      .replace(/[\u200c\u200d]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function toAsciiDigits(value) {
    return String(value)
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

  function emptyState() {
    return { items: [], budget: "" };
  }

  function sanitizeState(parsed) {
    var state = emptyState();
    if (!parsed || typeof parsed !== "object") return state;

    var seen = Object.create(null);
    if (Array.isArray(parsed.items)) {
      parsed.items.forEach(function (item) {
        if (typeof item !== "string") return;
        var name = displayName(item);
        var key = identityKey(name);
        if (!key || name.length > MAX_NAME_LENGTH || seen[key]) return;
        seen[key] = true;
        state.items.push(name);
      });
    }

    if (typeof parsed.budget === "string" && /^\d+$/.test(parsed.budget)) {
      var value = Number(parsed.budget);
      if (value >= 0 && value <= MAX_BUDGET) {
        state.budget = String(value);
      }
    }

    return state;
  }

  function createPantry(options) {
    var storage = options && options.storage;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      storage = createMemoryStorage();
    }

    var state = load();

    function load() {
      try {
        var raw = storage.getItem(STORAGE_KEY);
        if (!raw) return emptyState();
        return sanitizeState(JSON.parse(raw));
      } catch (err) {
        return emptyState();
      }
    }

    function persist() {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        /* Quota or privacy mode: keep the in-memory list for this visit. */
      }
    }

    function findIndex(name) {
      var key = identityKey(name);
      if (!key) return -1;
      for (var i = 0; i < state.items.length; i += 1) {
        if (identityKey(state.items[i]) === key) return i;
      }
      return -1;
    }

    return {
      items: function () {
        return state.items.slice();
      },
      budget: function () {
        return state.budget;
      },
      add: function (raw) {
        var name = displayName(raw);
        if (!name || !identityKey(name)) return { ok: false, reason: "empty" };
        if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "too_long" };
        var index = findIndex(name);
        if (index !== -1) {
          return { ok: false, reason: "duplicate", name: state.items[index] };
        }
        state.items.push(name);
        persist();
        return { ok: true, reason: "added", name: name };
      },
      remove: function (raw) {
        var index = findIndex(raw);
        if (index === -1) return false;
        state.items.splice(index, 1);
        persist();
        return true;
      },
      clear: function () {
        state.items = [];
        persist();
      },
      seed: function () {
        var added = [];
        SEED_STAPLES.forEach(function (staple) {
          if (findIndex(staple) === -1) {
            state.items.push(staple);
            added.push(staple);
          }
        });
        if (added.length) persist();
        return { added: added };
      },
      setBudget: function (raw) {
        var text = toAsciiDigits(raw == null ? "" : raw).replace(/[\s,٬،]/g, "");
        if (!text) {
          state.budget = "";
          persist();
          return { ok: true, budget: "" };
        }
        if (!/^\d+$/.test(text)) {
          return { ok: false, reason: "invalid", budget: state.budget };
        }
        var value = Number(text);
        if (!isFinite(value) || value < 0 || value > MAX_BUDGET) {
          return { ok: false, reason: "invalid", budget: state.budget };
        }
        state.budget = String(value);
        persist();
        return { ok: true, budget: state.budget };
      },
    };
  }

  function mount(doc, pantry) {
    var form = doc.getElementById("add-form");
    var input = doc.getElementById("ingredient");
    var chips = doc.getElementById("chips");
    var empty = doc.getElementById("empty");
    var status = doc.getElementById("status");
    var budgetInput = doc.getElementById("week-budget");
    var seedBtn = doc.getElementById("seed");
    var clearBtn = doc.getElementById("clear");
    var emptyActions = doc.getElementById("empty-actions");
    var actions = doc.getElementById("actions");
    var hint = doc.getElementById("chip-hint");
    var count = doc.getElementById("count");

    if (!form || !input || !chips || !empty || !status || !budgetInput || !seedBtn || !clearBtn) {
      return;
    }

    budgetInput.value = pantry.budget();

    function setStatus(message) {
      status.textContent = message || "";
    }

    function render(flashName) {
      var items = pantry.items();
      var fragment = doc.createDocumentFragment();

      items.forEach(function (name) {
        var li = doc.createElement("li");
        var button = doc.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.dataset.testid = "pantry-chip";
        button.dataset.name = name;
        button.setAttribute("aria-label", "حذف " + name);
        if (flashName && identityKey(flashName) === identityKey(name)) {
          button.classList.add("is-flash");
        }

        var label = doc.createElement("span");
        label.className = "chip-name";
        label.textContent = name;

        var mark = doc.createElement("span");
        mark.className = "chip-remove";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "×";

        button.append(label, mark);
        button.addEventListener("click", function (event) {
          pantry.remove(name);
          setStatus("«" + name + "» حذف شد");
          render();
          if (event.detail === 0) input.focus();
        });

        li.append(button);
        fragment.append(li);
      });

      chips.replaceChildren(fragment);

      var isEmpty = items.length === 0;
      if (isEmpty && emptyActions) {
        emptyActions.append(seedBtn);
      } else if (actions) {
        actions.insertBefore(seedBtn, clearBtn);
      }
      seedBtn.classList.toggle("is-emphasis", isEmpty);
      if (actions) actions.hidden = isEmpty;
      empty.hidden = !isEmpty;
      chips.hidden = isEmpty;
      if (hint) hint.hidden = isEmpty;
      clearBtn.disabled = isEmpty;

      if (count) {
        count.hidden = isEmpty;
        count.textContent = toPersianDigits(items.length);
      }
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var result = pantry.add(input.value);
      if (result.reason === "empty") {
        setStatus("نام ماده را بنویسید");
        input.focus();
        return;
      }
      if (result.reason === "too_long") {
        setStatus("نام ماده خیلی بلند است");
        input.focus();
        return;
      }
      if (result.reason === "duplicate") {
        setStatus("این ماده از قبل در آشپزخانه است");
        render(result.name);
        input.focus();
        input.select();
        return;
      }
      input.value = "";
      setStatus("«" + result.name + "» اضافه شد");
      render();
      input.focus();
    });

    seedBtn.addEventListener("click", function () {
      var result = pantry.seed();
      if (!result.added.length) {
        setStatus("مواد نمونه از قبل در آشپزخانه است");
      } else {
        setStatus("مواد نمونه بارگذاری شد");
      }
      render();
    });

    clearBtn.addEventListener("click", function () {
      pantry.clear();
      input.value = "";
      setStatus("آشپزخانه خالی شد");
      render();
    });

    budgetInput.addEventListener("input", function () {
      var result = pantry.setBudget(budgetInput.value);
      if (!result.ok || budgetInput.value !== result.budget) {
        var next = result.budget;
        if (budgetInput.value !== next) budgetInput.value = next;
      }
    });

    render();
  }

  function boot() {
    var storage = createMemoryStorage();
    try {
      if (global.localStorage) {
        var probe = "ashpaz-khoone.probe";
        global.localStorage.setItem(probe, "1");
        global.localStorage.removeItem(probe);
        storage = global.localStorage;
      }
    } catch (err) {
      storage = createMemoryStorage();
    }
    mount(document, createPantry({ storage: storage }));
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    SEED_STAPLES: SEED_STAPLES,
    createPantry: createPantry,
    createMemoryStorage: createMemoryStorage,
    identityKey: identityKey,
    displayName: displayName,
    mount: mount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazPantry = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
