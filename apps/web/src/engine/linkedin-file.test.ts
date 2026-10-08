import { describe, expect, it } from 'vitest';
import { connectionsText } from './linkedin';

const CSV =
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAna,Lopez,,,Lazard,Analyst,01 Mar 2026\n';

/** A one-entry ZIP holding `name`, stored or deflated, the way LinkedIn's export arrives. */
async function zipOf(name: string, text: string, deflate: boolean): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(text);
  const data = deflate
    ? new Uint8Array(
        await new Response(
          new Response(raw).body!.pipeThrough(new CompressionStream('deflate-raw')),
        ).arrayBuffer(),
      )
    : raw;
  const n = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + n.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, deflate ? 8 : 0, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, n.length, true);
  local.set(n, 30);
  const central = new Uint8Array(46 + n.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, deflate ? 8 : 0, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, n.length, true);
  cv.setUint32(42, 0, true);
  central.set(n, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + data.length, true);
  const out = new Uint8Array(local.length + data.length + central.length + end.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(central, local.length + data.length);
  out.set(end, local.length + data.length + central.length);
  return out;
}

const blob = (b: Uint8Array | string) => new Blob([typeof b === 'string' ? b : b.slice()]);

describe('reading the LinkedIn upload', () => {
  it('reads Connections.csv as it is', async () => {
    expect(await connectionsText(blob(CSV))).toBe(CSV);
  });
  it('takes Connections.csv out of the whole export ZIP, deflated or stored', async () => {
    expect(
      await connectionsText(blob(await zipOf('Basic_LinkedInDataExport/Connections.csv', CSV, true))),
    ).toBe(CSV);
    expect(await connectionsText(blob(await zipOf('Connections.csv', CSV, false)))).toBe(CSV);
  });
  it('says what to do with a ZIP that has no connections, instead of importing junk', async () => {
    await expect(connectionsText(blob(await zipOf('Messages.csv', 'x', false)))).rejects.toThrow(
      /no Connections\.csv/,
    );
  });
  it('refuses a binary file that is not a CSV', async () => {
    await expect(connectionsText(blob(new Uint8Array([37, 80, 68, 70, 0, 1, 2])))).rejects.toThrow(
      /not a CSV/,
    );
  });
});
