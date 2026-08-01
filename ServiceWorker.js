const scopePath = new URL(self.registration.scope).pathname;
const cachePrefix = "RogueMaul-" + encodeURIComponent(scopePath) + "-";
const buildRevision = "6149cc8f5d5533d6";
const cacheName = cachePrefix + "1.1.0-" + buildRevision;
const releaseManifestPath = "release-manifest.json";
const contentToCache = [
  "index.html",
  "manifest.webmanifest",
  "TemplateData/style.css",
  "TemplateData/icon-192.png",
  "TemplateData/icon-512.png",
  "Build/20260731-235719.loader.js",
  "Build/20260731-235719.framework.js.unityweb",
  "Build/20260731-235719.data.unityweb",
  "Build/20260731-235719.wasm.unityweb"
];

self.addEventListener("install", event => {
  event.waitUntil(installVerifiedRelease());
});

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

async function verifyResponse(path, response, expected) {
  if (!response || !response.ok) {
    throw new Error("Release asset request failed for " + path + ".");
  }
  const bytes = await response.clone().arrayBuffer();
  const actualHash = await sha256Hex(bytes);
  const rawMatches = Number(expected.bytes) === bytes.byteLength && actualHash === expected.sha256;
  const decodedMatches = Number(expected.decodedBytes) === bytes.byteLength && actualHash === expected.decodedSha256;
  if (!rawMatches && !decodedMatches) {
    throw new Error("Release asset checksum mismatch for " + path + ".");
  }
}

function validateReleaseManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.revision !== buildRevision || !Array.isArray(manifest.files)) {
    throw new Error("The release manifest does not match this service worker.");
  }
  const files = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || files.has(file.path)) {
      throw new Error("The release manifest contains an invalid or duplicate file record.");
    }
    if (file.decodedSha256 && (!/^[a-f0-9]{64}$/.test(file.decodedSha256) || !Number.isSafeInteger(file.decodedBytes) || file.decodedBytes <= 0)) {
      throw new Error("The release manifest contains invalid decoded-file metadata.");
    }
    files.set(file.path, file);
  }
  for (const path of contentToCache) {
    if (!files.has(path)) throw new Error("The release manifest is missing " + path + ".");
  }
  return files;
}

async function installVerifiedRelease() {
  const cache = await caches.open(cacheName);
  const manifestRequest = new Request(releaseManifestPath, { cache: "no-store" });
  const manifestResponse = await fetch(manifestRequest);
  if (!manifestResponse || !manifestResponse.ok) throw new Error("The release manifest could not be downloaded.");
  const manifest = await manifestResponse.clone().json();
  const files = validateReleaseManifest(manifest);
  for (const path of contentToCache) {
    const response = await fetch(new Request(path, { cache: "no-store" }));
    await verifyResponse(path, response, files.get(path));
    await cache.put(path, response);
  }
  const shell = await cache.match("index.html");
  if (!shell) throw new Error("The verified release did not contain its shell.");
  await cache.put("./", shell.clone());
  await cache.put(releaseManifestPath, manifestResponse);
}

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName).map(name => caches.delete(name)))));
});

async function cacheBestEffort(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn("Rogue Maul could not cache a response; continuing online.", error);
  }
}

function relativeReleasePath(requestUrl) {
  const scopeUrl = new URL(self.registration.scope);
  if (requestUrl.origin !== scopeUrl.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) return null;
  const path = requestUrl.pathname.slice(scopeUrl.pathname.length);
  return path || "index.html";
}

async function loadRuntimeManifest(cache) {
  let manifestResponse = await cache.match(releaseManifestPath);
  if (!manifestResponse) {
    manifestResponse = await fetch(new Request(releaseManifestPath, { cache: "no-store" }));
    if (!manifestResponse || !manifestResponse.ok) throw new Error("The release manifest could not be recovered.");
  }
  const manifest = await manifestResponse.clone().json();
  const files = validateReleaseManifest(manifest);
  await cacheBestEffort(cache, releaseManifestPath, manifestResponse);
  return files;
}

async function verifyRuntimeResponse(cache, requestUrl, response, requiredPath) {
  const path = requiredPath || relativeReleasePath(requestUrl);
  if (!path) return false;
  const files = await loadRuntimeManifest(cache);
  const expected = files.get(path);
  if (!expected) return false;
  await verifyResponse(path, response, expected);
  return true;
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const currentShell = await cache.match("index.html") || await cache.match("./");
      if (currentShell) return currentShell;
      try {
        const response = await fetch(new Request("index.html", { cache: "no-store" }));
        if (response && response.ok) {
          await verifyRuntimeResponse(cache, requestUrl, response, "index.html");
          await cacheBestEffort(cache, "index.html", response);
          await cacheBestEffort(cache, "./", response);
        }
        return response;
      } catch (error) {
        return await cache.match(event.request)
          || await cache.match("index.html")
          || await cache.match("./")
          || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (!response || !response.ok) return response;
      const verifiedReleaseAsset = await verifyRuntimeResponse(cache, requestUrl, response);
      if (verifiedReleaseAsset) await cacheBestEffort(cache, event.request, response);
      return response;
    } catch (error) {
      console.error("Rogue Maul rejected an unverified release response.", error);
      return await cache.match(event.request) || Response.error();
    }
  })());
});
