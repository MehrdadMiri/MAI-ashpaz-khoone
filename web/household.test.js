const test = require("node:test");
const assert = require("node:assert/strict");

const household = require("./household.js");
const pantryLib = require("./pantry.js");
const plan = require("./plan.js");

test("household parsing stays between 1 and 12 and defaults to 4", () => {
  assert.equal(household.DEFAULT_HOUSEHOLD, 4);
  assert.equal(household.BASE_SERVINGS, 4);
  assert.equal(household.parseHousehold(4), 4);
  assert.equal(household.parseHousehold("۸"), 8);
  assert.equal(household.parseHousehold("12"), 12);
  assert.equal(household.parseHousehold(1), 1);
  assert.equal(household.parseHousehold(0), null);
  assert.equal(household.parseHousehold(13), null);
  assert.equal(household.parseHousehold(4.5), null);
  assert.equal(household.parseHousehold(true), null);
  assert.equal(household.parseHousehold(""), null);
  assert.equal(household.parseHousehold("nope"), null);
  assert.equal(household.householdOrDefault("nope"), 4);
  assert.equal(household.servingsOf(undefined), 4);
  assert.equal(household.peoplePhrase(4), "برای ۴ نفر");
});

test("ingredient lines scale by headcount over the recipe base and stay put at factor 1", () => {
  assert.equal(household.scaleIngredientLine("۲۰۰ گرم گوشت", 1), "۲۰۰ گرم گوشت");
  assert.equal(household.scaleIngredientLine("۲۰۰ گرم گوشت", 2), "۴۰۰ گرم گوشت");
  assert.equal(household.scaleIngredientLine("نصف پیمانه ماست", 2), "۱ پیمانه ماست");
  assert.equal(household.scaleIngredientLine("یک و نیم پیمانه برنج", 2), "۳ پیمانه برنج");
  assert.equal(household.scaleIngredientLine("۲ عدد پیاز", 0.5), "۱ عدد پیاز");
  assert.equal(household.scaleIngredientLine("برنج", 2), "برنج");
  assert.equal(household.scaleIngredientLine("۲۰۰ گرم برنج و ۱۰۰ گرم عدس", 2), "۴۰۰ گرم برنج و ۲۰۰ گرم عدس");
  assert.equal(household.scaleCost(10000, 8, 4), 20000);
  assert.equal(household.scaleCost(10000, 4, 4), 10000);
  assert.equal(household.scaleCost(10000, 8, null), 20000);
  assert.equal(household.scaleFactor(2, 4), 0.5);
});

test("changing تعداد نفرات scales the week cost and leaves slots and stored amounts", () => {
  const storage = pantryLib.createMemoryStorage();
  const kitchen = pantryLib.createPantry({ storage });
  const previous = global.AshpazPantry.active;
  global.AshpazPantry.active = kitchen;
  try {
    const model = plan.createPlan({ storage: plan.createMemoryStorage() });
    model.assign(
      "sat",
      {
        title: "عدس‌پلو",
        ingredients: ["۲۰۰ گرم گوشت", "برنج"],
        steps: ["بپز"],
        cost_toman: 10000,
        servings: 4,
      },
      "dinner",
    );
    model.assign(
      "sun",
      {
        title: "سوپ",
        ingredients: ["آب"],
        steps: ["بپز"],
        cost_toman: 4000,
        servings: 4,
      },
      "breakfast",
    );
    const dinnerId = model.snapshot().slots.sat.dinner;
    const breakfastId = model.snapshot().slots.sun.breakfast;
    assert.equal(model.spend(), 14000);

    kitchen.setHousehold(8);
    assert.equal(model.snapshot().slots.sat.dinner, dinnerId);
    assert.equal(model.snapshot().slots.sun.breakfast, breakfastId);
    assert.equal(model.recipes()[0].ingredients[0], "۲۰۰ گرم گوشت");
    assert.equal(model.recipes()[0].cost_toman, 10000);
    assert.equal(model.recipes()[0].servings, 4);
    assert.equal(model.spend(), 28000);
    const text = model.markdown(50000);
    assert.match(text, /حدود ۲۰٬۰۰۰ تومان/);
    assert.match(text, /برای ۸ نفر/);
    assert.match(text, /عدس‌پلو/);
    assert.match(text, /\*\*صبحانه:\*\* سوپ/);

    kitchen.setHousehold(2);
    assert.equal(model.spend(), 7000);
    assert.equal(model.snapshot().slots.sat.dinner, dinnerId);
    assert.equal(model.snapshot().recipes[0].ingredients[0], "۲۰۰ گرم گوشت");
  } finally {
    global.AshpazPantry.active = previous;
  }
});
