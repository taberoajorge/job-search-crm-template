import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("links the standalone manifest and supplies correctly sized PNG installation icons", () => {
  const html = readFileSync("index.html", "utf8");
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(html).toContain('<link rel="apple-touch-icon" href="/icon-180.png">');
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  expect(manifest.name).toBeTruthy();
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");
  for (const size of [180, 192, 512]) {
    const png = readFileSync(`public/icon-${size}.png`);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    if (size !== 180)
      expect(manifest.icons).toContainEqual({
        src: `/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "any",
      });
  }
});
