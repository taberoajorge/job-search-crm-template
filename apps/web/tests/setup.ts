import "fake-indexeddb/auto";
import { afterEach, vi } from "vitest";
import { clearRecovery } from "../src/shared/state/recovery";
import { cleanup, configure } from "@testing-library/react";
// findBy* waits 1 s by default; large renders exceed that on loaded hosts (see vite.config.ts).
configure({ asyncUtilTimeout: 15_000 });
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearRecovery();
});
// jsdom lacks object URLs; downloads revoke theirs in a late setTimeout that can outlive a test's
// own URL stub, so keep harmless defaults on the real global.
URL.createObjectURL ??= () => "blob:test";
URL.revokeObjectURL ??= () => {};
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
// Like browsers, closing an open dialog fires "close", so tests exercise real close wiring.
HTMLDialogElement.prototype.close = function () {
  if (!this.hasAttribute("open")) return;
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};
