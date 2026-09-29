/* Fridge photo → confirm → pantry (US-05b).
   Capture or upload a photo, ask POST /api/vision/fridge, then show candidate
   chips. Nothing is written to the pantry until «تأیید و افزودن به انبار».
   The API key stays on the server. This file never sees it. */
(function (global) {
  "use strict";

  var COPY = {
    open: "عکس یخچال",
    loading: "در حال تشخیص مواد…",
    confirm: "تأیید و افزودن به انبار",
    retry: "تلاش دوباره",
    cameraDenied: "دسترسی به دوربین داده نشد. می‌توانید یک عکس انتخاب کنید.",
    noneChosen: "حداقل یک ماده را انتخاب کنید.",
    alreadyInDraft: "این ماده در فهرست هست.",
    noneFound: "موردی در این عکس پیدا نشد. می‌توانید ماده را بنویسید یا دوباره تلاش کنید.",
  };

  var ERROR_COPY = {
    not_configured: "سرویس تشخیص عکس هنوز آماده نیست.",
    invalid_config: "سرویس تشخیص عکس هنوز آماده نیست.",
    unauthorized: "سرویس تشخیص عکس پاسخ نداد. دوباره تلاش کنید.",
    timeout: "زمان تشخیص مواد تمام شد. دوباره تلاش کنید.",
    bad_response: "این بار مواد درست تشخیص داده نشدند. دوباره تلاش کنید.",
    upstream_unavailable: "الان نمی‌توانیم به سرویس وصل شویم. دوباره تلاش کنید.",
    upstream_error: "الان نمی‌توانیم مواد را تشخیص دهیم. دوباره تلاش کنید.",
    invalid_image: "این عکس قابل استفاده نیست. یک عکس JPEG یا PNG انتخاب کنید.",
    image_too_large: "حجم عکس زیاد است. یک عکس کوچک‌تر انتخاب کنید.",
    invalid_request: "عکس فرستاده نشد. دوباره تلاش کنید.",
    network: "ارتباط با سرور برقرار نشد. دوباره تلاش کنید.",
    internal_error: "تشخیص مواد انجام نشد. دوباره تلاش کنید.",
    default: "تشخیص مواد انجام نشد. دوباره تلاش کنید.",
  };

  // Shown with service failures. Names the env var; never a key value.
  var SERVICE_HINT =
    "اگر این خطا ماند، GAP_CODE_API_KEY را در محیط بررسی کنید و لاگ docker compose را ببینید. مقدار کلید اینجا نشان داده نمی‌شود.";

  var LOCAL_ERRORS = {
    invalid_image: true,
    image_too_large: true,
    invalid_request: true,
  };

  var ENDPOINT = "/api/vision/fridge";
  var REQUEST_TIMEOUT_MS = 100000;
  var MAX_NAME_LENGTH = 40;
  var MAX_CANDIDATES = 30;
  var CLIENT_IMAGE_LIMIT = 12 * 1024 * 1024;

  function pantryApi() {
    return global.AshpazPantry || null;
  }

  function showName(value) {
    var api = pantryApi();
    if (api && typeof api.displayName === "function") return api.displayName(value);
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function keyOf(value) {
    var api = pantryApi();
    if (api && typeof api.identityKey === "function") return api.identityKey(value);
    return showName(value).replace(/\s+/g, "").toLowerCase();
  }

  function toPersianDigits(value) {
    return String(value).replace(/\d/g, function (digit) {
      return "۰۱۲۳۴۵۶۷۸۹"[Number(digit)];
    });
  }

  function selectIngredients(value) {
    if (!Array.isArray(value)) return null;
    var seen = Object.create(null);
    var names = [];
    for (var i = 0; i < value.length && names.length < MAX_CANDIDATES; i += 1) {
      var name = showName(value[i]);
      var key = keyOf(name);
      if (!key || name.length > MAX_NAME_LENGTH || seen[key]) continue;
      seen[key] = true;
      names.push(name);
    }
    return names;
  }

  function mergeIntoPantry(pantry, names) {
    var added = [];
    var duplicate = [];
    var rejected = [];
    (names || []).forEach(function (raw) {
      var result = pantry.add(raw);
      if (!result) return;
      if (result.ok) added.push(result.name);
      else if (result.reason === "duplicate") duplicate.push(result.name);
      else rejected.push(result.reason);
    });
    return { added: added, duplicate: duplicate, rejected: rejected };
  }

  function summarizeMerge(result) {
    var added = result.added.length;
    var duplicate = result.duplicate.length;
    if (added && duplicate) {
      return (
        toPersianDigits(added) +
        " ماده به انبار اضافه شد. " +
        toPersianDigits(duplicate) +
        " ماده از قبل بود."
      );
    }
    if (added === 1) return "«" + result.added[0] + "» به انبار اضافه شد";
    if (added > 1) return toPersianDigits(added) + " ماده به انبار اضافه شد";
    if (duplicate) return "این مواد از قبل در انبار است";
    return COPY.noneChosen;
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

  function isCameraFailure(error) {
    if (!error) return true;
    var name = error.name || "";
    return (
      name === "NotAllowedError" ||
      name === "PermissionDeniedError" ||
      name === "NotFoundError" ||
      name === "SecurityError" ||
      name === "NotReadableError" ||
      name === "AbortError" ||
      name === "OverconstrainedError" ||
      name === "TypeError" ||
      name === "NotSupportedError"
    );
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

  function clientError(code) {
    return Object.assign(new Error(code), { code: code });
  }

  function defaultPrepare(file) {
    var type = (file && file.type) || "";
    if (type === "image/svg+xml" || (type && type.indexOf("image/") !== 0)) {
      return Promise.reject(clientError("invalid_image"));
    }
    if (file && typeof file.size === "number" && file.size > CLIENT_IMAGE_LIMIT) {
      return Promise.reject(clientError("image_too_large"));
    }
    if (typeof global.createImageBitmap !== "function") {
      return Promise.resolve(file);
    }
    return compressImage(file).catch(function () {
      if (file && file.size > 6 * 1024 * 1024) {
        return Promise.reject(clientError("image_too_large"));
      }
      if (type && type.indexOf("image/") !== 0) {
        return Promise.reject(clientError("invalid_image"));
      }
      return file;
    });
  }

  function compressImage(file) {
    return global
      .createImageBitmap(file)
      .then(function (bitmap) {
        var maxEdge = 1600;
        var scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        var canvas = global.document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        var ctx = canvas.getContext("2d");
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (bitmap.close) bitmap.close();
        return new Promise(function (resolve) {
          canvas.toBlob(
            function (blob) {
              resolve(blob || file);
            },
            "image/jpeg",
            0.82,
          );
        });
      });
  }

  function defaultCaptureFrame(video) {
    var width = video.videoWidth || 0;
    var height = video.videoHeight || 0;
    if (!width || !height || !global.document) {
      return Promise.reject(clientError("invalid_image"));
    }
    var maxEdge = 1600;
    var scale = Math.min(1, maxEdge / Math.max(width, height));
    var canvas = global.document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    var ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(clientError("invalid_image"));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (blob) {
          if (!blob) {
            reject(clientError("invalid_image"));
            return;
          }
          resolve(blob);
        },
        "image/jpeg",
        0.82,
      );
    });
  }

  function stopStream(stream) {
    if (!stream || typeof stream.getTracks !== "function") return;
    stream.getTracks().forEach(function (track) {
      if (track && typeof track.stop === "function") track.stop();
    });
  }

  function emitPantryChanged(doc, detail) {
    if (!doc || typeof doc.dispatchEvent !== "function") return;
    var event;
    if (typeof global.CustomEvent === "function") {
      event = new global.CustomEvent("ashpaz-pantry-changed", { detail: detail });
    } else {
      event = { type: "ashpaz-pantry-changed", detail: detail };
    }
    doc.dispatchEvent(event);
  }

  function mount(doc, pantry, options) {
    options = options || {};
    var openBtn = doc.getElementById("fridge-open");
    var sheet = doc.getElementById("fridge-sheet");
    var chooser = doc.getElementById("fridge-chooser");
    var cameraBtn = doc.getElementById("fridge-camera");
    var pickBtn = doc.getElementById("fridge-pick");
    var captureInput = doc.getElementById("fridge-capture");
    var fileInput = doc.getElementById("fridge-file");
    var cameraView = doc.getElementById("fridge-camera-view");
    var video = doc.getElementById("fridge-video");
    var shutter = doc.getElementById("fridge-shutter");
    var denied = doc.getElementById("fridge-denied");
    var loadingPanel = doc.getElementById("fridge-loading-panel");
    var loading = doc.getElementById("fridge-loading");
    var previewWrap = doc.getElementById("fridge-preview-wrap");
    var previewImg = doc.getElementById("fridge-preview");
    var loadingCancel = doc.getElementById("fridge-loading-cancel");
    var errorBox = doc.getElementById("fridge-error");
    var errorText = doc.getElementById("fridge-error-text");
    var hintEl = doc.getElementById("fridge-error-hint");
    var retryBtn = doc.getElementById("fridge-retry");
    var confirmBox = doc.getElementById("fridge-confirm");
    var none = doc.getElementById("fridge-none");
    var candidates = doc.getElementById("fridge-candidates");
    var confirmStatus = doc.getElementById("fridge-confirm-status");
    var extraForm = doc.getElementById("fridge-extra");
    var extraInput = doc.getElementById("fridge-extra-input");
    var applyBtn = doc.getElementById("fridge-apply");
    var cancelBtn = doc.getElementById("fridge-cancel");
    var closeBtn = doc.getElementById("fridge-close");
    if (
      !openBtn ||
      !sheet ||
      !chooser ||
      !cameraBtn ||
      !pickBtn ||
      !fileInput ||
      !loading ||
      !errorBox ||
      !errorText ||
      !confirmBox ||
      !candidates ||
      !applyBtn ||
      !cancelBtn ||
      !pantry
    ) {
      return;
    }

    var request = typeof options.fetch === "function" ? options.fetch : null;
    var media = options.mediaDevices || null;
    var prepareImage = typeof options.prepareImage === "function" ? options.prepareImage : defaultPrepare;
    var captureFrame = typeof options.captureFrame === "function" ? options.captureFrame : defaultCaptureFrame;
    var gate = createSubmitGate();
    var draft = [];
    var lastImage = null;
    var stream = null;
    var generation = 0;
    var cameraToken = 0;
    var activeController = null;
    var previewUrl = "";

    function setBusy(busy) {
      openBtn.disabled = busy;
      cameraBtn.disabled = busy;
      pickBtn.disabled = busy;
      if (shutter) shutter.disabled = busy;
      if (retryBtn) retryBtn.disabled = busy;
      if (closeBtn) closeBtn.disabled = false;
      if (loadingCancel) loadingCancel.disabled = false;
      sheet.setAttribute("aria-busy", busy ? "true" : "false");
      sheet.classList.toggle("is-busy", busy);
      syncApply();
    }

    function revokePreview() {
      if (!previewUrl) return;
      var urlApi = global.URL || global.webkitURL;
      var current = previewUrl;
      previewUrl = "";
      if (urlApi && typeof urlApi.revokeObjectURL === "function") {
        try {
          urlApi.revokeObjectURL(current);
        } catch (err) {
          /* The preview is already dropped. */
        }
      }
    }

    function showPreview(blob) {
      revokePreview();
      if (!previewImg) return;
      var urlApi = global.URL || global.webkitURL;
      if (!blob || !urlApi || typeof urlApi.createObjectURL !== "function") {
        if ("src" in previewImg) previewImg.src = "";
        if (previewImg.removeAttribute) previewImg.removeAttribute("src");
        if (previewWrap) previewWrap.hidden = true;
        return;
      }
      try {
        previewUrl = urlApi.createObjectURL(blob) || "";
      } catch (err) {
        previewUrl = "";
      }
      if (!previewUrl) {
        if (previewWrap) previewWrap.hidden = true;
        return;
      }
      previewImg.src = previewUrl;
      if (previewImg.setAttribute) previewImg.setAttribute("alt", "پیش‌نمایش عکس یخچال");
      if (previewWrap) previewWrap.hidden = false;
    }

    function hideStages() {
      chooser.hidden = true;
      if (cameraView) cameraView.hidden = true;
      if (denied) denied.hidden = true;
      loading.hidden = true;
      if (loadingPanel) loadingPanel.hidden = true;
      revokePreview();
      if (previewWrap) previewWrap.hidden = true;
      if (previewImg && previewImg.removeAttribute) previewImg.removeAttribute("src");
      errorBox.hidden = true;
      if (hintEl) hintEl.hidden = true;
      confirmBox.hidden = true;
    }

    function showChooser() {
      hideStages();
      chooser.hidden = false;
      sheet.hidden = false;
      sheet.classList.toggle("is-busy", false);
    }

    function showCamera() {
      hideStages();
      if (cameraView) cameraView.hidden = false;
      sheet.hidden = false;
    }

    function showDenied() {
      stopCamera();
      hideStages();
      chooser.hidden = false;
      if (denied) {
        denied.hidden = false;
        denied.textContent = COPY.cameraDenied;
      }
      sheet.hidden = false;
    }

    function showLoading(blob) {
      stopCamera();
      hideStages();
      if (loadingPanel) loadingPanel.hidden = false;
      loading.hidden = false;
      loading.textContent = COPY.loading;
      if (blob) showPreview(blob);
      sheet.hidden = false;
      sheet.classList.toggle("is-busy", true);
    }

    function showError(message, hint) {
      hideStages();
      errorText.textContent = sanitizeDisplay(message);
      var safeHint = sanitizeDisplay(hint || "");
      if (hintEl) {
        hintEl.textContent = safeHint;
        hintEl.hidden = !safeHint;
      }
      errorBox.hidden = false;
      sheet.hidden = false;
      sheet.classList.toggle("is-busy", false);
      setBusy(false);
    }

    function chosenNames() {
      var seen = Object.create(null);
      var names = [];
      draft.forEach(function (item) {
        if (!item.included) return;
        var name = showName(item.name);
        var key = keyOf(name);
        if (!key || name.length > MAX_NAME_LENGTH || seen[key]) return;
        seen[key] = true;
        names.push(name);
      });
      return names;
    }

    function syncApply() {
      applyBtn.disabled = gate.isBusy() || chosenNames().length === 0;
    }

    function renderDraft() {
      if (typeof candidates.replaceChildren === "function") candidates.replaceChildren();
      draft.forEach(function (item) {
        var li = doc.createElement("li");
        li.className = "confirm-chip" + (item.included ? "" : " is-off");
        if (!li.dataset) li.dataset = {};
        li.dataset.testid = "fridge-candidate";

        var toggle = doc.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = !!item.included;
        if (!toggle.dataset) toggle.dataset = {};
        toggle.dataset.testid = "fridge-toggle";
        toggle.setAttribute("aria-label", "انتخاب " + (item.name || "ماده"));
        toggle.addEventListener("change", function () {
          item.included = !!toggle.checked;
          li.className = "confirm-chip" + (item.included ? "" : " is-off");
          syncApply();
        });

        var field = doc.createElement("input");
        field.type = "text";
        field.value = item.name;
        field.maxLength = MAX_NAME_LENGTH;
        if (!field.dataset) field.dataset = {};
        field.dataset.testid = "fridge-chip-edit";
        field.setAttribute("aria-label", "ویرایش " + (item.name || "ماده"));
        field.addEventListener("input", function () {
          item.name = field.value;
          field.setAttribute("aria-label", "ویرایش " + (showName(field.value) || "ماده"));
          if (confirmStatus) confirmStatus.textContent = "";
          syncApply();
        });

        li.append(toggle, field);
        candidates.append(li);
      });
      if (none) {
        none.hidden = draft.length !== 0;
        none.textContent = COPY.noneFound;
      }
      syncApply();
    }

    function showConfirm(names) {
      draft = names.map(function (name) {
        return { name: name, included: true };
      });
      hideStages();
      confirmBox.hidden = false;
      if (confirmStatus) confirmStatus.textContent = "";
      if (extraInput) extraInput.value = "";
      renderDraft();
      sheet.hidden = false;
      sheet.classList.toggle("is-busy", false);
      setBusy(false);
    }

    function stopCamera() {
      stopStream(stream);
      stream = null;
      if (video) video.srcObject = null;
    }

    function closeSheet() {
      generation += 1;
      cameraToken += 1;
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      gate.end();
      stopCamera();
      revokePreview();
      sheet.hidden = true;
      sheet.classList.toggle("is-busy", false);
      setBusy(false);
    }

    function postImage(blob, ticket) {
      if (!request) {
        showError(messageForFailure(0, { error: "network" }), hintForFailure({ error: "network" }));
        gate.end();
        return;
      }
      showLoading(blob);
      var controller = typeof global.AbortController !== "undefined" ? new global.AbortController() : null;
      activeController = controller;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
      }, REQUEST_TIMEOUT_MS);
      var body = new global.FormData();
      var filename = blob && blob.type === "image/png" ? "fridge.png" : "fridge.jpg";
      body.append("image", blob, filename);
      var fetchOptions = {
        method: "POST",
        headers: { Accept: "application/json" },
        body: body,
      };
      if (controller) fetchOptions.signal = controller.signal;

      request(ENDPOINT, fetchOptions)
        .then(function (response) {
          return response.text().then(function (text) {
            return { response: response, text: text };
          });
        })
        .then(function (result) {
          if (ticket !== generation) return;
          var parsed = null;
          try {
            parsed = result.text ? JSON.parse(result.text) : null;
          } catch (err) {
            parsed = null;
          }
          if (!result.response.ok || !parsed || parsed.ok === false) {
            var code = parsed && parsed.error;
            if (result.response.status === 413 && !code) code = "image_too_large";
            var failure = { error: code || "" };
            showError(messageForFailure(result.response.status, failure), hintForFailure(failure));
            return;
          }
          var names = selectIngredients(parsed.ingredients);
          if (!names) {
            showError(
              messageForFailure(502, { error: "bad_response" }),
              hintForFailure({ error: "bad_response" })
            );
            return;
          }
          showConfirm(names);
        })
        .catch(function (err) {
          if (ticket !== generation) return;
          var aborted = err && (err.name === "AbortError" || err.code === 20);
          var code = aborted ? "timeout" : "network";
          showError(messageForFailure(0, { error: code }), hintForFailure({ error: code }));
        })
        .then(function () {
          clearTimeout(timer);
          if (ticket !== generation) return;
          activeController = null;
          gate.end();
          setBusy(false);
        });
    }

    function beginUpload(file) {
      if (!file || !gate.begin()) return;
      var ticket = generation;
      setBusy(true);
      showLoading(file);
      Promise.resolve()
        .then(function () {
          return prepareImage(file);
        })
        .then(function (blob) {
          if (ticket !== generation) return;
          if (!blob) throw clientError("invalid_image");
          lastImage = blob;
          postImage(blob, ticket);
        })
        .catch(function (err) {
          if (ticket !== generation) return;
          var code = err && err.code;
          if (code !== "invalid_image" && code !== "image_too_large") code = "invalid_image";
          showError(messageForFailure(0, { error: code }), hintForFailure({ error: code }));
          gate.end();
          setBusy(false);
        });
    }

    function onFile(input) {
      var file = input.files && input.files[0];
      if (input && "value" in input) input.value = "";
      if (!file) return;
      beginUpload(file);
    }

    function requestCamera() {
      if (!media || typeof media.getUserMedia !== "function") {
        if (captureInput && typeof captureInput.click === "function") captureInput.click();
        return;
      }
      var token = ++cameraToken;
      cameraBtn.disabled = true;
      var constraints = {
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      };
      Promise.resolve()
        .then(function () {
          return media.getUserMedia(constraints);
        })
        .then(function (next) {
          if (token !== cameraToken || sheet.hidden) {
            stopStream(next);
            return;
          }
          stopCamera();
          stream = next;
          if (video) {
            video.srcObject = next;
            if (typeof video.play === "function") {
              var playing = video.play();
              if (playing && typeof playing.catch === "function") playing.catch(function () {});
            }
          }
          showCamera();
          cameraBtn.disabled = false;
        })
        .catch(function () {
          if (token !== cameraToken || sheet.hidden) return;
          cameraBtn.disabled = false;
          showDenied();
          if (pickBtn && typeof pickBtn.focus === "function") pickBtn.focus();
        });
    }

    openBtn.addEventListener("click", function () {
      if (gate.isBusy()) return;
      if (denied) denied.hidden = true;
      showChooser();
      if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    });

    cameraBtn.addEventListener("click", requestCamera);
    pickBtn.addEventListener("click", function () {
      if (typeof fileInput.click === "function") fileInput.click();
    });
    if (captureInput) captureInput.addEventListener("change", function () { onFile(captureInput); });
    fileInput.addEventListener("change", function () { onFile(fileInput); });

    if (shutter) {
      shutter.addEventListener("click", function () {
        if (!video) return;
        captureFrame(video)
          .then(function (blob) {
            beginUpload(blob);
          })
          .catch(function () {
            showError(
              messageForFailure(0, { error: "invalid_image" }),
              hintForFailure({ error: "invalid_image" })
            );
          });
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        if (lastImage) beginUpload(lastImage);
        else showChooser();
      });
    }

    if (loadingCancel) loadingCancel.addEventListener("click", closeSheet);

    if (extraForm) {
      extraForm.addEventListener("submit", function (event) {
        if (event && event.preventDefault) event.preventDefault();
        var name = showName(extraInput ? extraInput.value : "");
        var key = keyOf(name);
        if (!key) return;
        if (name.length > MAX_NAME_LENGTH) {
          if (confirmStatus) confirmStatus.textContent = "نام ماده خیلی بلند است";
          return;
        }
        var exists = draft.some(function (item) {
          return keyOf(item.name) === key;
        });
        if (exists) {
          if (confirmStatus) confirmStatus.textContent = COPY.alreadyInDraft;
          return;
        }
        draft.push({ name: name, included: true });
        if (extraInput) extraInput.value = "";
        if (confirmStatus) confirmStatus.textContent = "";
        renderDraft();
      });
    }

    applyBtn.addEventListener("click", function () {
      var names = chosenNames();
      if (!names.length) {
        if (confirmStatus) confirmStatus.textContent = COPY.noneChosen;
        return;
      }
      var merged = mergeIntoPantry(pantry, names);
      if (!merged.added.length && !merged.duplicate.length) {
        if (confirmStatus) confirmStatus.textContent = COPY.noneChosen;
        return;
      }
      emitPantryChanged(doc, {
        message: summarizeMerge(merged),
        flash: merged.added[0] || "",
      });
      closeSheet();
    });

    cancelBtn.addEventListener("click", closeSheet);
    if (closeBtn) closeBtn.addEventListener("click", closeSheet);
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

    syncApply();
  }

  function boot() {
    var api = pantryApi();
    if (!api || !api.active) return;
    var fetchImpl = typeof global.fetch === "function" ? global.fetch.bind(global) : null;
    var media = global.navigator && global.navigator.mediaDevices ? global.navigator.mediaDevices : null;
    mount(global.document, api.active, { fetch: fetchImpl, mediaDevices: media });
  }

  var api = {
    COPY: COPY,
    ERROR_COPY: ERROR_COPY,
    SERVICE_HINT: SERVICE_HINT,
    ENDPOINT: ENDPOINT,
    sanitizeDisplay: sanitizeDisplay,
    hintForFailure: hintForFailure,
    selectIngredients: selectIngredients,
    mergeIntoPantry: mergeIntoPantry,
    summarizeMerge: summarizeMerge,
    messageForFailure: messageForFailure,
    isCameraFailure: isCameraFailure,
    createSubmitGate: createSubmitGate,
    mount: mount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AshpazFridge = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
