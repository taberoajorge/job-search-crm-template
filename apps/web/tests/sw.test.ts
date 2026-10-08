import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("caches one navigation shell under / and serves hashed assets from cache first", async () => {
  const stored = new Map<string, Response>();
  const keyOf = (request: string | { url: string }) =>
    new URL(typeof request === "string" ? request : request.url, "https://crm.test").pathname +
    new URL(typeof request === "string" ? request : request.url, "https://crm.test").search;
  const cache = {
    put: async (request: string | { url: string }, response: Response) => {
      stored.set(keyOf(request), response);
    },
    // Like Cache Storage, a match honours Vary unless ignoreVary is set (precache vs module request).
    match: async (request: string | { url: string }, options?: { ignoreVary?: boolean }) =>
      typeof request !== "string" && request.url.includes("/assets/") && !options?.ignoreVary
        ? undefined
        : stored.get(keyOf(request)),
    addAll: async () => {},
  };
  const handlers: Record<string, (event: unknown) => void> = {};
  const network = vi.fn(async (request: { url: string }) => {
    const response = new Response(`body:${request.url}`);
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  });
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    URL,
    Response,
    Promise,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: network,
    self: {
      location: { origin: "https://crm.test" },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        (handlers[type] = handler),
    },
  });
  const dispatch = async (url: string, mode: string) => {
    let reply: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.fetch!({
      request: { url, method: "GET", mode },
      respondWith: (response: Promise<Response>) => (reply = response),
      waitUntil: (work: Promise<unknown>) => pending.push(work),
    });
    const response = await reply;
    await Promise.all(pending);
    return response;
  };
  await dispatch(
    "https://crm.test/?screen=pipeline&job=11111111-1111-4111-8111-111111111111",
    "navigate",
  );
  await dispatch("https://crm.test/oauth/consent?authorization_id=abc", "navigate");
  expect([...stored.keys()]).toEqual(["/"]);
  await dispatch("https://crm.test/assets/index-abc.js", "cors");
  await dispatch("https://crm.test/assets/index-abc.js", "cors");
  expect(network.mock.calls.filter(([r]) => r.url.endsWith("index-abc.js"))).toHaveLength(1);
});
