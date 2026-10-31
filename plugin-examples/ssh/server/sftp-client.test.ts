import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SftpClient, SftpStatusError } from "./sftp-client";
import { SftpProtocolError } from "./sftp-wire";

// Raw SFTP v3 bytes, written from the draft's layout rather than with the code under test.
const STATUS = 101;
const DATA = 103;
const NAME = 104;
const ATTRS = 105;

const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};
const str = (value: string | Buffer) => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([u32(bytes.length), bytes]);
};
const frame = (type: number, ...fields: Buffer[]) => {
  const body = Buffer.concat([Buffer.from([type]), ...fields]);
  return Buffer.concat([u32(body.length), body]);
};
const NO_ATTRS = u32(0);

/** A client wired to in-memory streams. `serve` reads what the client sent, `reply` answers it. */
function connect() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const client = new SftpClient(toServer, fromServer);
  let pending = Buffer.alloc(0);
  const requests: { type: number; id: number }[] = [];
  toServer.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);
      const body = pending.subarray(4, 4 + length);
      requests.push({ type: body[0], id: body.length >= 5 ? body.readUInt32BE(1) : 0 });
      pending = pending.subarray(4 + length);
    }
  });
  const reply = (bytes: Buffer) => fromServer.write(bytes);
  const lastRequestId = async () => {
    for (let attempt = 0; attempt < 100 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return requests.at(-1)!.id;
  };
  return { client, reply, lastRequestId, requests };
}

const settles = (promise: Promise<unknown>, ms = 40) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe("SftpClient against hostile or broken servers", () => {
  it("fails the pending request when a frame announces more than the size limit", async () => {
    const { client, reply } = connect();
    const request = client.stat("/x");
    reply(u32(0x7fffffff));
    await expect(request).rejects.toBeInstanceOf(SftpProtocolError);
    await expect(request).rejects.toThrow(/out of range/);
  });

  it("fails the pending request on a zero-length frame", async () => {
    const { client, reply } = connect();
    const request = client.stat("/x");
    reply(u32(0));
    await expect(request).rejects.toThrow(/out of range/);
  });

  it("fails every later request after the first protocol error", async () => {
    const { client, reply } = connect();
    const first = client.stat("/x");
    reply(u32(0x7fffffff));
    await expect(first).rejects.toThrow();
    await expect(client.stat("/y")).rejects.toThrow(/out of range/);
  });

  it("rejects a status packet cut off before its id and code", async () => {
    const { client, reply } = connect();
    const request = client.stat("/x");
    // type STATUS followed by only two bytes: the 4-byte request id is incomplete
    reply(Buffer.concat([u32(3), Buffer.from([STATUS, 0, 0])]));
    await expect(request).rejects.toThrow(/Truncated/);
  });

  it("rejects a NAME reply whose entry count is larger than the packet holds", async () => {
    const { client, reply, lastRequestId } = connect();
    const request = client.realpath("/x");
    const id = await lastRequestId();
    reply(frame(NAME, u32(id), u32(0xffffffff), str("/x"), str("longname"), NO_ATTRS));
    await expect(request).rejects.toThrow(/Truncated/);
  });

  it("rejects attributes that announce more extended pairs than the packet holds", async () => {
    const { client, reply, lastRequestId } = connect();
    const request = client.stat("/x");
    const id = await lastRequestId();
    reply(frame(ATTRS, u32(id), u32(0x80000000), u32(0xffffffff)));
    await expect(request).rejects.toThrow(/Truncated/);
  });

  it("ignores a reply with another request's id and keeps waiting for the right one", async () => {
    const { client, reply, lastRequestId } = connect();
    const request = client.stat("/x");
    const id = await lastRequestId();
    reply(frame(ATTRS, u32(id + 1000), NO_ATTRS));
    expect(await settles(request)).toBe(false);
    reply(frame(ATTRS, u32(id), NO_ATTRS));
    await expect(request).resolves.toEqual({});
  });

  it("ignores a duplicate reply and still answers the next request correctly", async () => {
    const { client, reply, lastRequestId, requests } = connect();
    const first = client.stat("/a");
    const firstId = await lastRequestId();
    reply(frame(ATTRS, u32(firstId), NO_ATTRS));
    reply(frame(ATTRS, u32(firstId), NO_ATTRS));
    await expect(first).resolves.toEqual({});
    const second = client.stat("/b");
    for (let attempt = 0; attempt < 100 && requests.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const secondId = requests[1].id;
    expect(secondId).not.toBe(firstId);
    expect(await settles(second)).toBe(false);
    reply(frame(STATUS, u32(secondId), u32(2), str("No such file"), str("")));
    await expect(second).rejects.toBeInstanceOf(SftpStatusError);
  });

  it("rejects a DATA reply longer than the bytes asked for", async () => {
    const { client, reply, lastRequestId } = connect();
    const request = client.read(Buffer.from("h"), 0, 4);
    const id = await lastRequestId();
    reply(frame(DATA, u32(id), str("12345")));
    await expect(request).rejects.toThrow(/more data than asked/);
  });

  it("rejects an empty DATA reply instead of letting a copy loop spin", async () => {
    const { client, reply, lastRequestId } = connect();
    const request = client.read(Buffer.from("h"), 0, 4);
    const id = await lastRequestId();
    reply(frame(DATA, u32(id), str("")));
    await expect(request).rejects.toThrow(/empty DATA/);
  });

  it("returns null for the end-of-file status and the bytes for a good DATA reply", async () => {
    const { client, reply, lastRequestId } = connect();
    const eof = client.read(Buffer.from("h"), 0, 4);
    reply(frame(STATUS, u32(await lastRequestId()), u32(1), str("EOF"), str("")));
    await expect(eof).resolves.toBeNull();
    const data = client.read(Buffer.from("h"), 4, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id = await lastRequestId();
    reply(frame(DATA, u32(id), str("abcd")));
    await expect(data).resolves.toEqual(Buffer.from("abcd"));
  });
});
