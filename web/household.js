/* Household size (تعداد نفرات) for آشپزخونه.
   Default is 4 people. The allowed range is 1 to 12.
   A recipe's amounts and cost_toman are for its `servings` people.
   Older recipes with no servings are treated as 4, the same default.
   Display multiplies by تعداد نفرات / servings. This file does not
   call GapGPT and never sees an API key. */
(function (global) {
  "use strict";

  var DEFAULT_HOUSEHOLD = 4;
  var MIN_HOUSEHOLD = 1;
  var MAX_HOUSEHOLD = 12;
  var BASE_SERVINGS = 4;
  var MAX_COST = 1000000000000000;

  var WORD_NUMBERS = [
    ["یک و نیم", 1.5],
    ["يك و نيم", 1.5],
    ["نصف", 0.5],
    ["نیم", 0.5],
    ["نيم", 0.5],
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
    ["يك", 1],
  ];

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

  function parseHousehold(raw) {
    if (typeof raw === "boolean" || raw == null || raw === "") return null;
    if (typeof raw === "number") {
      if (!isFinite(raw) || Math.round(raw) !== raw) return null;
      if (raw < MIN_HOUSEHOLD || raw > MAX_HOUSEHOLD) return null;
      return raw;
    }
    var text = toAsciiDigits(raw).replace(/[\s,٬،]/g, "");
    if (!/^\d+$/.test(text)) return null;
    var value = Number(text);
    if (!isFinite(value) || value < MIN_HOUSEHOLD || value > MAX_HOUSEHOLD) return null;
    return value;
  }

  function householdOrDefault(raw) {
    var parsed = parseHousehold(raw);
    return parsed == null ? DEFAULT_HOUSEHOLD : parsed;
  }

  function servingsOf(servings) {
    var parsed = parseHousehold(servings);
    return parsed == null ? BASE_SERVINGS : parsed;
  }

  function scaleFactor(household, servings) {
    return householdOrDefault(household) / servingsOf(servings);
  }

  function scaleCost(cost, household, servings) {
    if (typeof cost !== "number" || !isFinite(cost)) return cost;
    var factor = scaleFactor(household, servings);
    var scaled = Math.round(cost * factor);
    if (!isFinite(scaled)) return Math.round(cost);
    if (scaled < 0) return 0;
    if (scaled > MAX_COST) return MAX_COST;
    return scaled;
  }

  function peoplePhrase(household) {
    return "برای " + toPersianDigits(householdOrDefault(household)) + " نفر";
  }

  function isBoundary(text, index) {
    if (index <= 0) return true;
    return /\s/.test(text.charAt(index - 1));
  }

  function endsToken(text, index) {
    if (index >= text.length) return true;
    return /\s/.test(text.charAt(index));
  }

  function formatQty(value) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) return null;
    var rounded = Math.round(value * 100) / 100;
    if (rounded <= 0) return null;
    if (Math.abs(rounded - 0.5) < 0.001) return "نیم";
    if (Math.abs(rounded - 1.5) < 0.001) return "یک و نیم";
    if (Math.abs(rounded - Math.round(rounded)) < 0.001) {
      var whole = String(Math.round(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
      return toPersianDigits(whole);
    }
    var bits = String(rounded).split(".");
    bits[0] = bits[0].replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
    return toPersianDigits(bits[0] + "٫" + bits[1]);
  }

  function matchNumber(text, index) {
    if (!isBoundary(text, index)) return null;
    var slice = text.slice(index);
    var glyph = slice.charAt(0);
    if (glyph === "½") return { value: 0.5, length: 1 };
    if (glyph === "¼") return { value: 0.25, length: 1 };
    if (glyph === "¾") return { value: 0.75, length: 1 };
    var slash = slice.match(/^(\d+)\s*\/\s*(\d+)/);
    if (slash && Number(slash[2])) {
      return { value: Number(slash[1]) / Number(slash[2]), length: slash[0].length };
    }
    var grouped = slice.match(/^(\d{1,3}(?:[,\u066C،٬]\d{3})+|\d+)(?:[.\u066B٫](\d+))?/);
    if (grouped) {
      var whole = grouped[1].replace(/[,\u066C،٬]/g, "");
      var num = Number(grouped[2] ? whole + "." + grouped[2] : whole);
      if (isFinite(num)) return { value: num, length: grouped[0].length };
    }
    for (var i = 0; i < WORD_NUMBERS.length; i += 1) {
      var word = WORD_NUMBERS[i][0];
      if (slice.indexOf(word) !== 0) continue;
      if (!endsToken(text, index + word.length)) continue;
      return { value: WORD_NUMBERS[i][1], length: word.length };
    }
    return null;
  }

  function scaleIngredientLine(raw, factor) {
    if (typeof raw !== "string" || !raw) return raw;
    if (typeof factor !== "number" || !isFinite(factor) || factor <= 0) return raw;
    if (Math.abs(factor - 1) < 1e-9) return raw;
    var text = toAsciiDigits(raw);
    var out = "";
    var changed = false;
    var i = 0;
    while (i < text.length) {
      var num = matchNumber(text, i);
      if (!num) {
        out += text.charAt(i);
        i += 1;
        continue;
      }
      var scaled = formatQty(num.value * factor);
      if (!scaled) {
        out += text.slice(i, i + num.length);
        i += num.length;
        continue;
      }
      changed = true;
      out += scaled;
      i += num.length;
    }
    return changed ? out : raw;
  }

  function scaleIngredientLines(lines, household, servings) {
    var factor = scaleFactor(household, servings);
    if (!Array.isArray(lines)) return [];
    return lines.map(function (line) {
      return typeof line === "string" ? scaleIngredientLine(line, factor) : line;
    });
  }

  var api = {
    DEFAULT_HOUSEHOLD: DEFAULT_HOUSEHOLD,
    MIN_HOUSEHOLD: MIN_HOUSEHOLD,
    MAX_HOUSEHOLD: MAX_HOUSEHOLD,
    BASE_SERVINGS: BASE_SERVINGS,
    parseHousehold: parseHousehold,
    householdOrDefault: householdOrDefault,
    servingsOf: servingsOf,
    scaleFactor: scaleFactor,
    scaleCost: scaleCost,
    scaleIngredientLine: scaleIngredientLine,
    scaleIngredientLines: scaleIngredientLines,
    peoplePhrase: peoplePhrase,
    toPersianDigits: toPersianDigits,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazHousehold = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
