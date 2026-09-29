/* Fridge photos → confirm → pantry.
   Capture or upload one or more photos, in order, then ask POST /api/vision/fridge.
   The confirm sheet shows each candidate with a confidence and merges
   near-duplicate Persian names before anything is written. Nothing is written
   to the pantry until «تأیید و افزودن به انبار».
   The API key stays on the server. This file never sees it. Image bytes are
   not logged. */
(function (global) {
  "use strict";

  var TOO_MANY = "حداکثر شش عکس در هر بار. یکی را بردارید و دوباره تلاش کنید.";

  var COPY = {
    open: "عکس یخچال",
    loading: "در حال تشخیص مواد…",
    confirm: "تأیید و افزودن به انبار",
    retry: "تلاش دوباره",
    cameraDenied: "دسترسی به دوربین داده نشد. می‌توانید یک عکس انتخاب کنید.",
    noneChosen: "حداقل یک ماده را انتخاب کنید.",
    alreadyInDraft: "این ماده در فهرست هست.",
    noneFound: "موردی در این عکس‌ها پیدا نشد. می‌توانید ماده را بنویسید یا دوباره تلاش کنید.",
    detect: "تشخیص مواد",
    addPhoto: "عکس دیگر",
    tooMany: TOO_MANY,
    merged: "مواد تکراری یا هم‌نام یکی شدند.",
    manual: "دستی",
    confidenceUnknown: "نامشخص",
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
    too_many_images: TOO_MANY,
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
    too_many_images: true,
    invalid_request: true,
  };

  // Short names the model uses for the same food. The last label is the one
  // shown when two of these arrive together. A single short name is not rewritten.
  var ALIAS_GROUPS = [
    ["گوجه", "گوجه فرنگی", "گوجه\u200cفرنگی"],
    ["فلفل دلمه", "فلفل دلمه ای", "فلفل دلمه\u200cای"],
    ["رب گوجه", "رب گوجه فرنگی", "رب گوجه\u200cفرنگی"],
  ];

  var ENDPOINT = "/api/vision/fridge";
  var REQUEST_TIMEOUT_MS = 100000;
  var MAX_NAME_LENGTH = 40;
  var MAX_CANDIDATES = 30;
  var MAX_PHOTOS = 6;
  var CLIENT_IMAGE_LIMIT = 12 * 1024 * 1024;

  function pantryApi() {
    return global.AshpazPantry || null;
  }

  function showName(value) {
    var api = pantryApi();
    if (api && typeof api.displayName === "function") return api.displayName(value);
    return String(value || "")
      .replace(/[\u200e\u200f]/g, "")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[ةۀ]/g, "ه")
      .replace(/\u0640/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function keyOf(value) {
    var api = pantryApi();
    if (api && typeof api.identityKey === "function") return api.identityKey(value);
    return showName(value)
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

  function aliasIndex() {
    var map = Object.create(null);
    ALIAS_GROUPS.forEach(function (group) {
      var canonical = showName(group[group.length - 1]);
      var groupId = keyOf(canonical);
      group.forEach(function (label) {
        map[keyOf(label)] = { group: groupId, canonical: canonical };
      });
    });
    return map;
  }

  function groupKey(name, aliases) {
    var key = keyOf(name);
    var alias = aliases[key];
    return alias ? alias.group : key;
  }

  function readConfidence(value) {
    if (typeof value === "boolean" || value == null || value === "") return null;
    var number = null;
    var scale = false;
    if (typeof value === "number") {
      number = value;
      scale = number > 1 && Math.floor(number) === number;
    } else if (typeof value === "string") {
      var raw = toAsciiDigits(value).trim();
      var text = raw.replace(/[%٪]/g, "").replace(/\s+/g, "");
      if (!text) return null;
      number = Number(text);
      scale =
        number > 1 &&
        (raw.indexOf("%") !== -1 || raw.indexOf("٪") !== -1 || text.indexOf(".") === -1);
    } else {
      return null;
    }
    if (!isFinite(number)) return null;
    if (scale && number <= 100) number = number / 100;
    if (number < 0 || number > 1) return null;
    return Math.round(number * 100) / 100;
  }

  function higherConfidence(current, next) {
    if (next == null) return current;
    if (current == null || next > current) return next;
    return current;
  }

  function candidateFrom(value) {
    var rawName = value;
    var confidence = null;
    if (value && typeof value === "object") {
      rawName = value.name || value.item || value.title || "";
      if (Object.prototype.hasOwnProperty.call(value, "confidence")) {
        confidence = readConfidence(value.confidence);
      } else if (Object.prototype.hasOwnProperty.call(value, "score")) {
        confidence = readConfidence(value.score);
      }
    }
    var cleaned = String(rawName == null ? "" : rawName).replace(
      /^[\d۰-۹٠-٩]+[.)\-\u2013]\s*/,
      "",
    );
    var name = showName(cleaned);
    var key = keyOf(name);
    if (!key || name.length > MAX_NAME_LENGTH) return null;
    if (/https?:\/\/|www\./i.test(name)) return null;
    if (/sk-[A-Za-z0-9]|bearer\s|api[_-]?key|gap_code|\[redacted\]/i.test(name)) return null;
    return { name: name, confidence: confidence };
  }

  function selectIngredients(value) {
    if (!Array.isArray(value)) return null;
    var aliases = aliasIndex();
    var groups = [];
    var indexByGroup = Object.create(null);
    for (var i = 0; i < value.length; i += 1) {
      var item = candidateFrom(value[i]);
      if (!item) continue;
      var key = groupKey(item.name, aliases);
      if (!key) continue;
      var existing = indexByGroup[key];
      if (existing == null) {
        if (groups.length >= MAX_CANDIDATES) continue;
        indexByGroup[key] = groups.length;
        var alias = aliases[keyOf(item.name)];
        groups.push({
          name: item.name,
          confidence: item.confidence,
          count: 1,
          canonical: alias ? alias.canonical : "",
        });
        continue;
      }
      var group = groups[existing];
      group.count += 1;
      group.confidence = higherConfidence(group.confidence, item.confidence);
      if (!group.canonical) {
        var again = aliases[keyOf(item.name)];
        if (again) group.canonical = again.canonical;
      }
    }
    return groups.map(function (group) {
      var name = group.count > 1 && group.canonical ? group.canonical : group.name;
      return {
        name: name,
        confidence: group.confidence,
        merged: group.count > 1,
      };
    });
  }

  function confidenceLevel(value, manual) {
    if (manual || typeof value !== "number" || !isFinite(value)) return "unknown";
    if (value >= 0.75) return "high";
    if (value >= 0.45) return "mid";
    return "low";
  }

  function confidenceCopy(value, manual) {
    if (manual) return COPY.manual;
    if (typeof value !== "number" || !isFinite(value)) return COPY.confidenceUnknown;
    var pct = Math.round(value * 100);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    return "اطمینان " + toPersianDigits(pct) + "٪";
  }

  function queueCountCopy(count) {
    return toPersianDigits(count) + " عکس آماده است";
  }

  function detectCopy(count) {
    if (!count || count <= 1) return COPY.detect;
    return "تشخیص " + toPersianDigits(count) + " عکس";
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

  function fileExtension(blob) {
    var type = (blob && blob.type) || "";
    if (type === "image/png") return "png";
    if (type === "image/webp") return "webp";
    if (type === "image/gif") return "gif";
    return "jpg";
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
    var cameraCount = doc.getElementById("fridge-camera-count");
    var cameraDetect = doc.getElementById("fridge-camera-detect");
    var cameraReview = doc.getElementById("fridge-camera-review");
    var denied = doc.getElementById("fridge-denied");
    var queuePanel = doc.getElementById("fridge-queue");
    var queueList = doc.getElementById("fridge-queue-list");
    var queueCount = doc.getElementById("fridge-queue-count");
    var queueStatus = doc.getElementById("fridge-queue-status");
    var detectBtn = doc.getElementById("fridge-detect");
    var addPhotoBtn = doc.getElementById("fridge-add-photo");
    var queueCameraBtn = doc.getElementById("fridge-queue-camera");
    var queueClear = doc.getElementById("fridge-queue-clear");
    var loadingPanel = doc.getElementById("fridge-loading-panel");
    var loading = doc.getElementById("fridge-loading");
    var previewWrap = doc.getElementById("fridge-preview-wrap");
    var previewRow = doc.getElementById("fridge-preview-row");
    var previewImg = doc.getElementById("fridge-preview");
    var loadingCancel = doc.getElementById("fridge-loading-cancel");
    var errorBox = doc.getElementById("fridge-error");
    var errorText = doc.getElementById("fridge-error-text");
    var hintEl = doc.getElementById("fridge-error-hint");
    var retryBtn = doc.getElementById("fridge-retry");
    var confirmBox = doc.getElementById("fridge-confirm");
    var mergedNote = doc.getElementById("fridge-merged");
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
      !queuePanel ||
      !queueList ||
      !detectBtn ||
      !addPhotoBtn ||
      !queueClear ||
      !cameraDetect ||
      !cameraReview ||
      !previewRow ||
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
    var queue = [];
    var lastImages = [];
    var stream = null;
    var generation = 0;
    var cameraToken = 0;
    var activeController = null;
    var preparing = false;
    var previewUrls = [];
    var queueUrls = [];
    var tail = Promise.resolve();

    function setBusy(busy) {
      openBtn.disabled = busy;
      cameraBtn.disabled = busy;
      pickBtn.disabled = busy;
      addPhotoBtn.disabled = busy;
      if (queueCameraBtn) queueCameraBtn.disabled = busy;
      if (retryBtn) retryBtn.disabled = busy;
      if (closeBtn) closeBtn.disabled = false;
      if (loadingCancel) loadingCancel.disabled = false;
      if (queueClear) queueClear.disabled = false;
      sheet.setAttribute("aria-busy", busy ? "true" : "false");
      sheet.classList.toggle("is-busy", busy);
      syncApply();
      syncDetect();
    }

    function syncDetect() {
      var locked = gate.isBusy() || preparing;
      detectBtn.disabled = locked || queue.length === 0;
      detectBtn.textContent = detectCopy(queue.length);
      cameraDetect.disabled = locked || queue.length === 0;
      cameraDetect.hidden = queue.length === 0;
      cameraDetect.textContent = detectCopy(queue.length);
      cameraReview.disabled = locked || queue.length === 0;
      if (shutter) shutter.disabled = locked;
      if (queueCount && queuePanel && !queuePanel.hidden) {
        queueCount.textContent = queue.length ? queueCountCopy(queue.length) : "";
      }
      if (cameraCount && cameraView && !cameraView.hidden) {
        cameraCount.textContent = queue.length ? queueCountCopy(queue.length) : "";
      }
    }

    function objectUrl(blob) {
      var urlApi = global.URL || global.webkitURL;
      if (!blob || !urlApi || typeof urlApi.createObjectURL !== "function") return "";
      try {
        return urlApi.createObjectURL(blob) || "";
      } catch (err) {
        return "";
      }
    }

    function revokeAll(urls) {
      var urlApi = global.URL || global.webkitURL;
      urls.forEach(function (current) {
        if (urlApi && typeof urlApi.revokeObjectURL === "function") {
          try {
            urlApi.revokeObjectURL(current);
          } catch (err) {
            /* The preview is already dropped. */
          }
        }
      });
      urls.length = 0;
    }

    function revokePreview() {
      revokeAll(previewUrls);
    }

    function revokeQueueUrls() {
      revokeAll(queueUrls);
    }

    function detachChild(child) {
      if (!child) return;
      var parent = child.parentNode || child.parent;
      if (!parent) return;
      if (typeof parent.removeChild === "function") {
        try {
          parent.removeChild(child);
        } catch (err) {
          /* Already gone. */
        }
        return;
      }
      if (parent.children && parent.children.filter) {
        parent.children = parent.children.filter(function (item) {
          return item !== child;
        });
        child.parent = null;
      }
    }

    function clearExtraPreviews() {
      if (!previewRow.children) return;
      var extras = [];
      for (var i = 0; i < previewRow.children.length; i += 1) {
        if (previewRow.children[i] !== previewImg) extras.push(previewRow.children[i]);
      }
      extras.forEach(detachChild);
    }

    function showPreviews(blobs) {
      revokePreview();
      clearExtraPreviews();
      var list = blobs && blobs.length ? blobs : [];
      if (!previewImg || !list.length) {
        if (previewImg && "src" in previewImg) previewImg.src = "";
        if (previewImg && previewImg.removeAttribute) previewImg.removeAttribute("src");
        if (previewWrap) previewWrap.hidden = true;
        return;
      }
      list.forEach(function (blob, index) {
        var img = previewImg;
        if (index > 0) {
          img = doc.createElement("img");
          img.className = "fridge-preview";
          if (previewRow.append) previewRow.append(img);
        }
        var label = "پیش‌نمایش عکس " + toPersianDigits(index + 1);
        if (img.setAttribute) img.setAttribute("alt", label);
        else img.alt = label;
        var url = objectUrl(blob);
        if (!url) return;
        previewUrls.push(url);
        img.src = url;
      });
      if (previewWrap) previewWrap.hidden = previewUrls.length === 0;
    }

    function hideStages() {
      chooser.hidden = true;
      if (cameraView) cameraView.hidden = true;
      if (denied) denied.hidden = true;
      queuePanel.hidden = true;
      loading.hidden = true;
      if (loadingPanel) loadingPanel.hidden = true;
      revokePreview();
      clearExtraPreviews();
      if (previewWrap) previewWrap.hidden = true;
      if (previewImg && "src" in previewImg) previewImg.src = "";
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
      if (cameraCount) cameraCount.textContent = queue.length ? queueCountCopy(queue.length) : "";
      sheet.hidden = false;
      syncDetect();
    }

    function showDenied() {
      stopCamera();
      if (queue.length) {
        showQueue(COPY.cameraDenied);
        return;
      }
      hideStages();
      chooser.hidden = false;
      if (denied) {
        denied.hidden = false;
        denied.textContent = COPY.cameraDenied;
      }
      sheet.hidden = false;
    }

    function renderQueue() {
      revokeQueueUrls();
      if (typeof queueList.replaceChildren === "function") queueList.replaceChildren();
      queue.forEach(function (blob, index) {
        var li = doc.createElement("li");
        li.className = "fridge-queue-item";
        var img = doc.createElement("img");
        img.className = "fridge-queue-thumb";
        img.alt = "عکس " + toPersianDigits(index + 1);
        var url = objectUrl(blob);
        if (url) {
          queueUrls.push(url);
          img.src = url;
        }
        var remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "fridge-queue-remove";
        remove.textContent = "حذف";
        if (!remove.dataset) remove.dataset = {};
        remove.dataset.testid = "fridge-queue-remove";
        remove.setAttribute("aria-label", "حذف عکس " + toPersianDigits(index + 1));
        remove.addEventListener("click", function () {
          queue.splice(index, 1);
          if (!queue.length) showChooser();
          else showQueue("");
        });
        li.append(img, remove);
        queueList.append(li);
      });
      if (queueCount) queueCount.textContent = queue.length ? queueCountCopy(queue.length) : "";
      syncDetect();
    }

    function showQueue(message) {
      stopCamera();
      hideStages();
      queuePanel.hidden = false;
      renderQueue();
      if (queueStatus) queueStatus.textContent = sanitizeDisplay(message || "");
      sheet.hidden = false;
      sheet.classList.toggle("is-busy", false);
      setBusy(false);
    }

    function showLoading(blobs) {
      stopCamera();
      hideStages();
      if (loadingPanel) loadingPanel.hidden = false;
      loading.hidden = false;
      loading.textContent = COPY.loading;
      if (blobs && blobs.length) showPreviews(blobs);
      sheet.hidden = false;
      sheet.classList.toggle("is-busy", true);
    }

    function showError(message, hint) {
      queue = [];
      revokeQueueUrls();
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

    function paintBadge(badge, item) {
      var level = confidenceLevel(item.confidence, item.manual);
      badge.className = "confidence confidence-" + level;
      badge.textContent = confidenceCopy(item.confidence, item.manual);
      if (!badge.dataset) badge.dataset = {};
      badge.dataset.testid = "fridge-confidence";
      badge.dataset.level = level;
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
        toggle.setAttribute(
          "aria-label",
          "انتخاب " + (item.name || "ماده") + "، " + confidenceCopy(item.confidence, item.manual),
        );
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

        var badge = doc.createElement("span");
        paintBadge(badge, item);

        field.addEventListener("input", function () {
          item.name = field.value;
          var edited = showName(field.value);
          if (edited === item.originalName) {
            item.confidence = item.originalConfidence;
            item.manual = false;
          } else {
            item.confidence = null;
            item.manual = true;
          }
          field.setAttribute("aria-label", "ویرایش " + (edited || "ماده"));
          paintBadge(badge, item);
          if (confirmStatus) confirmStatus.textContent = "";
          syncApply();
        });

        li.append(toggle, field, badge);
        candidates.append(li);
      });
      if (none) {
        none.hidden = draft.length !== 0;
        none.textContent = COPY.noneFound;
      }
      if (mergedNote) {
        var anyMerged = draft.some(function (item) {
          return item.merged;
        });
        mergedNote.hidden = !anyMerged;
        mergedNote.textContent = anyMerged ? COPY.merged : "";
      }
      syncApply();
    }

    function showConfirm(items) {
      draft = items.map(function (item) {
        var name = showName(item.name);
        return {
          name: name,
          originalName: name,
          confidence: item.confidence,
          originalConfidence: item.confidence,
          manual: false,
          merged: !!item.merged,
          included: true,
        };
      });
      queue = [];
      revokeQueueUrls();
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
      preparing = false;
      queue = [];
      lastImages = [];
      stopCamera();
      revokePreview();
      revokeQueueUrls();
      sheet.hidden = true;
      sheet.classList.toggle("is-busy", false);
      setBusy(false);
    }

    function postImages(blobs, ticket) {
      if (!request) {
        showError(messageForFailure(0, { error: "network" }), hintForFailure({ error: "network" }));
        gate.end();
        return;
      }
      lastImages = blobs.slice();
      showLoading(blobs);
      var controller = typeof global.AbortController !== "undefined" ? new global.AbortController() : null;
      activeController = controller;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
      }, REQUEST_TIMEOUT_MS);
      var body = new global.FormData();
      blobs.forEach(function (blob, index) {
        body.append("image", blob, "fridge-" + (index + 1) + "." + fileExtension(blob));
      });
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
          var items = selectIngredients(parsed.ingredients);
          if (!items) {
            showError(
              messageForFailure(502, { error: "bad_response" }),
              hintForFailure({ error: "bad_response" }),
            );
            return;
          }
          showConfirm(items);
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

    function beginDetectFrom(blobs) {
      if (!blobs || !blobs.length || preparing || !gate.begin()) return;
      var ticket = generation;
      setBusy(true);
      postImages(blobs.slice(), ticket);
    }

    function prepareAll(files) {
      return files.reduce(function (chain, file) {
        return chain.then(function (ready) {
          return prepareImage(file).then(function (blob) {
            if (!blob) throw clientError("invalid_image");
            ready.push(blob);
            return ready;
          });
        });
      }, Promise.resolve([]));
    }

    function enqueue(list, options) {
      if (gate.isBusy()) return;
      if (queue.length + list.length > MAX_PHOTOS) {
        if (queue.length) showQueue(COPY.tooMany);
        else showError(messageForFailure(0, { error: "too_many_images" }), "");
        return;
      }
      var ticket = generation;
      preparing = true;
      syncDetect();
      return Promise.resolve()
        .then(function () {
          return prepareAll(list);
        })
        .then(function (blobs) {
          if (ticket !== generation) return;
          blobs.forEach(function (blob) {
            queue.push(blob);
          });
          if (options.returnTo === "camera" && stream) showCamera();
          else showQueue("");
        })
        .catch(function (err) {
          if (ticket !== generation) return;
          var code = err && err.code;
          if (code !== "invalid_image" && code !== "image_too_large") code = "invalid_image";
          var message = messageForFailure(0, { error: code });
          if (queue.length) showQueue(message);
          else showError(message, hintForFailure({ error: code }));
        })
        .then(function () {
          preparing = false;
          if (ticket !== generation) return;
          syncDetect();
        });
    }

    function addFiles(list, options) {
      if (!list || !list.length || gate.isBusy()) return Promise.resolve();
      var run = tail.then(function () {
        return enqueue(list, options || {});
      });
      tail = run.then(
        function () {
          return null;
        },
        function () {
          return null;
        },
      );
      return run;
    }

    function onFile(input) {
      var list = input.files ? Array.prototype.slice.call(input.files) : [];
      if (input && "value" in input) input.value = "";
      if (input) input.files = null;
      if (!list.length) return;
      addFiles(list);
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
          if (!queue.length && pickBtn && typeof pickBtn.focus === "function") pickBtn.focus();
        });
    }

    openBtn.addEventListener("click", function () {
      if (gate.isBusy() || preparing) return;
      queue = [];
      lastImages = [];
      revokeQueueUrls();
      if (denied) denied.hidden = true;
      showChooser();
      if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    });

    cameraBtn.addEventListener("click", requestCamera);
    pickBtn.addEventListener("click", function () {
      if (typeof fileInput.click === "function") fileInput.click();
    });
    if (captureInput) {
      captureInput.addEventListener("change", function () {
        onFile(captureInput);
      });
    }
    fileInput.addEventListener("change", function () {
      onFile(fileInput);
    });

    if (shutter) {
      shutter.addEventListener("click", function () {
        if (!video || preparing || gate.isBusy()) return;
        captureFrame(video)
          .then(function (blob) {
            return addFiles([blob], { returnTo: "camera" });
          })
          .catch(function () {
            var message = messageForFailure(0, { error: "invalid_image" });
            if (queue.length) showQueue(message);
            else {
              showError(message, hintForFailure({ error: "invalid_image" }));
            }
          });
      });
    }

    detectBtn.addEventListener("click", function () {
      beginDetectFrom(queue);
    });
    cameraDetect.addEventListener("click", function () {
      beginDetectFrom(queue);
    });
    cameraReview.addEventListener("click", function () {
      if (queue.length) showQueue("");
    });
    addPhotoBtn.addEventListener("click", function () {
      if (typeof fileInput.click === "function") fileInput.click();
    });
    if (queueCameraBtn) queueCameraBtn.addEventListener("click", requestCamera);
    queueClear.addEventListener("click", closeSheet);

    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        if (lastImages.length) beginDetectFrom(lastImages);
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
        draft.push({
          name: name,
          originalName: name,
          confidence: null,
          originalConfidence: null,
          manual: true,
          merged: false,
          included: true,
        });
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
    syncDetect();
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
    MAX_PHOTOS: MAX_PHOTOS,
    sanitizeDisplay: sanitizeDisplay,
    hintForFailure: hintForFailure,
    selectIngredients: selectIngredients,
    confidenceCopy: confidenceCopy,
    confidenceLevel: confidenceLevel,
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
