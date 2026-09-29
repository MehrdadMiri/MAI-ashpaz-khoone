const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("zlib");

const root = __dirname;

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(buf.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], color: buf[25] };
}

function decodeRgb(buf) {
  const { width, height, depth, color } = pngSize(buf);
  assert.equal(depth, 8);
  assert.equal(color, 2);
  let data = Buffer.alloc(0);
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") data = Buffer.concat([data, chunk]);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(data);
  const stride = width * 3;
  const pixels = Buffer.alloc(width * height * 3);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[src], 0);
    src += 1;
    raw.copy(pixels, y * stride, src, src + stride);
    src += stride;
  }
  return { width, height, pixels };
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 3;
  return [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]];
}

test("manifest names آشپزخونه and matches the pantry colors", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  const css = read("pantry.css");
  assert.equal(manifest.name, "آشپزخونه");
  assert.equal(manifest.short_name, "آشپزخونه");
  assert.equal(manifest.lang, "fa");
  assert.equal(manifest.dir, "rtl");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#f6f1e7");
  assert.equal(manifest.theme_color, "#9f3d24");
  assert.match(css, /--bg:\s*#f6f1e7/);
  assert.match(css, /--accent:\s*#9f3d24/);
  assert.equal(JSON.stringify(manifest).includes("GAP_CODE_API_KEY"), false);

  const icons = manifest.icons;
  for (const size of ["192x192", "512x512"]) {
    assert.ok(icons.some((icon) => icon.sizes === size && icon.purpose === "any" && icon.type === "image/png"));
    assert.ok(icons.some((icon) => icon.sizes === size && icon.purpose === "maskable" && icon.type === "image/png"));
  }
});

test("icons are maskable PNGs in the pantry accent", () => {
  const accent = [0x9f, 0x3d, 0x24];
  for (const [file, size] of [
    ["icons/icon-192.png", 192],
    ["icons/icon-512.png", 512],
    ["icons/apple-touch-icon.png", 180],
  ]) {
    const image = decodeRgb(fs.readFileSync(path.join(root, file)));
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    assert.deepEqual(pixel(image, 0, 0), accent);
    assert.deepEqual(pixel(image, size - 1, size - 1), accent);
    const center = pixel(image, Math.floor(size / 2), Math.floor(size / 2));
    assert.notDeepEqual(center, accent);

    const safe = size * 0.4;
    const mid = (size - 1) / 2;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const rgb = pixel(image, x, y);
        const delta = Math.abs(rgb[0] - accent[0]) + Math.abs(rgb[1] - accent[1]) + Math.abs(rgb[2] - accent[2]);
        if (delta < 24) continue;
        const dx = x - mid;
        const dy = y - mid;
        assert.ok(dx * dx + dy * dy <= safe * safe, `${file} pixel ${x},${y} leaves the maskable safe zone`);
      }
    }
  }
});

test("the page links the manifest, theme color, apple touch icon, and service worker", () => {
  const html = read("index.html");
  const register = read("pwa.js");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /name="theme-color" content="#9f3d24"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /src="pwa\.js"/);
  assert.match(html, /افزودن به صفحهٔ اصلی/);
  assert.match(html, /id="install-note"/);
  assert.match(register, /navigator\.serviceWorker\.register\("\/sw\.js"/);
  assert.equal(html.includes("GAP_CODE_API_KEY"), false);
  assert.equal(register.includes("GAP_CODE_API_KEY"), false);
  assert.equal(register.includes("/api/"), false);
});

test("the service worker caches the shell and leaves the API on the network", () => {
  const sw = read("sw.js");
  const docker = read("Dockerfile");
  assert.match(sw, /addEventListener\("fetch"/);
  assert.match(sw, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /caches\.open/);
  assert.equal(sw.includes("GAP_CODE_API_KEY"), false);
  assert.equal(sw.includes("gapgpt"), false);
  assert.match(docker, /sw\.js/);
  assert.match(docker, /manifest\.webmanifest/);
  assert.match(docker, /icon-192\.png/);
  assert.match(docker, /icon-512\.png/);

  const listed = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(listed);
  const urls = [...listed[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(urls.includes("/"));
  assert.ok(urls.includes("/manifest.webmanifest"));
  assert.equal(urls.some((url) => url.startsWith("/api/")), false);
  for (const url of urls) {
    if (url === "/") continue;
    assert.equal(fs.existsSync(path.join(root, url.slice(1))), true, url);
  }
});

test("nginx serves the manifest type and a stable service worker path", () => {
  const nginx = read("nginx.conf");
  assert.match(nginx, /location = \/manifest\.webmanifest/);
  assert.match(nginx, /application\/manifest\+json/);
  assert.match(nginx, /location = \/sw\.js/);
  assert.match(nginx, /application\/javascript/);
  const manifestBlock = nginx.slice(nginx.indexOf("location = /manifest.webmanifest"), nginx.indexOf("location = /sw.js"));
  assert.equal(manifestBlock.includes("try_files"), false);
  const swBlock = nginx.slice(nginx.indexOf("location = /sw.js"), nginx.indexOf("location /"));
  assert.equal(swBlock.includes("try_files"), false);
});

test("the readme tells people how to install", () => {
  const readme = fs.readFileSync(path.join(root, "..", "README.md"), "utf8");
  assert.match(readme, /افزودن به صفحهٔ اصلی/);
  assert.match(readme, /Add to Home Screen/);
  assert.match(readme, /localhost:8080/);
  assert.match(readme, /HTTPS/);
});
