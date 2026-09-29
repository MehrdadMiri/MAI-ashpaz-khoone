/* Shopping list for آشپزخونه (مواد خرید).
   Diffs pantry chips against ingredient lines stored on the 7-day plan.
   Every planned meal counts: صبحانه، ناهار، and شام.
   A flat { recipe } day is still accepted so an older dinner-only week
   keeps building the same list.
   Pure client-side: no fetch, no GapGPT, no API key.
   Recipe cards already keep ingredients. If a planned meal has an empty
   ingredient list, that slot is named in the UI and left off the list.
   A model call (gpt-5.6-luna through the shared GapGPT client) could
   invent those missing lines later; it is not wired, so a gap stays
   visible instead of being filled in with guessed items. */
(function (global) {
  "use strict";

  var COPY = {
    title: "مواد خرید",
    hint: "آنچه برای وعده‌های این هفته در آشپزخانه نیست.",
    open: "مواد خرید",
    export: "چاپ / خروجی",
    print: "چاپ",
    download: "دانلود مارک‌داون",
    cancel: "انصراف",
    filename: "مواد-خرید.md",
    exportHint:
      "چاپ، پس‌زمینه سفید و خط فارسی است و فقط مواد خرید را نشان می‌دهد. خروجی یک فایل مارک‌داون از همان فهرست است.",
    emptyPlanTitle: "برنامه هفته خالی است",
    emptyPlanHelp: "اول صبحانه، ناهار یا شام شنبه تا جمعه را بچینید تا مواد خرید از روی همان برنامه ساخته شود.",
    emptyBothTitle: "برنامه و آشپزخانه خالی است",
    emptyBothHelp: "مواد را به آشپزخانه اضافه کنید و وعده‌های روزها را بچینید. بعد، آنچه کم است اینجا می‌آید.",
    emptyPantryTitle: "آشپزخانه خالی است",
    emptyPantryHelp: "چون انباری نیست، همه مواد برنامه در فهرست خرید آمده‌اند.",
    coveredTitle: "چیزی برای خرید نمانده",
    coveredHelp: "مواد وعده‌های این هفته در آشپزخانه هست.",
    missingTitle: "مواد این وعده‌ها در برنامه نیست",
    missingHelp: "فهرست خرید از مواد ذخیره‌شده روی هر دستور ساخته می‌شود و برای این وعده‌ها چیزی ساخته نشد.",
    skipped: "مواد این غذاها در برنامه ذخیره نشده و به فهرست اضافه نشدند.",
    countSuffix: "ماده برای خرید",
  };

  var CATEGORY_DEFS = [
    {
      id: "produce",
      label: "سبزی و صیفی",
      words: [
        "پیازچه",
        "پیاز",
        "سیر",
        "گوجه‌فرنگی",
        "گوجه فرنگی",
        "گوجه",
        "سیب‌زمینی",
        "سیب زمینی",
        "هویج",
        "خیار",
        "جعفری",
        "گشنیز",
        "شوید",
        "نعناع",
        "نعنا",
        "ریحان",
        "کاهو",
        "کلم",
        "فلفل دلمه‌ای",
        "فلفل دلمه",
        "بادمجان",
        "کدو سبز",
        "کدو",
        "قارچ",
        "لوبیا سبز",
        "نخود فرنگی",
        "ذرت",
        "کرفس",
        "اسفناج",
        "چغندر",
        "شلغم",
        "تربچه",
        "ترب",
        "بروکلی",
        "گل کلم",
        "بامیه",
        "سبزی",
        "تره",
        "زیتون",
        "لیمو",
      ],
    },
    {
      id: "fruit",
      label: "میوه",
      words: [
        "توت فرنگی",
        "لیمو شیرین",
        "پرتقال",
        "نارنگی",
        "هندوانه",
        "خربزه",
        "انگور",
        "زردآلو",
        "آلبالو",
        "گیلاس",
        "آناناس",
        "طالبی",
        "انار",
        "خرما",
        "انجیر",
        "هلو",
        "شلیل",
        "گلابی",
        "کیوی",
        "موز",
        "توت",
        "سیب",
      ],
    },
    {
      id: "protein",
      label: "پروتئین",
      words: [
        "تخم‌مرغ",
        "تخم مرغ",
        "گوشت چرخ‌کرده",
        "گوشت",
        "مرغ",
        "ماهی",
        "میگو",
        "جوجه",
        "گوسفند",
        "گوساله",
        "بوقلمون",
        "سوسیس",
        "کالباس",
        "تن ماهی",
        "جگر",
        "ماهیچه",
        "دل",
      ],
    },
    {
      id: "dairy",
      label: "لبنیات",
      words: ["ماست", "پنیر", "کره", "خامه", "دوغ", "کشک", "قره‌قروت", "شیر"],
    },
    {
      id: "grains",
      label: "حبوبات و غلات",
      words: [
        "برنج",
        "عدس",
        "لوبیا",
        "نخود",
        "ماش",
        "گندم",
        "بلغور",
        "رشته",
        "لپه",
        "باقالا",
        "سویا",
        "ماکارونی",
        "جو",
      ],
    },
    {
      id: "bread",
      label: "نان و آرد",
      words: ["شیرینی", "بربری", "سنگک", "تافتون", "لواش", "باگت", "آرد", "نان"],
    },
    {
      id: "spice",
      label: "چاشنی و ادویه",
      words: [
        "آب لیمو",
        "آبلیمو",
        "آب غوره",
        "آبغوره",
        "رب گوجه",
        "رب انار",
        "زردچوبه",
        "زعفران",
        "دارچین",
        "زیره",
        "سرکه",
        "سماق",
        "زنجبیل",
        "شکر",
        "عسل",
        "روغن",
        "نمک",
        "فلفل",
        "پودر",
        "رب",
        "هل",
        "قند",
      ],
    },
    {
      id: "nuts",
      label: "خشکبار",
      words: ["بادام زمینی", "گردو", "کشمش", "پسته", "بادام", "فندق", "تخمه", "کنجد", "نارگیل", "مویز"],
    },
    { id: "other", label: "سایر", words: [] },
  ];

  var UNIT_FORMS = [
    ["قاشق غذاخوری", "قاشق غذاخوری"],
    ["قاشق چای خوری", "قاشق چای‌خوری"],
    ["قاشق سوپ خوری", "قاشق غذاخوری"],
    ["میلی لیتر", "میلی‌لیتر"],
    ["کیلوگرم", "کیلوگرم"],
    ["کیلو گرم", "کیلوگرم"],
    ["پیمانه", "پیمانه"],
    ["استکان", "استکان"],
    ["فنجان", "فنجان"],
    ["لیوان", "لیوان"],
    ["قاشق", "قاشق"],
    ["گرمی", "گرم"],
    ["کیلو", "کیلو"],
    ["گرم", "گرم"],
    ["لیتر", "لیتر"],
    ["بسته", "بسته"],
    ["مثقال", "مثقال"],
    ["عدد", "عدد"],
    ["حبه", "حبه"],
    ["برگ", "برگ"],
    ["مشت", "مشت"],
    ["بوته", "بوته"],
    ["دانه", "دانه"],
    ["برش", "برش"],
    ["خلال", "خلال"],
    ["قالب", "قالب"],
    ["سیخ", "سیخ"],
  ];

  var DROP_WORDS = [
    "متوسط",
    "بزرگ",
    "کوچک",
    "درشت",
    "ریز",
    "کمی",
    "اندکی",
    "مقدار",
    "لازم",
    "اختیاری",
    "حدود",
    "تقریبا",
  ];

  var MATCH_QUALIFIERS = [
    "متوسط",
    "بزرگ",
    "کوچک",
    "درشت",
    "ریز",
    "تازه",
    "خشک",
    "قرمز",
    "سفید",
    "سیاه",
    "نگینی",
    "داغ",
    "مایع",
    "جامد",
    "حلقه",
    "خرد",
    "شده",
    "پخته",
    "خام",
    "خلال",
    "کمی",
    "اندکی",
    "ایرانی",
    "خانگی",
    "محلی",
    "پاک",
  ];

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

  function keysOf(words) {
    var seen = Object.create(null);
    var list = [];
    words.forEach(function (word) {
      var key = identityKey(word);
      if (!key || key.length < 2 || seen[key]) return;
      seen[key] = true;
      list.push(key);
    });
    list.sort(function (a, b) {
      return b.length - a.length;
    });
    return list;
  }

  var CATEGORIES = CATEGORY_DEFS.map(function (cat) {
    return { id: cat.id, label: cat.label, words: keysOf(cat.words) };
  });
  var DROP_KEYS = keysOf(DROP_WORDS);
  var QUALIFIER_KEYS = keysOf(MATCH_QUALIFIERS);

  function prep(value) {
    var text = toAsciiDigits(String(value || ""))
      .replace(/[()（）[\]«»]/g, " ")
      .replace(/\u200c/g, " ");
    text = displayName(text);
    text = text.replace(/^(حدود|تقریبا)\s+/, "");
    return text;
  }

  function parseNumberToken(text) {
    if (!text) return null;
    var fraction = { "½": 0.5, "¼": 0.25, "¾": 0.75 };
    if (Object.prototype.hasOwnProperty.call(fraction, text.charAt(0))) {
      return { value: fraction[text.charAt(0)], length: 1 };
    }
    var slash = text.match(/^(\d+)\s*\/\s*(\d+)/);
    if (slash && Number(slash[2])) {
      return { value: Number(slash[1]) / Number(slash[2]), length: slash[0].length };
    }
    var digit = text.match(/^(\d+(?:[.,]\d+)?)/);
    if (digit) {
      var num = Number(digit[1].replace(",", "."));
      if (isFinite(num)) return { value: num, length: digit[1].length };
    }
    var phrase = text.match(/^یک\s+و\s+نیم/);
    if (phrase) return { value: 1.5, length: phrase[0].length };
    var words = [
      ["نصف", 0.5],
      ["نیم", 0.5],
      ["ده", 10],
      ["نه", 9],
      ["هشت", 8],
      ["هفت", 7],
      ["شش", 6],
      ["پنج", 5],
      ["چهار", 4],
      ["سه", 3],
      ["دو", 2],
      ["یک", 1],
    ];
    for (var i = 0; i < words.length; i += 1) {
      if (text.indexOf(words[i][0]) !== 0) continue;
      var next = text.charAt(words[i][0].length);
      if (next && next !== " ") continue;
      return { value: words[i][1], length: words[i][0].length };
    }
    return null;
  }

  function matchUnit(text) {
    for (var i = 0; i < UNIT_FORMS.length; i += 1) {
      var form = UNIT_FORMS[i][0];
      if (text.indexOf(form) !== 0) continue;
      var next = text.charAt(form.length);
      if (next && next !== " ") continue;
      return { unit: UNIT_FORMS[i][1], length: form.length };
    }
    return null;
  }

  function cleanFoodName(name) {
    var text = displayName(name).replace(/به\s*مقدار\s*لازم/g, " ");
    var parts = text.split(/\s+/).filter(Boolean);
    var kept = [];
    parts.forEach(function (part) {
      var key = identityKey(part);
      if (!key || DROP_KEYS.indexOf(key) !== -1) return;
      kept.push(part);
    });
    if (!kept.length) return "";
    return displayName(kept.join(" "));
  }

  function finishParsed(parsed) {
    var name = cleanFoodName(parsed.name);
    if (!name || !/[\u0600-\u06FFA-Za-z]/.test(name)) return null;
    return {
      name: name,
      qty: parsed.qty == null ? null : parsed.qty,
      unit: parsed.unit || "",
    };
  }

  function parseLeading(text) {
    var num = parseNumberToken(text);
    if (!num) return null;
    var rest = text.slice(num.length).replace(/^\s+/, "");
    var unit = "";
    var matched = matchUnit(rest);
    if (matched) {
      unit = matched.unit;
      rest = rest.slice(matched.length).replace(/^\s+/, "");
    }
    if (!rest) return null;
    return finishParsed({ qty: num.value, unit: unit, name: rest });
  }

  function parseTrailing(text) {
    var tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;
    var unit = "";
    var last = tokens[tokens.length - 1];
    var matched = matchUnit(last);
    if (matched && matched.length === last.length) {
      unit = matched.unit;
      tokens = tokens.slice(0, -1);
      if (!tokens.length) return null;
      last = tokens[tokens.length - 1];
    }
    var num = parseNumberToken(last);
    if (!num || num.length !== last.length) return null;
    tokens = tokens.slice(0, -1);
    if (!tokens.length) return null;
    return finishParsed({ qty: num.value, unit: unit, name: tokens.join(" ") });
  }

  function parseIngredient(raw) {
    var text = prep(raw);
    if (!text) return null;
    return parseLeading(text) || parseTrailing(text) || finishParsed({ qty: null, unit: "", name: text });
  }

  function splitParts(text) {
    var shielded = text.replace(/یک\s+و\s+نیم/g, "یک\u0000نیم");
    return shielded
      .split(/\s*(?:،|,|؛|;)\s*|\s+و\s+/)
      .map(function (part) {
        return part.replace(/\u0000/g, " و ").trim();
      })
      .filter(Boolean);
  }

  function expandLine(raw) {
    var text = prep(raw);
    if (!text) return [];
    var items = [];
    splitParts(text).forEach(function (part) {
      var parsed = parseIngredient(part);
      if (parsed) items.push(parsed);
    });
    return items;
  }

  function isQualifierRest(rest) {
    var guard = 0;
    while (rest && guard < 8) {
      guard += 1;
      var ate = false;
      for (var i = 0; i < QUALIFIER_KEYS.length; i += 1) {
        var word = QUALIFIER_KEYS[i];
        if (rest.indexOf(word) !== 0) continue;
        rest = rest.slice(word.length);
        ate = true;
        break;
      }
      if (!ate) return false;
    }
    return !rest;
  }

  function keyCovered(ingredientKey, pantryKey) {
    if (!ingredientKey || !pantryKey || pantryKey.length < 2) return false;
    if (ingredientKey === pantryKey) return true;
    if (ingredientKey.length >= 3 && pantryKey.indexOf(ingredientKey) === 0) return true;
    if (ingredientKey.indexOf(pantryKey) === 0) return isQualifierRest(ingredientKey.slice(pantryKey.length));
    return false;
  }

  function lineUsesChip(chip, line) {
    var chipKey = identityKey(chip);
    if (!chipKey || chipKey.length < 2) return false;
    var items = expandLine(line);
    if (!items.length) {
      var name = displayName(line);
      if (!name) return false;
      items = [{ name: name }];
    }
    for (var i = 0; i < items.length; i += 1) {
      if (keyCovered(identityKey(items[i].name), chipKey)) return true;
    }
    return false;
  }

  function coveredByPantry(name, pantryKeys) {
    var key = identityKey(name);
    for (var i = 0; i < pantryKeys.length; i += 1) {
      if (keyCovered(key, pantryKeys[i])) return true;
    }
    return false;
  }

  function categorize(name) {
    var key = identityKey(name);
    var bestId = "other";
    var bestScore = 0;
    CATEGORIES.forEach(function (cat) {
      cat.words.forEach(function (word) {
        if (key.indexOf(word) !== 0) return;
        if (word.length > bestScore) {
          bestScore = word.length;
          bestId = cat.id;
        }
      });
    });
    return bestId;
  }

  function roundQty(value) {
    return Math.round(value * 100) / 100;
  }

  function formatQuantity(qty, unit) {
    var rounded = roundQty(qty);
    var text;
    if (Math.abs(rounded - 0.5) < 0.001) text = "نیم";
    else if (Math.abs(rounded - 1.5) < 0.001) text = "یک و نیم";
    else if (Math.abs(rounded - Math.round(rounded)) < 0.001) {
      text = String(Math.round(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
      text = toPersianDigits(text);
    } else {
      var bits = String(rounded).split(".");
      bits[0] = bits[0].replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
      text = toPersianDigits(bits[0] + "٫" + bits[1]);
    }
    if (unit) return text + " " + unit;
    return text;
  }

  function forMeals(count) {
    return "برای " + toPersianDigits(count) + " وعده";
  }

  function quantityLabel(parts, bare) {
    var sums = Object.create(null);
    var order = [];
    parts.forEach(function (part) {
      var unit = part.unit || "";
      if (!Object.prototype.hasOwnProperty.call(sums, unit)) {
        sums[unit] = 0;
        order.push(unit);
      }
      sums[unit] += part.qty;
    });
    if (!order.length) return bare > 1 ? forMeals(bare) : "";
    if (order.length === 1 && !bare) return formatQuantity(sums[order[0]], order[0]);
    var bits = order.map(function (unit) {
      return formatQuantity(sums[unit], unit);
    });
    if (bare > 0) bits.push(forMeals(bare));
    return bits.join(" + ");
  }

  function metaLine(days, titles) {
    var groups = [];
    var index = Object.create(null);
    for (var i = 0; i < days.length; i += 1) {
      var title = titles[i] || "وعده";
      if (index[title] == null) {
        index[title] = groups.length;
        groups.push({ title: title, days: [] });
      }
      var group = groups[index[title]];
      if (days[i] && group.days.indexOf(days[i]) === -1) group.days.push(days[i]);
    }
    return groups
      .map(function (group) {
        if (!group.days.length) return group.title;
        return group.title + " (" + group.days.join("، ") + ")";
      })
      .join("؛ ");
  }

  function ingredientSource(recipe) {
    if (!recipe || typeof recipe !== "object") return null;
    var value = recipe.ingredients;
    if (typeof value === "string") return value.trim() ? [value] : [];
    if (!Array.isArray(value)) return null;
    return value;
  }

  function plannedDishes(day) {
    if (!day) return [];
    if (Array.isArray(day.meals)) {
      var rows = [];
      day.meals.forEach(function (meal) {
        if (!meal || !meal.recipe) return;
        var dayLabel = day.label || "";
        var mealLabel = meal.label || "";
        var label = dayLabel && mealLabel ? dayLabel + " · " + mealLabel : dayLabel || mealLabel;
        rows.push({
          label: label,
          recipe: meal.recipe,
          fallbackTitle: mealLabel || "وعده",
        });
      });
      return rows;
    }
    if (day.recipe) {
      return [{ label: day.label || "", recipe: day.recipe, fallbackTitle: "شام" }];
    }
    return [];
  }

  function buildShoppingList(pantryItems, week) {
    var pantryNames = [];
    var pantryKeys = [];
    (Array.isArray(pantryItems) ? pantryItems : []).forEach(function (item) {
      var name = displayName(item);
      var key = identityKey(name);
      if (!key) return;
      pantryNames.push(name);
      pantryKeys.push(key);
    });

    var planEmpty = true;
    var hadIngredients = false;
    var skipped = [];
    var buckets = Object.create(null);
    var order = [];

    (Array.isArray(week) ? week : []).forEach(function (day) {
      plannedDishes(day).forEach(function (dish) {
      planEmpty = false;
      var lines = ingredientSource(dish.recipe);
      var usable = [];
      if (lines) {
        lines.forEach(function (line) {
          if (displayName(line)) usable.push(line);
        });
      }
      if (!usable.length) {
        skipped.push({
          day: dish.label || "",
          title: displayName(dish.recipe.title) || dish.fallbackTitle,
        });
        return;
      }
      hadIngredients = true;
      var local = Object.create(null);
      usable.forEach(function (line) {
        expandLine(line).forEach(function (parsed) {
          var key = identityKey(parsed.name);
          if (!key || coveredByPantry(parsed.name, pantryKeys)) return;
          if (!local[key]) local[key] = { name: parsed.name, parts: [] , bare: 0 };
          if (parsed.name.length < local[key].name.length) local[key].name = parsed.name;
          if (parsed.qty != null && isFinite(parsed.qty)) local[key].parts.push({ qty: parsed.qty, unit: parsed.unit || "" });
          else local[key].bare += 1;
        });
      });
      Object.keys(local).forEach(function (key) {
        if (!buckets[key]) {
          buckets[key] = {
            key: key,
            name: local[key].name,
            parts: [],
            bare: 0,
            days: [],
            titles: [],
          };
          order.push(key);
        }
        var bucket = buckets[key];
        if (local[key].name.length < bucket.name.length) bucket.name = local[key].name;
        if (local[key].parts.length) {
          local[key].parts.forEach(function (part) {
            bucket.parts.push(part);
          });
        } else {
          bucket.bare += 1;
        }
        bucket.days.push(dish.label || "");
        bucket.titles.push(displayName(dish.recipe.title) || dish.fallbackTitle);
      });
      });
    });

    var grouped = CATEGORIES.map(function (cat) {
      return { id: cat.id, label: cat.label, items: [] };
    });
    var byId = Object.create(null);
    grouped.forEach(function (cat) {
      byId[cat.id] = cat;
    });
    order.forEach(function (key) {
      var bucket = buckets[key];
      var cat = byId[categorize(bucket.name)] || byId.other;
      cat.items.push({
        name: bucket.name,
        quantityLabel: quantityLabel(bucket.parts, bucket.bare),
        meta: metaLine(bucket.days, bucket.titles),
      });
    });
    grouped.forEach(function (cat) {
      cat.items.sort(function (a, b) {
        return a.name.localeCompare(b.name, "fa");
      });
    });
    var categories = grouped.filter(function (cat) {
      return cat.items.length > 0;
    });
    var itemCount = 0;
    categories.forEach(function (cat) {
      itemCount += cat.items.length;
    });

    var pantryEmpty = pantryNames.length === 0;
    var state = "covered";
    if (planEmpty && pantryEmpty) state = "empty-both";
    else if (planEmpty) state = "empty-plan";
    else if (itemCount > 0 && pantryEmpty) state = "list-pantry-empty";
    else if (itemCount > 0) state = "list";
    else if (!hadIngredients) state = "missing";

    return {
      state: state,
      pantryEmpty: pantryEmpty,
      planEmpty: planEmpty,
      hadIngredients: hadIngredients,
      itemCount: itemCount,
      categories: categories,
      skipped: skipped,
    };
  }

  function mdInline(value) {
    return String(value || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/[*_`]/g, "");
  }

  function markdownDocument(result) {
    var lines = ["# " + COPY.title, ""];
    if (result.state === "empty-both") {
      lines.push(COPY.emptyBothTitle + ".");
      lines.push("");
      lines.push(COPY.emptyBothHelp);
      lines.push("");
      return lines.join("\n");
    }
    if (result.state === "empty-plan") {
      lines.push(COPY.emptyPlanTitle + ".");
      lines.push("");
      lines.push(COPY.emptyPlanHelp);
      lines.push("");
      return lines.join("\n");
    }
    if (result.pantryEmpty && result.itemCount > 0) {
      lines.push(COPY.emptyPantryTitle + ".");
      lines.push("");
      lines.push(COPY.emptyPantryHelp);
      lines.push("");
    }
    if (result.state === "missing") {
      lines.push(COPY.missingTitle + ".");
      lines.push("");
      lines.push(COPY.missingHelp);
      lines.push("");
    } else if (result.state === "covered") {
      lines.push(COPY.coveredTitle + ".");
      lines.push("");
      lines.push(COPY.coveredHelp);
      lines.push("");
    }
    result.categories.forEach(function (cat) {
      lines.push("## " + cat.label);
      lines.push("");
      cat.items.forEach(function (item) {
        var line = "- **" + mdInline(item.name) + "**";
        if (item.quantityLabel) line += " — " + item.quantityLabel;
        lines.push(line);
        if (item.meta) lines.push("  - " + mdInline(item.meta));
      });
      lines.push("");
    });
    if (result.skipped.length) {
      lines.push(COPY.skipped);
      lines.push("");
      result.skipped.forEach(function (row) {
        var label = mdInline(row.title);
        if (row.day) label += " (" + mdInline(row.day) + ")";
        lines.push("- " + label);
      });
      lines.push("");
    }
    return lines.join("\n");
  }

  function readPantry(hooks) {
    if (hooks && typeof hooks.pantry === "function") {
      var injected = hooks.pantry();
      return Array.isArray(injected) ? injected : [];
    }
    var pantryApi = global.AshpazPantry;
    var pantry = pantryApi && pantryApi.active;
    if (!pantry || typeof pantry.items !== "function") return [];
    return pantry.items();
  }

  function readWeek(hooks) {
    if (hooks && typeof hooks.week === "function") {
      var injected = hooks.week();
      return Array.isArray(injected) ? injected : [];
    }
    var planApi = global.AshpazPlan;
    var plan = planApi && planApi.active;
    if (!plan || typeof plan.week !== "function") return [];
    return plan.week();
  }

  function currentList(hooks) {
    return buildShoppingList(readPantry(hooks), readWeek(hooks));
  }

  function emptyCopy(result) {
    if (result.state === "empty-both") return { title: COPY.emptyBothTitle, help: COPY.emptyBothHelp };
    if (result.state === "empty-plan") return { title: COPY.emptyPlanTitle, help: COPY.emptyPlanHelp };
    if (result.state === "missing") return { title: COPY.missingTitle, help: COPY.missingHelp };
    if (result.state === "covered") return { title: COPY.coveredTitle, help: COPY.coveredHelp };
    return null;
  }

  function renderList(doc, listEl, result) {
    var blocks = result.categories.map(function (cat) {
      var section = doc.createElement("section");
      section.className = "shop-group";
      section.dataset.testid = "shop-group";
      section.dataset.category = cat.id;

      var heading = doc.createElement("h3");
      heading.className = "shop-category";
      heading.dataset.testid = "shop-category";
      heading.textContent = cat.label;

      var ul = doc.createElement("ul");
      ul.className = "shop-items";
      cat.items.forEach(function (item) {
        var li = doc.createElement("li");
        li.className = "shop-item";
        li.dataset.testid = "shop-item";

        var name = doc.createElement("span");
        name.className = "shop-item-name";
        name.dataset.testid = "shop-item-name";
        name.textContent = item.name;

        li.append(name);
        if (item.quantityLabel) {
          var qty = doc.createElement("span");
          qty.className = "shop-item-qty";
          qty.dataset.testid = "shop-item-qty";
          qty.textContent = item.quantityLabel;
          li.append(qty);
        }
        if (item.meta) {
          var meta = doc.createElement("span");
          meta.className = "shop-item-meta";
          meta.dataset.testid = "shop-item-meta";
          meta.textContent = item.meta;
          li.append(meta);
        }
        ul.append(li);
      });
      section.append(heading, ul);
      return section;
    });
    listEl.replaceChildren.apply(listEl, blocks);
  }

  function renderSkipped(doc, box, titleEl, listEl, skipped) {
    if (!box || !listEl) return;
    if (!skipped || !skipped.length) {
      box.hidden = true;
      listEl.replaceChildren();
      if (titleEl) titleEl.textContent = "";
      return;
    }
    if (titleEl) titleEl.textContent = COPY.skipped;
    var rows = skipped.map(function (row) {
      var li = doc.createElement("li");
      li.dataset.testid = "shop-skipped-item";
      li.textContent = row.day ? row.title + " (" + row.day + ")" : row.title;
      return li;
    });
    listEl.replaceChildren.apply(listEl, rows);
    box.hidden = false;
  }

  function applyResult(doc, els, result) {
    if (els.section && els.section.dataset) els.section.dataset.state = result.state;
    var copy = emptyCopy(result);
    var showEmpty = !!copy;
    if (els.empty) els.empty.hidden = !showEmpty;
    if (showEmpty && els.emptyTitle) els.emptyTitle.textContent = copy.title;
    if (showEmpty && els.emptyHelp) els.emptyHelp.textContent = copy.help;
    if (els.pantryNote) els.pantryNote.hidden = result.state !== "list-pantry-empty";
    if (els.list) {
      if (result.itemCount) {
        renderList(doc, els.list, result);
        els.list.hidden = false;
      } else {
        els.list.replaceChildren();
        els.list.hidden = true;
      }
    }
    renderSkipped(doc, els.skipped, els.skippedTitle, els.skippedList, result.skipped);
    if (els.count) {
      els.count.hidden = result.itemCount === 0;
      els.count.textContent = result.itemCount ? toPersianDigits(result.itemCount) : "";
    }
    if (els.status) {
      els.status.textContent = result.itemCount ? toPersianDigits(result.itemCount) + " " + COPY.countSuffix : "";
    }
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

  function choiceRow(doc, choice) {
    var button = doc.createElement("button");
    button.type = "button";
    button.className = "plan-choice";
    button.dataset.testid = "shop-choice";
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
    else if (link.parentNode && typeof link.parentNode.removeChild === "function") link.parentNode.removeChild(link);
    urlApi.revokeObjectURL(url);
  }

  function mount(doc, hooks) {
    hooks = hooks || {};
    var section = doc.getElementById("shop");
    var listEl = doc.getElementById("shop-list");
    var emptyEl = doc.getElementById("shop-empty");
    var sheet = doc.getElementById("shop-sheet");
    var titleEl = doc.getElementById("shop-sheet-title");
    var hintEl = doc.getElementById("shop-sheet-hint");
    var choiceList = doc.getElementById("shop-sheet-list");
    if (!section || !listEl || !emptyEl) return;

    var els = {
      section: section,
      list: listEl,
      empty: emptyEl,
      emptyTitle: doc.getElementById("shop-empty-title"),
      emptyHelp: doc.getElementById("shop-empty-help"),
      pantryNote: doc.getElementById("shop-pantry-note"),
      skipped: doc.getElementById("shop-skipped"),
      skippedTitle: doc.getElementById("shop-skipped-title"),
      skippedList: doc.getElementById("shop-skipped-list"),
      count: doc.getElementById("shop-count"),
      status: doc.getElementById("shop-status"),
    };
    var openBtn = doc.getElementById("shop-open");
    var exportBtn = doc.getElementById("shop-export");
    var closeBtn = doc.getElementById("shop-sheet-close");
    var cancelBtn = doc.getElementById("shop-sheet-cancel");
    var onChoice = null;

    function render() {
      applyResult(doc, els, currentList(hooks));
    }

    function reveal() {
      if (typeof section.scrollIntoView === "function") {
        try {
          section.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (err) {
          section.scrollIntoView();
        }
      }
      var heading = doc.getElementById("shop-title");
      if (heading && typeof heading.focus === "function") {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }

    function closeSheet() {
      if (!sheet) return;
      sheet.hidden = true;
      if (sheet.dataset) sheet.dataset.mode = "";
      onChoice = null;
    }

    function openSheet(opts) {
      if (!sheet || !titleEl || !choiceList) return;
      titleEl.textContent = opts.title;
      if (hintEl) {
        hintEl.textContent = opts.hint || "";
        hintEl.hidden = !opts.hint;
      }
      var rows = (opts.choices || []).map(function (choice) {
        return choiceRow(doc, choice);
      });
      choiceList.replaceChildren.apply(choiceList, rows);
      onChoice = typeof opts.onChoice === "function" ? opts.onChoice : null;
      if (sheet.dataset) sheet.dataset.mode = opts.mode || "";
      sheet.hidden = false;
      if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    }

    function doPrint() {
      setPrintMode(doc, "shop");
      if (typeof hooks.print === "function") {
        hooks.print();
        return;
      }
      var view = doc.defaultView;
      if (view && typeof view.print === "function") view.print();
      else if (typeof global.print === "function") global.print();
    }

    function doDownload() {
      var text = markdownDocument(currentList(hooks));
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
          { id: "print", label: COPY.print, detail: "پس‌زمینه سفید، فقط مواد خرید", action: COPY.print },
          { id: "download", label: COPY.download, detail: "فهرست دسته‌بندی‌شده", action: "دانلود" },
        ],
        onChoice: function (choice) {
          if (choice === "print") doPrint();
          if (choice === "download") doDownload();
        },
      });
    }

    if (openBtn) {
      openBtn.addEventListener("click", function () {
        render();
        reveal();
      });
    }
    if (exportBtn) exportBtn.addEventListener("click", openExport);
    if (closeBtn) closeBtn.addEventListener("click", closeSheet);
    if (cancelBtn) cancelBtn.addEventListener("click", closeSheet);
    if (sheet) {
      sheet.addEventListener("click", function (event) {
        if (event && event.target === sheet) closeSheet();
      });
    }

    doc.addEventListener("keydown", function (event) {
      if (!sheet || sheet.hidden) return;
      if (event && event.key === "Escape") {
        if (event.preventDefault) event.preventDefault();
        closeSheet();
      }
    });

    doc.addEventListener("click", function (event) {
      if (!sheet || sheet.hidden) return;
      var choice = matchTestId(event && event.target, "shop-choice");
      if (!choice) return;
      var id = nodeValue(choice, "choice", "data-choice");
      var handler = onChoice;
      closeSheet();
      if (handler && id) handler(id);
    });

    doc.addEventListener("ashpaz-pantry-changed", render);
    doc.addEventListener("ashpaz-plan-changed", render);
    watchPrintEnd(doc);
    render();
  }

  function boot() {
    api.active = true;
    mount(document);
  }

  var api = {
    COPY: COPY,
    CATEGORIES: CATEGORIES,
    buildShoppingList: buildShoppingList,
    lineUsesChip: lineUsesChip,
    markdownDocument: markdownDocument,
    parseIngredient: parseIngredient,
    expandLine: expandLine,
    mount: mount,
    setPrintMode: setPrintMode,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazShop = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
