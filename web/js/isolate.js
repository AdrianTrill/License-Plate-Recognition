// WebAssembly runs on several threads only in a cross-origin isolated page, which takes headers GitHub Pages can't
// send. The service worker in sw.js adds them; on a first visit it starts too late for this page, which reloads once,
// as soon as the worker controls it, to be served with them. Where that can't work (no service workers, a private
// window, a browser that keeps the page from being isolated), the page goes on, on one thread.

const TRIED = 'lpr-isolation-tried';

export async function isolate() {
  if (self.crossOriginIsolated || !self.isSecureContext || !navigator.serviceWorker) return;
  try {
    // One attempt per tab, so that a page the headers didn't isolate isn't reloaded again and again.
    if (sessionStorage.getItem(TRIED)) return;
    sessionStorage.setItem(TRIED, '1');
    await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(() => reject(new Error('The service worker took too long')), 4000);
      });
    }
    location.reload();
    await new Promise(() => {});
  } catch {
    // Without the worker, or its storage: one thread.
  }
}
