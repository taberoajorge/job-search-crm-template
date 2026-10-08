import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  let connect = "'self'";
  try {
    const url = new URL(env.VITE_SUPABASE_URL || "");
    if (["https:", "http:"].includes(url.protocol)) {
      connect += ` ${url.origin}`;
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      connect += ` ${url.origin}`;
    }
  } catch {
    /* Unconfigured builds remain fail closed. */
  }
  // PDF.js 6 loads its JBIG2/JPEG 2000/ICC decoders (or their JS fallbacks) from wasmUrl.
  const pdfWasm = join(
    dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
    "wasm",
  );
  const decoders = readdirSync(pdfWasm).filter((name) =>
    /^(jbig2|openjpeg|qcms).*\.(wasm|js)$/.test(name),
  );
  return {
    plugins: [
      react(),
      {
        name: "pdfjs-decoders",
        configureServer(server) {
          server.middlewares.use("/pdfjs/wasm/", (req, res, next) => {
            const name = basename(req.url ?? "");
            if (!decoders.includes(name) || !existsSync(join(pdfWasm, name))) return next();
            res.setHeader(
              "Content-Type",
              name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
            );
            res.end(readFileSync(join(pdfWasm, name)));
          });
        },
        generateBundle() {
          for (const name of decoders)
            this.emitFile({
              type: "asset",
              fileName: `pdfjs/wasm/${name}`,
              source: readFileSync(join(pdfWasm, name)),
            });
        },
      },
      {
        name: "static-shell-inventory",
        apply: "build",
        writeBundle(options, bundle) {
          // PDF.js only runs after an online signed download; fetch it at runtime, not on install.
          const assets = Object.keys(bundle)
            .filter((path) => !path.endsWith(".map") && !/^(assets\/pdf[.-]|pdfjs\/)/.test(path))
            .map((path) => "/" + path)
            .sort();
          const version = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 16);
          const source = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8")
            .replace('"crm-static-v2"', JSON.stringify("crm-static-" + version))
            .replace(
              '  "/",',
              '  "/",\n' +
                assets
                  .filter((path) => path !== "/index.html")
                  .map((path) => `  ${JSON.stringify(path)},`)
                  .join("\n"),
            );
          writeFileSync(`${options.dir || "dist"}/sw.js`, source);
        },
      },
      {
        name: "production-csp",
        apply: "build",
        transformIndexHtml: () => [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ${connect}; img-src 'self' data: blob: https:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`,
            },
            // Meta policies only govern content after them: precede the entry script and CSS.
            injectTo: "head-prepend",
          },
        ],
      },
    ],
    build: {
      rolldownOptions: {
        output: {
          // Stable vendor chunks survive app-only releases in the browser and service-worker caches.
          // A group also takes its dependencies by default, so shared libraries (React, zod) get a
          // higher priority than the SDKs that import them, or they would land in vendor-auth.
          codeSplitting: {
            groups: [
              {
                name: "vendor-react",
                test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 50,
              },
              { name: "vendor-zod", test: /[\\/]node_modules[\\/]zod[\\/]/, priority: 40 },
              { name: "vendor-query", test: /[\\/]node_modules[\\/]@tanstack[\\/]/, priority: 30 },
              {
                name: "vendor-supabase",
                test: /[\\/]node_modules[\\/]@supabase[\\/]/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
    test: {
      env: { VITE_OWNER_ID: "00000000-0000-4000-8000-000000000000" },
      environment: "jsdom",
      setupFiles: "./tests/setup.ts",
      // Parallel worktrees and agents load hosts heavily; jsdom renders of the 93-card pipeline
      // took up to 24 s there. Timeouts bound hangs, not app speed.
      testTimeout: 60_000,
      // Node 25+ ships a global localStorage (undefined without --localstorage-file) that shadows jsdom's.
      // Vitest 4+ replaced poolOptions with a top-level execArgv.
      execArgv:
        Number(process.versions.node.split(".")[0]) >= 25 ? ["--no-experimental-webstorage"] : [],
    },
  };
});
