/* Small, bounded-memory reader/remuxer for the single Opus track produced by MediaRecorder.
 * No compressed packet is re-encoded. Unsupported containers fail before replacing the source.
 * Format references: matroska.org/technical/elements.html and codec_specs.html (A_OPUS).
 */
(function (global) {
  'use strict';
  const ID = {
    EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, SCALE: 0x2ad7b1,
    TRACKS: 0x1654ae6b, ENTRY: 0xae, NUMBER: 0xd7, CODEC: 0x86, PRIVATE: 0x63a2,
    DELAY: 0x56aa, PREROLL: 0x56bb, CLUSTER: 0x1f43b675, TIME: 0xe7,
    SIMPLE: 0xa3, GROUP: 0xa0, BLOCK: 0xa1, PADDING: 0x75a2
  };
  const MAX_METADATA = 1024 * 1024;
  const MAX_PACKET = 64 * 1024;

  function vint(bytes, offset, keepMarker = false) {
    const first = bytes[offset];
    if (!first) throw new Error('Invalid EBML variable integer.');
    let length = 1;
    let marker = 0x80;
    while (!(first & marker)) { marker >>= 1; length += 1; }
    if (length > (keepMarker ? 4 : 8) || offset + length > bytes.length) {
      throw new Error('Truncated EBML integer.');
    }
    let value = keepMarker ? first : first & (marker - 1);
    let unknown = !keepMarker && value === marker - 1;
    for (let i = 1; i < length; i += 1) {
      value = value * 256 + bytes[offset + i];
      unknown = unknown && bytes[offset + i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) throw new Error('EBML integer is too large.');
    return { value, length, unknown };
  }

  function unsigned(bytes) {
    let result = 0;
    for (const byte of bytes) result = result * 256 + byte;
    if (!Number.isSafeInteger(result)) throw new Error('EBML value is too large.');
    return result;
  }

  function signed(bytes) {
    let result = 0n;
    for (const byte of bytes) result = result * 256n + BigInt(byte);
    if (bytes[0] & 128) result -= 1n << BigInt(bytes.length * 8);
    const number = Number(result);
    if (!Number.isSafeInteger(number)) throw new Error('Invalid discard padding.');
    return number;
  }

  function children(bytes) {
    const result = [];
    for (let offset = 0; offset < bytes.length;) {
      const id = vint(bytes, offset, true);
      const size = vint(bytes, offset + id.length);
      const data = offset + id.length + size.length;
      const end = data + size.value;
      if (size.unknown || end > bytes.length) throw new Error('Invalid WebM metadata size.');
      result.push({ id: id.value, payload: bytes.subarray(data, end), raw: bytes.subarray(offset, end) });
      offset = end;
    }
    return result;
  }

  class Reader {
    constructor(file) { this.file = file; this.cache = new Uint8Array(); this.offset = 0; }
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > this.file.size || length > MAX_METADATA) {
        throw new Error('Invalid or oversized WebM read.');
      }
      if (offset < this.offset || offset + length > this.offset + this.cache.length) {
        this.offset = offset;
        this.cache = new Uint8Array(await this.file.slice(offset, Math.min(this.file.size, offset + Math.max(65536, length))).arrayBuffer());
      }
      return this.cache.subarray(offset - this.offset, offset - this.offset + length);
    }
    async header(offset, limit = this.file.size) {
      const bytes = await this.read(offset, Math.min(12, limit - offset));
      const id = vint(bytes, 0, true);
      const size = vint(bytes, id.length);
      const data = offset + id.length + size.length;
      const end = size.unknown ? limit : data + size.value;
      if (data > limit || end > limit) throw new Error('Truncated WebM element.');
      return { id: id.value, offset, data, end, unknown: size.unknown };
    }
    async payload(element) { return this.read(element.data, element.end - element.data); }
  }

  async function inspect(file) {
    const reader = new Reader(file);
    const ebml = await reader.header(0);
    if (ebml.id !== ID.EBML || ebml.unknown) throw new Error('Not a WebM recording.');
    const segment = await reader.header(ebml.end);
    if (segment.id !== ID.SEGMENT) throw new Error('Missing WebM segment.');
    let scale = 1000000;
    let tracks;
    let clusterOffset;
    for (let offset = segment.data; offset < segment.end;) {
      const element = await reader.header(offset, segment.end);
      if (element.id === ID.CLUSTER) { clusterOffset = offset; break; }
      if (element.unknown) throw new Error('Unsupported unknown-size WebM element.');
      if (element.id === ID.INFO) {
        const value = children(await reader.payload(element)).find((item) => item.id === ID.SCALE);
        if (value) scale = unsigned(value.payload);
      }
      if (element.id === ID.TRACKS) tracks = (await reader.payload(element)).slice();
      offset = element.end;
    }
    if (!tracks || clusterOffset === undefined || scale <= 0) throw new Error('Missing WebM audio metadata.');
    const entries = children(tracks).filter((item) => item.id === ID.ENTRY);
    if (entries.length !== 1) throw new Error('Expected one Opus audio track.');
    const fields = children(entries[0].payload);
    const field = (id) => fields.find((item) => item.id === id)?.payload;
    const codec = field(ID.CODEC);
    const privateData = field(ID.PRIVATE)?.slice();
    if (!codec || new TextDecoder().decode(codec) !== 'A_OPUS' || !privateData ||
        privateData.length < 19 || new TextDecoder().decode(privateData.subarray(0, 8)) !== 'OpusHead' ||
        ![1, 2].includes(privateData[9]) || privateData[18] !== 0) {
      throw new Error('Unsupported Opus track configuration.');
    }
    const preSkip = new DataView(privateData.buffer, privateData.byteOffset).getUint16(10, true);
    return {
      file, ebmlEnd: ebml.end, segmentEnd: segment.end, clusterOffset, scale, fields,
      track: unsigned(field(ID.NUMBER)), privateData, channels: privateData[9],
      delayNs: field(ID.DELAY) ? unsigned(field(ID.DELAY)) : Math.round(preSkip * 1e9 / 48000)
    };
  }

  function packetDurationNs(data) {
    if (!data.length) throw new Error('Empty Opus packet.');
    const config = data[0] >> 3;
    const frameMs = config >= 16 ? 2.5 * 2 ** (config & 3)
      : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3];
    const code = data[0] & 3;
    const count = code === 0 ? 1 : code === 3 ? (data[1] & 63) : 2;
    if (!count || frameMs * count > 120) throw new Error('Invalid Opus packet duration.');
    return frameMs * count * 1e6;
  }

  async function* packets(meta) {
    const reader = new Reader(meta.file);
    let nextTimestampNs;
    for (let offset = meta.clusterOffset; offset < meta.segmentEnd;) {
      const cluster = await reader.header(offset, meta.segmentEnd);
      if (cluster.id !== ID.CLUSTER) {
        if (cluster.unknown) throw new Error('Unknown-size non-cluster element.');
        offset = cluster.end;
        continue;
      }
      let time = 0;
      let position = cluster.data;
      while (position < cluster.end) {
        const element = await reader.header(position, cluster.end);
        // MediaRecorder may leave cluster sizes unknown until the next cluster.
        if (cluster.unknown && [ID.CLUSTER, 0x1c53bb6b, ID.INFO, ID.TRACKS].includes(element.id)) break;
        if (element.unknown) throw new Error('Unknown-size audio block.');
        let block = element.id === ID.SIMPLE ? element : null;
        let paddingNs = 0;
        if (element.id === ID.TIME) time = unsigned(await reader.payload(element));
        if (element.id === ID.GROUP) {
          for (let groupOffset = element.data; groupOffset < element.end;) {
            const child = await reader.header(groupOffset, element.end);
            if (child.unknown) throw new Error('Invalid block group.');
            if (child.id === ID.BLOCK) block = child;
            if (child.id === ID.PADDING) paddingNs = signed(await reader.payload(child));
            groupOffset = child.end;
          }
        }
        if (block) {
          const length = block.end - block.data;
          if (length > MAX_PACKET || length < 5) throw new Error('Invalid Opus block size.');
          const bytes = await reader.payload(block);
          const track = vint(bytes, 0);
          const headerLength = track.length + 3;
          if (track.value !== meta.track || bytes[track.length + 2] & 6) {
            throw new Error('Unsupported track or laced Opus block.');
          }
          const relative = new DataView(bytes.buffer, bytes.byteOffset).getInt16(track.length);
          const data = bytes.subarray(headerLength);
          const containerTimestampNs = (time + relative) * meta.scale;
          const durationNs = packetDurationNs(data);
          // MediaRecorder timestamps have scheduler jitter even for contiguous PCM.
          // Follow the encoded sample clock within half a packet; keep real gaps.
          const timestampNs = nextTimestampNs !== undefined &&
            Math.abs(containerTimestampNs - nextTimestampNs) <= durationNs / 2
            ? nextTimestampNs : containerTimestampNs;
          if (nextTimestampNs !== undefined && timestampNs < nextTimestampNs) {
            throw new Error('Non-monotonic Opus timestamps.');
          }
          nextTimestampNs = timestampNs + durationNs;
          yield {
            data, timestampNs, durationNs, paddingNs,
            offset: block.data + headerLength, length: data.length
          };
        }
        position = element.end;
      }
      if (position <= offset) throw new Error('Invalid cluster boundary.');
      offset = position;
    }
  }

  function integer(value, minBytes = 1) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid unsigned integer.');
    const result = [];
    do { result.unshift(value % 256); value = Math.floor(value / 256); } while (value);
    while (result.length < minBytes) result.unshift(0);
    return new Uint8Array(result);
  }
  function sizeBytes(value) {
    let length = 1;
    while (value >= 2 ** (7 * length) - 1) length += 1;
    const result = integer(value, length);
    result[0] |= 1 << (8 - length);
    return result;
  }
  function element(id, payload) {
    const blob = payload instanceof Blob ? payload : new Blob([payload]);
    return new Blob([integer(id), sizeBytes(blob.size), blob]);
  }
  function uintElement(id, value) { return element(id, integer(value)); }

  async function remux(meta, writable, startSeconds, endSeconds) {
    const startNs = Math.round(startSeconds * 1e9);
    const endNs = Math.round(endSeconds * 1e9);
    const prerollTarget = Math.max(0, startNs + meta.delayNs - 80000000);
    let firstTimestamp;
    let clusterTimestamp = 0;
    let parts = [];
    let writtenPackets = 0;
    const flush = async () => {
      if (!parts.length) return;
      await writable.write(element(ID.CLUSTER, new Blob([uintElement(ID.TIME, clusterTimestamp), ...parts])));
      parts = [];
    };
    for await (const packet of packets(meta)) {
      const packetEnd = packet.timestampNs + packet.durationNs;
      if (packetEnd <= prerollTarget) continue;
      if (packet.timestampNs - meta.delayNs >= endNs) break;
      if (firstTimestamp === undefined) {
        firstTimestamp = packet.timestampNs;
        const skipSamples = Math.round((startNs + meta.delayNs - firstTimestamp) * 48000 / 1e9);
        if (skipSamples < 0 || skipSamples > 65535) throw new Error('Invalid Opus trim preroll.');
        const privateData = meta.privateData.slice();
        new DataView(privateData.buffer).setUint16(10, skipSamples, true);
        const fields = meta.fields.filter((item) => ![ID.PRIVATE, ID.DELAY, ID.PREROLL, 0xbf].includes(item.id)).map((item) => item.raw);
        fields.push(element(ID.PRIVATE, privateData), uintElement(ID.DELAY, Math.round(skipSamples * 1e9 / 48000)), uintElement(ID.PREROLL, 80000000));
        const duration = new Uint8Array(8);
        new DataView(duration.buffer).setFloat64(0, (endNs - startNs) / meta.scale);
        const info = element(ID.INFO, new Blob([
          uintElement(ID.SCALE, meta.scale), element(0x4489, duration),
          element(0x4d80, new TextEncoder().encode('Sound FX & Recorder')),
          element(0x5741, new TextEncoder().encode('Sound FX & Recorder'))
        ]));
        await writable.write(new Blob([
          meta.file.slice(0, meta.ebmlEnd), integer(ID.SEGMENT),
          new Uint8Array([1, 255, 255, 255, 255, 255, 255, 255]),
          info, element(ID.TRACKS, element(ID.ENTRY, new Blob(fields)))
        ]));
      }
      const ticks = Math.round((packet.timestampNs - firstTimestamp) / meta.scale);
      if (parts.length && ((ticks - clusterTimestamp) * meta.scale >= 1e9 ||
          ticks - clusterTimestamp > 32767 || parts.length >= 128)) await flush();
      if (!parts.length) clusterTimestamp = ticks;
      const blockHeader = new Uint8Array(3);
      new DataView(blockHeader.buffer).setInt16(0, ticks - clusterTimestamp);
      const block = element(ID.BLOCK, new Blob([
        sizeBytes(meta.track), blockHeader, meta.file.slice(packet.offset, packet.offset + packet.length)
      ]));
      const padding = Math.max(0, packet.paddingNs, packetEnd - meta.delayNs - endNs);
      if (padding >= packet.durationNs) throw new Error('Invalid final Opus padding.');
      // Signed positive DiscardPadding requires a leading zero if its high bit is set.
      let paddingBytes = integer(padding);
      if (paddingBytes[0] & 128) paddingBytes = new Uint8Array([0, ...paddingBytes]);
      parts.push(element(ID.GROUP, new Blob(padding ? [block, element(ID.PADDING, paddingBytes)] : [block])));
      writtenPackets += 1;
    }
    await flush();
    if (!writtenPackets) throw new Error('No Opus packets remained after trimming.');
  }

  global.WebMOpus = { inspect, packets, remux };
  if (typeof module !== 'undefined') module.exports = global.WebMOpus;
})(globalThis);
