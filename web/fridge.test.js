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
  register("fridge-denied", "p", true);
  register("fridge-launch", "div");
  register("fridge-loading-panel", "div", true);
  register("fridge-preview-wrap", "div", true);
  register("fridge-preview", "img");
  register("fridge-loading", "p", true);
  register("fridge-loading-cancel", "button");
  register("fridge-error", "div", true);
  register("fridge-error-text", "p");
  register("fridge-error-hint", "p", true);
  register("fridge-retry", "button");
  register("empty-add", "label");
  register("fridge-confirm", "div", true);
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

function pickFile(doc, id, file) {
  const input = doc.nodes[id];
  input.files = [file || jpegBlob()];
  input.listeners.change();
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
  assert.equal(html.includes('id="fridge-file"') && html.slice(html.indexOf('id="fridge-file"'), html.indexOf('id="fridge-file"') + 220).includes("capture="), false);
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
  assert.deepEqual(fridge.selectIngredients(["  \u0643\u0631\u0641\u0633 ", "کرفس", "شیر"]), ["کرفس", "شیر"]);
  assert.deepEqual(fridge.selectIngredients([]), []);
  assert.equal(fridge.selectIngredients("شیر"), null);

  const store = pantry.createPantry({ storage: pantry.createMemoryStorage() });
  store.add("کرفس");
  const merged = fridge.mergeIntoPantry(store, ["\u0643\u0631\u0641\u0633", "ماست", ""]);
  assert.deepEqual(merged.added, ["ماست"]);
  assert.deepEqual(merged.duplicate, ["کرفس"]);
  assert.deepEqual(store.items(), ["کرفس", "ماست"]);
  assert.equal(fridge.summarizeMerge(merged), "۱ ماده به انبار اضافه شد. ۱ ماده از قبل بود.");
  const secret = ["unit", "test", "key"].join("-");
  assert.equal(fridge.messageForFailure(502, { error: "unauthorized", message: secret }), ERROR_COPY.unauthorized);
  assert.equal(fridge.messageForFailure(502, { error: "unauthorized", message: secret }).includes(secret), false);
  assert.equal(fridge.hintForFailure({ error: "invalid_image", message: secret }), "");
  assert.equal(fridge.hintForFailure({ error: "image_too_large" }), "");
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

  pickFile(doc, "fridge-file");
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
  assert.equal(calls[0].init.body instanceof FormData, true);
  assert.ok(calls[0].init.body.get("image"));
  assert.equal(doc.nodes["fridge-loading"].hidden, false);
  assert.equal(doc.nodes["fridge-loading"].textContent, COPY.loading);
  assert.equal(doc.nodes["fridge-loading-panel"].hidden, false);
  assert.equal(doc.nodes["fridge-loading-cancel"].disabled, false);
  assert.deepEqual(store.items(), []);

  doc.nodes["fridge-file"].listeners.change();
  await flush();
  assert.equal(calls.length, 1);

  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["شیر", "ماست"] }));
  await settle();

  assert.equal(doc.nodes["fridge-confirm"].hidden, false);
  assert.equal(doc.nodes["fridge-loading"].hidden, true);
  assert.equal(doc.nodes["fridge-candidates"].children.length, 2);
  assert.equal(doc.nodes["fridge-candidates"].children[0].children[1].value, "شیر");
  assert.deepEqual(store.items(), []);
  assert.equal(doc.nodes.chips.hidden, true);

  const firstToggle = doc.nodes["fridge-candidates"].children[0].children[0];
  const secondField = doc.nodes["fridge-candidates"].children[1].children[1];
  firstToggle.checked = false;
  firstToggle.listeners.change();
  secondField.value = "پنیر";
  secondField.listeners.input();
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
  pickFile(doc, "fridge-file");
  await flush();
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
  pickFile(doc, "fridge-capture");
  await flush();
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
  pickFile(doc, "fridge-file");
  await flush();
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
    pickFile(doc, "fridge-file");
    await flush();
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
  pickFile(doc, "fridge-file");
  await flush();
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
  assert.equal(calls.length, 1);
  assert.ok(stops.length >= 1);
  assert.equal(doc.nodes["fridge-video"].srcObject, null);
  assert.deepEqual(store.items(), []);

  ctx.resolveFetch()(jsonResponse(200, { ok: true, ingredients: ["تخم‌مرغ"] }));
  await settle();
  doc.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(doc.nodes["fridge-sheet"].hidden, true);
  assert.deepEqual(store.items(), []);
});
