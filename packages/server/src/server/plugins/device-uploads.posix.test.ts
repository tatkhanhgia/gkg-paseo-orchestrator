import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileUploadStore, resolveUploadsDirectory } from "../file-upload/index.js";
import { resolveDeviceUpload } from "./device-uploads.js";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";

describe("resolveDeviceUpload", () => {
  let home: string;
  let uploads: string;
  let outside: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-device-uploads-")));
    uploads = resolveUploadsDirectory(home);
    outside = path.join(home, "outside");
    await mkdir(uploads, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Uploads `body` through the real upload store and returns the handle the app would get. */
  async function storeUpload(fileName: string, body: string) {
    const store = new FileUploadStore({ paseoHome: home });
    const bytes = new TextEncoder().encode(body);
    const metadata = {
      mime: "text/plain",
      size: bytes.byteLength,
      encoding: "binary" as const,
      modifiedAt: new Date(0).toISOString(),
      fileName,
    };
    store.beginUpload({
      type: "file.upload.request",
      fileName,
      mimeType: "text/plain",
      size: bytes.byteLength,
      modifiedAt: metadata.modifiedAt,
      requestId: "r1",
    });
    const frame = (input: Parameters<typeof encodeFileTransferFrame>[0]) => {
      const decoded = decodeFileTransferFrame(encodeFileTransferFrame(input));
      if (!decoded) throw new Error("Expected file transfer frame");
      return decoded;
    };
    await store.receiveFrame(
      frame({ opcode: FileTransferOpcode.FileBegin, requestId: "r1", metadata }),
    );
    await store.receiveFrame(
      frame({ opcode: FileTransferOpcode.FileChunk, requestId: "r1", payload: bytes }),
    );
    const response = await store.receiveFrame(
      frame({ opcode: FileTransferOpcode.FileEnd, requestId: "r1" }),
    );
    const file = response?.payload.file;
    if (!file) throw new Error("upload did not complete");
    return { id: file.id, fileName: file.fileName };
  }

  it("resolves a file the upload store received and removes only that upload", async () => {
    const kept = await storeUpload("kept.txt", "kept");
    const file = await storeUpload("report.txt", "report body");

    const resolved = await resolveDeviceUpload(uploads, file);

    expect(resolved).toMatchObject({ path: path.join(uploads, file.id, "report.txt"), size: 11 });
    await resolved.remove();
    expect(existsSync(path.join(uploads, file.id))).toBe(false);
    expect(existsSync(path.join(uploads, kept.id, "kept.txt"))).toBe(true);
  });

  it.each([
    { id: "../outside", fileName: "secret.txt" },
    { id: "outside", fileName: "secret.txt" },
    { id: `upload_${randomUUID()}/../../outside`, fileName: "secret.txt" },
    { id: `upload_${randomUUID().toUpperCase()}`, fileName: "secret.txt" },
  ])("refuses the id $id", async (handle) => {
    await expect(resolveDeviceUpload(uploads, handle)).rejects.toThrow("Unknown upload.");
  });

  it.each(["../../outside/secret.txt", "..", ".", "", "a\\b", "a\0b"])(
    "refuses the file name %j",
    async (fileName) => {
      const file = await storeUpload("report.txt", "report");
      await expect(resolveDeviceUpload(uploads, { id: file.id, fileName })).rejects.toThrow(
        "Unknown upload.",
      );
    },
  );

  it("refuses an upload directory or file that is a link out of the uploads directory", async () => {
    const linkedDirectory = `upload_${randomUUID()}`;
    await symlink(outside, path.join(uploads, linkedDirectory));
    await expect(
      resolveDeviceUpload(uploads, { id: linkedDirectory, fileName: "secret.txt" }),
    ).rejects.toThrow("Unknown upload.");

    const file = await storeUpload("report.txt", "report");
    await symlink(path.join(outside, "secret.txt"), path.join(uploads, file.id, "link.txt"));
    await expect(
      resolveDeviceUpload(uploads, { id: file.id, fileName: "link.txt" }),
    ).rejects.toThrow("Unknown upload.");
    expect(existsSync(path.join(outside, "secret.txt"))).toBe(true);
  });

  it("says when an upload no longer exists", async () => {
    await expect(
      resolveDeviceUpload(uploads, { id: `upload_${randomUUID()}`, fileName: "gone.txt" }),
    ).rejects.toThrow("The upload no longer exists.");
  });
});
