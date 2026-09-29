const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pantry = require("./pantry.js");
const fridge = require("./fridge.js");

const { COPY, ERROR_COPY, ENDPOINT } = fridge;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  await flush();
  await flush();
  await flush();
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text() {
      return Promise.resolve(JSON.stringify(body));
    },
  };
}

function createNode(tag) {
  const node = {
    tag,
    id: "",
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    value: "",
    type: "",
    checked: false,
    maxLength: 0,
    files: null,
    srcObject: null,
    clickCount: 0,
    dataset: {},
    attrs: {},
    children: [],
    listeners: {},
    parent: null,
  };
  node.classList = {
    add(name) {
      node.classList.toggle(name, true);
    },
    toggle(name, on) {
      const parts = new Set(node.className.split(/\s+/).filter(Boolean));
      const next = on === undefined ? !parts.has(name) : !!on;
      if (next) parts.add(name);
      else parts.delete(name);
      node.className = [...parts].join(" ");
    },
  };
  node.setAttribute = (name, value) => {
    node.attrs[name] = String(value);
  };
  node.getAttribute = (name) => node.attrs[name];
  node.append = (...kids) => {
    kids.forEach((kid) => attach(node, kid));
  };
  node.replaceChildren = (...kids) => {
    node.children.forEach((child) => {
      child.parent = null;
    });
    node.children = [];
    kids.forEach((kid) => {
      if (kid && kid.isFragment) {
        kid.children.slice().forEach((child) => attach(node, child));
        kid.children = [];
      } else if (kid) {
        attach(node, kid);
      }
    });
  };
  node.insertBefore = (kid, before) => {
    detach(kid);
    kid.parent = node;
    const index = node.children.indexOf(before);
    if (index === -1) node.children.push(kid);
    else node.children.splice(index, 0, kid);
  };
  node.addEventListener = (type, fn) => {
    node.listeners[type] = fn;
  };
  node.click = () => {
    node.clickCount += 1;
  };
  node.focus = () => {};
  node.select = () => {};
  node.play = () => Promise.resolve();
  return node;
}

function detach(kid) {
  if (kid && kid.parent && kid.parent.children) {
    kid.parent.children = kid.parent.children.filter((child) => child !== kid);
  }
}

function attach(parent, kid) {
  detach(kid);
  kid.parent = parent;
  parent.children.push(kid);
}

function fakeDocument() {
  const nodes = {};
  const listeners = {};
  function register(id, tag, hidden) {
    const node = createNode(tag);
    node.id = id;
    node.hidden = !!hidden;
    nodes[id] = node;
    return node;
  }
  register("add-form", "form");
  register("ingredient", "input");
  register("chips", "ul", true);
  register("empty", "div");
  register("status", "p");
  register("week-budget", "input");
  register("seed", "button");
  register("clear", "button");
  register("empty-actions", "div");
  register("actions", "div", true);
  register("chip-hint", "p", true);
  register("count", "span", true);
  register("fridge-open", "button");
  register("fridge-sheet", "div", true);
  register("fridge-chooser", "div");
  register("fridge-camera", "button");
  register("fridge-pick", "button");
  register("fridge-capture", "input");
  register("fridge-file", "input");
  register("fridge-camera-view", "div", true);
  register("fridge-video", "video");
  register("fridge-shutter", "button");
  register("fridge-camera-count", "p");
  register("fridge-camera-detect", "button", true);
  register("fridge-camera-review", "button");
  register("fridge-denied", "p", true);
  register("fridge-queue", "div", true);
  register("fridge-queue-count", "p");
  register("fridge-queue-list", "ul");
  register("fridge-queue-status", "p");
  register("fridge-detect", "button");
  register("fridge-add-photo", "button");
  register("fridge-queue-camera", "button");
  register("fridge-queue-clear", "button");
  register("fridge-launch", "div");
  register("fridge-loading-panel", "div", true);
  register("fridge-preview-wrap", "div", true);
  register("fridge-preview-row", "div");
  register("fridge-preview", "img");
  register("fridge-loading", "p", true);
  register("fridge-loading-cancel", "button");
  register("fridge-error", "div", true);
  register("fridge-error-text", "p");
  register("fridge-error-hint", "p", true);
  register("fridge-retry", "button");
  register("empty-add", "label");
  register("fridge-confirm", "div", true);
  register("fridge-merged", "p", true);
  register("fridge-none", "p", true);
  register("fridge-candidates", "ul");
  register("fridge-confirm-status", "p");
  register("fridge-extra", "form");
  register("fridge-extra-input", "input");
  register("fridge-apply", "button");
  register("fridge-cancel", "button");
  register("fridge-close", "button");
  nodes["fridge-sheet"].className = "sheet";
  nodes["fridge-apply"].disabled = true;

  return {
    nodes,
    getElementById(id) {
      return nodes[id] || null;
    },
    createElement: createNode,
    createDocumentFragment() {
      const fragment = createNode("fragment");
      fragment.isFragment = true;
      return fragment;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    dispatchEvent(event) {
      const fn = listeners[event.type];
      if (fn) fn(event);
    },
  };
}

function jpegBlob() {
  return new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
}

function mountFridge(options) {
  const doc = fakeDocument();
  const store = pantry.createPantry({ storage: pantry.createMemoryStorage() });
  const calls = [];
  let resolveFetch = null;
  const fetchImpl = options.fetch || function fetchImpl(url, init) {
    calls.push({ url, init });
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };
  if (options.withPantry) pantry.mount(doc, store);
  fridge.mount(doc, store, {
    fetch: fetchImpl,
    prepareImage: options.prepareImage || ((file) => Promise.resolve(file)),
    captureFrame: options.captureFrame || (() => Promise.resolve(jpegBlob())),
    mediaDevices: options.mediaDevices === undefined ? null : options.mediaDevices,
  });
  return { doc, store, calls, resolveFetch: () => resolveFetch, fetchImpl };
}

function pickFiles(doc, id, files) {
  const input = doc.nodes[id];
  const list = files == null ? [jpegBlob()] : Array.isArray(files) ? files : [files];
  input.files = list;
  input.listeners.change();
}

function pickFile(doc, id, file) {
  pickFiles(doc, id, file || null);
}

async function stageFiles(doc, id, files) {
  pickFiles(doc, id, files);
  await flush();
}

async function sendFiles(ctx, id, files) {
  await stageFiles(ctx.doc, id, files);
  ctx.doc.nodes["fridge-detect"].listeners.click();
  await flush();
}

test("copy and endpoint match the confirm-before-merge flow", () => {
  assert.equal(COPY.open, "عکس یخچال");
  assert.equal(COPY.loading, "در حال تشخیص مواد…");
  assert.equal(COPY.confirm, "تأیید و افزودن به انبار");
  assert.equal(COPY.retry, "تلاش دوباره");
  assert.equal(COPY.cameraDenied, "دسترسی به دوربین داده نشد. می‌توانید یک عکس انتخاب کنید.");
  assert.equal(ENDPOINT, "/api/vision/fridge");
  assert.equal(fridge.isCameraFailure({ name: "NotAllowedError" }), true);
  assert.equal(fridge.isCameraFailure({ name: "NotFoundError" }), true);
});

test("page wires capture, upload, and the confirm button", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "fridge.js"), "utf8");
  assert.match(html, /id="fridge-open"/);
  assert.match(html, /data-testid="fridge-photo"/);
  assert.match(html, /عکس یخچال/);
  assert.match(html, /id="fridge-capture"[\s\S]*?capture="environment"/);
  assert.match(html, /id="fridge-file"/);
  assert.match(html, /id="fridge-file"[\s\S]*?multiple/);
  assert.equal(html.includes('id="fridge-file"') && html.slice(html.indexOf('id="fridge-file"'), html.indexOf('id="fridge-file"') + 280).includes("capture="), false);
  assert.match(html, /id="fridge-detect"/);
  assert.match(html, /id="fridge-queue"/);
  assert.match(html, /id="fridge-merged"/);
  assert.match(html, /تأیید و افزودن به انبار/);
  assert.match(html, /در حال تشخیص مواد…/);
  assert.match(html, /id="fridge-preview"/);
  assert.match(html, /id="fridge-loading-cancel"/);
  assert.match(html, /id="fridge-loading-panel"/);
  assert.match(html, /fridge\.js/);
  assert.equal(html.includes("GAP_CODE_API_KEY"), false);
  assert.match(script, /GAP_CODE_API_KEY/);
  assert.equal(script.includes(["unit", "test", "key"].join("-")), false);
  assert.equal(script.includes("getUserMedia"), true);
});

test("candidate names are normalized and nothing merges until asked", () => {
  assert.equal(fridge.MAX_PHOTOS, 6);
  assert.deepEqual(fridge.selectIngredients(["  \u0643\u0631\u0641\u0633 ", "کرفس", "شیر"]), [
    { name: "کرفس", confidence: null, merged: true },
    { name: "شیر", confidence: null, merged: false },
  ]);
  assert.deepEqual(fridge.selectIngredients([]), []);
  assert.equal(fridge.selectIngredients("شیر"), null);
  assert.deepEqual(
    fridge.selectIngredients([
      { name: "گوجه", confidence: 0.95 },
      { name: "گوجه\u200cفرنگی", confidence: 0.4 },
      { name: "پیاز", confidence: 0.7 },
      { name: "پیازچه", confidence: 0.66 },
      { name: "شیر", confidence: 80 },
      { name: "شیر", score: "۹۲٪" },
    ]),
    [
      { name: "گوجه\u200cفرنگی", confidence: 0.95, merged: true },
      { name: "پیاز", confidence: 0.7, merged: false },
      { name: "پیازچه", confidence: 0.66, merged: false },
      { name: "شیر", confidence: 0.92, merged: true },
    ],
  );
  assert.deepEqual(fridge.selectIngredients([{ name: "گوجه", confidence: 0.5 }]), [
    { name: "گوجه", confidence: 0.5, merged: false },
  ]);
  assert.deepEqual(fridge.selectIngredients([{ name: "بد", confidence: 1.5 }]), [
    { name: "بد", confidence: null, merged: false },
  ]);
  assert.deepEqual(fridge.selectIngredients(["شیر", "sk-testsecret", "https://evil.test/x"]), [
    { name: "شیر", confidence: null, merged: false },
  ]);
  const secret = ["unit", "test", "key"].join("-");
  assert.equal(fridge.confidenceCopy(0.92, false), "اطمینان ۹۲٪");
  assert.equal(fridge.confidenceLevel(0.92, false), "high");
  assert.equal(fridge.confidenceCopy(null, false), "نامشخص");
  assert.equal(fridge.confidenceCopy(null, true), "دستی");

  const store = pantry.createPantry({ storage: pantry.createMemoryStorage() });
  store.add("کرفس");
  const merged = fridge.mergeIntoPantry(store, ["\u0643\u0631\u0641\u0633", "ماست", ""]);
  assert.deepEqual(merged.added, ["ماست"]);
  assert.deepEqual(merged.duplicate, ["کرفس"]);
  assert.deepEqual(store.items(), ["کرفس", "ماست"]);
  assert.equal(fridge.summarizeMerge(merged), "۱ ماده به انبار اضافه شد. ۱ ماده از قبل بود.");
  assert.equal(fridge.messageForFailure(502, { error: "unauthorized", message: secret }), ERROR_COPY.unauthorized)
  assert.equal(fridge.messageForFailure(502, { error: "unauthorized", message: secret }).includes(secret), false);
  assert.equal(fridge.hintForFailure({ error: "invalid_image", message: secret }), "");
  assert.equal(fridge.hintForFailure({ error: "image_too_large" }), "");
  assert.equal(fridge.hintForFailure({ error: "too_many_images" }), "");
  const hint = fridge.hintForFailure({ error: "not_configured", message: `Bearer ${secret}` });
  assert.equal(hint, fridge.SERVICE_HINT);
  assert.match(hint, /GAP_CODE_API_KEY/);
  assert.match(hint, /docker compose/);
  assert.equal(hint.includes(secret), false);
  assert.equal(fridge.SERVICE_HINT, require("./recipes.js").SERVICE_HINT);
});

test("vision results stay out of the pantry until confirm", async () => {
  const ctx = mountFridge({ withPantry: true });
  const { doc, store, calls } = ctx;
  doc.nodes["fridge-open"].listeners.click();
  assert.equal(doc.nodes["fridge-sheet"].hidden, false);
  assert.equal(calls.length, 0);

  await stageFiles(doc, "fridge-file");
  assert.equal(calls.length, 0);
  assert.equal(doc.nodes["fridge-queue"].hidden, false);
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 1);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-detect"].listeners.click();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
  assert.equal(calls[0].init.body instanceof FormData, true);
  assert.equal(calls[0].init.body.getAll("image").length, 1);
  assert.equal(doc.nodes["fridge-loading"].hidden, false);
  assert.equal(doc.nodes["fridge-loading"].textContent, COPY.loading);
  assert.equal(doc.nodes["fridge-loading-panel"].hidden, false);
  assert.equal(doc.nodes["fridge-loading-cancel"].disabled, false);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-detect"].listeners.click();
  await flush();
  assert.equal(calls.length, 1);

  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["شیر", "ماست"] }));
  await settle();

  assert.equal(doc.nodes["fridge-confirm"].hidden, false);
  assert.equal(doc.nodes["fridge-loading"].hidden, true);
  assert.equal(doc.nodes["fridge-candidates"].children.length, 2);
  assert.equal(doc.nodes["fridge-candidates"].children[0].children[1].value, "شیر");
  assert.equal(doc.nodes["fridge-candidates"].children[0].children[2].textContent, "نامشخص");
  assert.equal(doc.nodes["fridge-merged"].hidden, true);
  assert.deepEqual(store.items(), []);
  assert.equal(doc.nodes.chips.hidden, true);

  const firstToggle = doc.nodes["fridge-candidates"].children[0].children[0];
  const secondField = doc.nodes["fridge-candidates"].children[1].children[1];
  firstToggle.checked = false;
  firstToggle.listeners.change();
  secondField.value = "پنیر";
  secondField.listeners.input();
  assert.equal(doc.nodes["fridge-candidates"].children[1].children[2].textContent, "دستی");
  assert.equal(doc.nodes["fridge-candidates"].children[0].className.includes("is-off"), true);

  doc.nodes["fridge-extra-input"].value = "روغن";
  doc.nodes["fridge-extra"].listeners.submit({ preventDefault() {} });
  assert.deepEqual(store.items(), []);
  assert.equal(doc.nodes["fridge-candidates"].children.length, 3);

  doc.nodes["fridge-apply"].listeners.click();
  assert.deepEqual(store.items(), ["پنیر", "روغن"]);
  assert.equal(doc.nodes["fridge-sheet"].hidden, true);
  assert.equal(doc.nodes.status.textContent, "۲ ماده به انبار اضافه شد");
  assert.equal(doc.nodes.chips.hidden, false);
  const chip = doc.nodes.chips.children[0].children[0];
  assert.equal(chip.dataset.name, "پنیر");
  assert.equal(chip.className.includes("is-flash"), true);
  chip.listeners.click({ detail: 1 });
  assert.deepEqual(store.items(), ["روغن"]);
  assert.equal(doc.nodes.chips.children[0].children[0].dataset.name, "روغن");
});

test("cancel and turning every chip off leave the pantry unchanged", async () => {
  const ctx = mountFridge({});
  const { doc, store } = ctx;
  doc.nodes["fridge-open"].listeners.click();
  await sendFiles(ctx, "fridge-file");
  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["شیر", "ماست"] }));
  await settle();

  doc.nodes["fridge-candidates"].children.forEach((li) => {
    const toggle = li.children[0];
    toggle.checked = false;
    toggle.listeners.change();
  });
  doc.nodes["fridge-apply"].listeners.click();
  assert.deepEqual(store.items(), []);
  assert.equal(doc.nodes["fridge-sheet"].hidden, false);
  assert.equal(doc.nodes["fridge-confirm-status"].textContent, COPY.noneChosen);

  doc.nodes["fridge-cancel"].listeners.click();
  assert.equal(doc.nodes["fridge-sheet"].hidden, true);
  assert.deepEqual(store.items(), []);
});

test("empty vision list can be filled by hand and still waits for confirm", async () => {
  const ctx = mountFridge({});
  const { doc, store } = ctx;
  await sendFiles(ctx, "fridge-capture");
  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: [] }));
  await settle();
  assert.equal(doc.nodes["fridge-none"].hidden, false);
  assert.equal(doc.nodes["fridge-apply"].disabled, true);
  assert.deepEqual(store.items(), []);
  doc.nodes["fridge-extra-input"].value = "دوغ";
  doc.nodes["fridge-extra"].listeners.submit({ preventDefault() {} });
  assert.deepEqual(store.items(), []);
  doc.nodes["fridge-apply"].listeners.click();
  assert.deepEqual(store.items(), ["دوغ"]);
});

test("errors are Persian, retry resends, and secrets stay hidden", async () => {
  const secret = "unit-test-key";
  const ctx = mountFridge({});
  const { doc, store, calls } = ctx;
  await sendFiles(ctx, "fridge-file");
  ctx.resolveFetch()(
    jsonResponse(502, { ok: false, error: "unauthorized", message: secret }),
  );
  await settle();
  assert.equal(doc.nodes["fridge-error"].hidden, false);
  assert.equal(doc.nodes["fridge-error-text"].textContent, ERROR_COPY.unauthorized);
  assert.equal(doc.nodes["fridge-error-text"].textContent.includes(secret), false);
  assert.equal(doc.nodes["fridge-error-hint"].hidden, false);
  assert.equal(doc.nodes["fridge-error-hint"].textContent, fridge.SERVICE_HINT);
  assert.equal(doc.nodes["fridge-error-hint"].textContent.includes(secret), false);
  assert.equal(doc.nodes["fridge-preview-wrap"].hidden, true);
  assert.equal(doc.nodes["fridge-confirm"].hidden, true);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-retry"].listeners.click();
  await flush();
  assert.equal(calls.length, 2);
  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["ماست"] }));
  await settle();
  assert.equal(doc.nodes["fridge-confirm"].hidden, false);
  assert.deepEqual(store.items(), []);
});

test("empty pantry keeps seed and the fridge photo in the empty actions", () => {
  const ctx = mountFridge({ withPantry: true });
  const { doc } = ctx;
  assert.equal(doc.nodes.seed.parent, doc.nodes["empty-actions"]);
  assert.equal(doc.nodes["fridge-open"].parent, doc.nodes["empty-actions"]);
  assert.equal(doc.nodes["empty-add"].parent, doc.nodes["empty-actions"]);
  doc.nodes.ingredient.value = "برنج";
  doc.nodes["add-form"].listeners.submit({ preventDefault() {} });
  assert.equal(doc.nodes["empty"].hidden, true);
  assert.equal(doc.nodes.seed.parent, doc.nodes.actions);
  assert.equal(doc.nodes["fridge-open"].parent, doc.nodes["fridge-launch"]);
  doc.nodes.clear.listeners.click();
  assert.equal(doc.nodes["empty"].hidden, false);
  assert.equal(doc.nodes["fridge-open"].parent, doc.nodes["empty-actions"]);
});

test("vision loading shows a preview and cancel leaves the pantry", async () => {
  const created = [];
  const revoked = [];
  const previous = global.URL;
  global.URL = {
    createObjectURL(blob) {
      created.push(blob);
      return "blob:fridge-preview";
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  try {
    const ctx = mountFridge({});
    const { doc, store } = ctx;
    doc.nodes["fridge-open"].listeners.click();
    await sendFiles(ctx, "fridge-file");
    assert.equal(doc.nodes["fridge-loading-panel"].hidden, false);
    assert.equal(doc.nodes["fridge-preview-wrap"].hidden, false);
    assert.equal(doc.nodes["fridge-preview"].src, "blob:fridge-preview");
    assert.equal(created.length > 0, true);
    assert.deepEqual(store.items(), []);

    doc.nodes["fridge-loading-cancel"].listeners.click();
    assert.equal(doc.nodes["fridge-sheet"].hidden, true);
    assert.equal(doc.nodes["fridge-error"].hidden, true);
    ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["شیر"] }));
    await settle();
    assert.equal(doc.nodes["fridge-sheet"].hidden, true);
    assert.equal(doc.nodes["fridge-confirm"].hidden, true);
    assert.equal(doc.nodes["fridge-error"].hidden, true);
    assert.deepEqual(store.items(), []);
    assert.equal(revoked.includes("blob:fridge-preview"), true);
  } finally {
    global.URL = previous;
  }
});

test("camera denial falls back to file upload without calling the API", async () => {
  const seen = [];
  const ctx = mountFridge({
    mediaDevices: {
      getUserMedia(constraints) {
        seen.push(constraints);
        return Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
      },
    },
  });
  const { doc, calls } = ctx;
  doc.nodes["fridge-open"].listeners.click();
  doc.nodes["fridge-camera"].listeners.click();
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].audio, false);
  assert.equal(seen[0].video.facingMode.ideal, "environment");
  assert.equal(doc.nodes["fridge-denied"].hidden, false);
  assert.equal(doc.nodes["fridge-denied"].textContent, COPY.cameraDenied);
  assert.equal(doc.nodes["fridge-capture"].clickCount, 0);
  assert.equal(doc.nodes["fridge-chooser"].hidden, false);
  assert.equal(calls.length, 0);

  doc.nodes["fridge-pick"].listeners.click();
  assert.equal(doc.nodes["fridge-file"].clickCount, 1);
  await sendFiles(ctx, "fridge-file");
  assert.equal(calls.length, 1);
  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: [] }));
  await settle();
  assert.deepEqual(ctx.store.items(), []);
});

test("without getUserMedia the capture input is the camera affordance", () => {
  const ctx = mountFridge({ mediaDevices: null });
  ctx.doc.nodes["fridge-camera"].listeners.click();
  assert.equal(ctx.doc.nodes["fridge-capture"].clickCount, 1);
  assert.equal(ctx.doc.nodes["fridge-file"].clickCount, 0);
  assert.equal(ctx.calls.length, 0);
});

test("a granted camera can take a photo and closing stops the stream", async () => {
  const stops = [];
  const stream = {
    getTracks() {
      return [{ stop() { stops.push("stop"); } }];
    },
  };
  let constraints = null;
  const ctx = mountFridge({
    mediaDevices: {
      getUserMedia(next) {
        constraints = next;
        return Promise.resolve(stream);
      },
    },
  });
  const { doc, store, calls } = ctx;
  doc.nodes["fridge-open"].listeners.click();
  doc.nodes["fridge-camera"].listeners.click();
  await settle();
  assert.equal(doc.nodes["fridge-camera-view"].hidden, false);
  assert.equal(doc.nodes["fridge-video"].srcObject, stream);
  assert.equal(constraints.video.facingMode.ideal, "environment");

  doc.nodes["fridge-shutter"].listeners.click();
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(stops.length, 0);
  assert.equal(doc.nodes["fridge-video"].srcObject, stream);
  assert.equal(doc.nodes["fridge-camera-detect"].hidden, false);
  doc.nodes["fridge-camera-detect"].listeners.click();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body.getAll("image").length, 1);
  assert.ok(stops.length >= 1);
  assert.equal(doc.nodes["fridge-video"].srcObject, null);
  assert.deepEqual(store.items(), []);

  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["تخم‌مرغ"] }));
  await settle();
  doc.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(doc.nodes["fridge-sheet"].hidden, true);
  assert.deepEqual(store.items(), []);
});

test("two photos are one request, duplicates merge, and only checked chips are added", async () => {
  const ctx = mountFridge({});
  const { doc, store, calls } = ctx;
  const first = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  const second = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])], { type: "image/png" });
  doc.nodes["fridge-open"].listeners.click();
  await stageFiles(doc, "fridge-file", [first, second]);
  assert.equal(calls.length, 0);
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 2);
  assert.equal(doc.nodes["fridge-queue-count"].textContent, "۲ عکس آماده است");
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-queue-clear"].listeners.click();
  assert.equal(doc.nodes["fridge-sheet"].hidden, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-open"].listeners.click();
  await stageFiles(doc, "fridge-file", [first, second]);
  const removeFirst = doc.nodes["fridge-queue-list"].children[0].children[1];
  removeFirst.listeners.click();
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 1);

  doc.nodes["fridge-add-photo"].listeners.click();
  assert.equal(doc.nodes["fridge-file"].clickCount, 1);
  await stageFiles(doc, "fridge-file", [first]);
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 2);

  doc.nodes["fridge-detect"].listeners.click();
  await flush();
  assert.equal(calls.length, 1);
  const images = calls[0].init.body.getAll("image");
  assert.equal(images.length, 2);
  assert.equal(images[0].type, "image/png");
  assert.equal(images[1].type, "image/jpeg");
  assert.equal(doc.nodes["fridge-loading"].textContent, COPY.loading);
  assert.deepEqual(store.items(), []);

  ctx.resolveFetch()(
    jsonResponse(200, {
      ok: true,
      ingredients: [
        { name: "گوجه", confidence: 0.55 },
        { name: "گوجه\u200cفرنگی", confidence: 0.9 },
        { name: "شیر", confidence: 0.42 },
      ],
    }),
  );
  await settle();

  assert.equal(doc.nodes["fridge-confirm"].hidden, false);
  assert.equal(doc.nodes["fridge-merged"].hidden, false);
  assert.equal(doc.nodes["fridge-merged"].textContent, COPY.merged);
  assert.equal(doc.nodes["fridge-candidates"].children.length, 2);
  assert.equal(doc.nodes["fridge-candidates"].children[0].children[1].value, "گوجه‌فرنگی");
  assert.equal(doc.nodes["fridge-candidates"].children[0].children[2].textContent, "اطمینان ۹۰٪");
  assert.equal(doc.nodes["fridge-candidates"].children[0].children[2].dataset.level, "high");
  assert.equal(doc.nodes["fridge-candidates"].children[1].children[1].value, "شیر");
  assert.equal(doc.nodes["fridge-candidates"].children[1].children[2].textContent, "اطمینان ۴۲٪");
  assert.equal(doc.nodes["fridge-candidates"].children[1].children[2].dataset.level, "low");
  assert.deepEqual(store.items(), []);

  const milk = doc.nodes["fridge-candidates"].children[1].children[0];
  milk.checked = false;
  milk.listeners.change();
  doc.nodes["fridge-apply"].listeners.click();
  assert.deepEqual(store.items(), ["گوجه‌فرنگی"]);
  assert.equal(doc.nodes["fridge-sheet"].hidden, true);
});

test("a seventh photo is refused and the pantry stays empty", async () => {
  const ctx = mountFridge({});
  const { doc, store, calls } = ctx;
  const many = Array.from({ length: 7 }, () => jpegBlob());
  doc.nodes["fridge-open"].listeners.click();
  await stageFiles(doc, "fridge-file", many);
  assert.equal(calls.length, 0);
  assert.equal(doc.nodes["fridge-error"].hidden, false);
  assert.equal(doc.nodes["fridge-error-text"].textContent, ERROR_COPY.too_many_images);
  assert.equal(doc.nodes["fridge-error-hint"].hidden, true);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-open"].listeners.click();
  await stageFiles(doc, "fridge-file", many.slice(0, 6));
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 6);
  await stageFiles(doc, "fridge-file", [jpegBlob()]);
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 6);
  assert.equal(doc.nodes["fridge-queue-status"].textContent, COPY.tooMany);
  assert.equal(calls.length, 0);
  assert.deepEqual(store.items(), []);
});

test("two camera frames stay in order until one detect", async () => {
  const stops = [];
  const stream = {
    getTracks() {
      return [{ stop() { stops.push("stop"); } }];
    },
  };
  let frames = 0;
  const ctx = mountFridge({
    captureFrame() {
      frames += 1;
      const byte = frames === 1 ? 0xd8 : 0xd9;
      return Promise.resolve(new Blob([Uint8Array.from([0xff, byte, 0xff])], { type: "image/jpeg" }));
    },
    mediaDevices: {
      getUserMedia() {
        return Promise.resolve(stream);
      },
    },
  });
  const { doc, store, calls } = ctx;
  doc.nodes["fridge-open"].listeners.click();
  doc.nodes["fridge-camera"].listeners.click();
  await settle();
  doc.nodes["fridge-shutter"].listeners.click();
  await flush();
  doc.nodes["fridge-shutter"].listeners.click();
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(doc.nodes["fridge-camera-count"].textContent, "۲ عکس آماده است");
  assert.equal(stops.length, 0);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-camera-review"].listeners.click();
  assert.equal(doc.nodes["fridge-queue"].hidden, false);
  assert.equal(doc.nodes["fridge-queue-list"].children.length, 2);
  assert.ok(stops.length >= 1);

  doc.nodes["fridge-detect"].listeners.click();
  await flush();
  assert.equal(calls.length, 1);
  const images = calls[0].init.body.getAll("image");
  assert.equal(images.length, 2);
  assert.equal(images[0].size, 3);
  assert.equal(images[1].size, 3);
  const firstBytes = new Uint8Array(await images[0].arrayBuffer());
  const secondBytes = new Uint8Array(await images[1].arrayBuffer());
  assert.equal(firstBytes[1], 0xd8);
  assert.equal(secondBytes[1], 0xd9);
  assert.deepEqual(store.items(), []);
  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: [] }));
  await settle();
  assert.deepEqual(store.items(), []);
});
