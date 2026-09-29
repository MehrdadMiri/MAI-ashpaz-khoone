// Registers the installability service worker. Failure leaves the page as a normal site.
(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(function () {});
  });
})();
