import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/shared/api/client";
import * as storage from "../src/shared/state/storage";
import { checksum, pendingResume, uploadResume } from "../src/shared/api/files";

afterEach(async () => {
  vi.unstubAllGlobals();
  await storage.stored(`resume-finalize:${api.ownerId}`, "delete");
});
it("reserves before bytes, verifies an accepted ambiguous upload and reuses exact finalization", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const file = {
    type: "application/pdf",
    size: 3,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as File;
  const metadata = { label: "Synthetic", country: null, track: null };
  let uploaded = false;
  const upload = vi.fn(async () => {
    expect(await pendingResume()).toMatchObject({ checksum: await checksum(file) });
    uploaded = true;
    return { error: new Error("ACK lost") };
  });
  const download = vi.fn(async () => ({ data: uploaded ? file : null, error: null }));
  const inputs: unknown[] = [];
  const invoke = vi.fn(async (_name, request) => {
    inputs.push(request.body.input);
    return inputs.length === 1
      ? { error: new Error("finalization ACK lost") }
      : { data: { id: "synthetic", version: 1 }, error: null };
  });
  vi.spyOn(api, "requireSupabase").mockReturnValue({
    storage: { from: () => ({ upload, download }) },
    functions: { invoke },
  } as never);
  await expect(uploadResume(file, metadata)).rejects.toThrow(/Subida sin confirmar/);
  const reserved = await pendingResume();
  await expect(uploadResume(file, metadata)).rejects.toThrow(/finalizar/);
  expect(upload).toHaveBeenCalledOnce();
  expect(await pendingResume()).toEqual(reserved);
  await uploadResume(file, metadata);
  expect(inputs).toEqual([reserved, reserved]);
  expect(upload).toHaveBeenCalledOnce();
  expect(await pendingResume()).toBeUndefined();
  expect(JSON.stringify(reserved)).not.toContain("arrayBuffer");
});
it("does not dispatch bytes when durable reservation fails", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const file = {
    type: "application/pdf",
    size: 1,
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  } as File;
  const upload = vi.fn();
  vi.spyOn(api, "requireSupabase").mockReturnValue({
    storage: { from: () => ({ upload }) },
  } as never);
  vi.spyOn(storage, "stored").mockImplementation(async (_key, action) => {
    if (action === "put") throw new Error("blocked");
    return undefined;
  });
  await expect(
    uploadResume(file, { label: "Synthetic", country: null, track: null }),
  ).rejects.toThrow("blocked");
  expect(upload).not.toHaveBeenCalled();
});
it("keeps the pending receipt intact across reselect, mismatch, lost upload and verify errors", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const pdf = (bytes: number[]) =>
    ({
      type: "application/pdf",
      size: bytes.length,
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    }) as File;
  const original = pdf([1, 2, 3]);
  const receipt = {
    label: "Synthetic",
    country: null,
    track: null,
    storage_path: `${api.ownerId}/reserved/resume.pdf`,
    checksum: await checksum(original),
    media_type: "application/pdf",
    active: true,
    idempotency_key: "33333333-3333-4333-8333-333333333333",
  };
  await storage.stored(`resume-finalize:${api.ownerId}`, "put", receipt);
  const upload = vi.fn(async () => ({ error: null }));
  const download = vi.fn();
  const invoke = vi.fn(async () => ({ data: { id: "synthetic", version: 1 }, error: null }));
  vi.spyOn(api, "requireSupabase").mockReturnValue({
    storage: { from: () => ({ upload, download }) },
    functions: { invoke },
  } as never);
  const metadata = { label: "Otro", country: null, track: null };
  await expect(uploadResume(pdf([9]), metadata)).rejects.toThrow(/mismo archivo/);
  expect(download).not.toHaveBeenCalled();
  download.mockResolvedValueOnce({ data: pdf([7, 7, 7]), error: null });
  await expect(uploadResume(original, metadata)).rejects.toThrow(/no coincide/);
  download.mockResolvedValueOnce({ data: null, error: { statusCode: "500" } });
  await expect(uploadResume(original, metadata)).rejects.toThrow(/No se pudo verificar/);
  expect(upload).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(await pendingResume()).toEqual(receipt);
  download.mockResolvedValueOnce({ data: null, error: { statusCode: "404" } });
  await uploadResume(original, metadata);
  expect(upload).toHaveBeenCalledWith(receipt.storage_path, original, expect.anything());
  expect(invoke).toHaveBeenCalledWith("crm", {
    body: { operation: "resumes.finalize", input: receipt },
  });
  expect(await pendingResume()).toBeUndefined();
});
it("rejects invalid CV metadata before reserving a receipt or sending bytes", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const upload = vi.fn();
  vi.spyOn(api, "requireSupabase").mockReturnValue({
    storage: { from: () => ({ upload }) },
  } as never);
  const file = {
    type: "application/pdf",
    size: 1,
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  } as File;
  await expect(uploadResume(file, { label: "   ", country: null, track: null })).rejects.toThrow(
    /nombre de la versión/,
  );
  expect(await pendingResume()).toBeUndefined();
  expect(upload).not.toHaveBeenCalled();
});
