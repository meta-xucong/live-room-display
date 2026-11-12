import { inflateRawSync } from "node:zlib";

const MAX_ENTRIES = 600;
const MAX_UNCOMPRESSED = 80 * 1024 * 1024;

function decodeXml(text) {
  return text
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(fragment) {
  return [...fragment.matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1]] = decodeXml(match[3]);
  }
  return result;
}

function readZip(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("文件不是有效的 .xlsx 工作簿");
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || centralOffset >= buffer.length) throw new Error("工作簿结构超出允许范围");

  const files = new Map();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("工作簿压缩包目录损坏");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) throw new Error("不支持加密工作簿");
    if (![0, 8].includes(method)) throw new Error("工作簿使用了不支持的压缩方式");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("工作簿包含无效路径");
    totalSize += uncompressedSize;
    if (totalSize > MAX_UNCOMPRESSED) throw new Error("工作簿展开后过大，请压缩图片或拆分文件");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("工作簿文件条目损坏");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    try {
      content = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED });
    } catch {
      throw new Error("工作簿压缩内容无法读取");
    }
    if (content.length !== uncompressedSize) throw new Error("工作簿文件条目大小不匹配");
    files.set(name, content);
  }
  return files;
}

function readXml(files, name) {
  const buffer = files.get(name);
  if (!buffer) return "";
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("工作簿 XML 包含不支持的声明");
  return text;
}

function relationshipMap(xml) {
  const map = new Map();
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)) {
    const attr = attributes(match[1]);
    if (attr.Id && attr.Target && attr.TargetMode !== "External") map.set(attr.Id, attr.Target);
  }
  return map;
}

function resolveTarget(source, target) {
  const parts = (target.startsWith("/") ? target.slice(1) : `${source.slice(0, source.lastIndexOf("/") + 1)}${target}`).split("/");
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si\s*>/g)]
    .map((match) => xmlText(match[1]));
}

function parseSheet(xml, sharedStrings) {
  const rows = new Map();
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>)/g)) {
    const attr = attributes(match[1]);
    if (!attr.r) continue;
    const cell = attr.r.match(/^([A-Z]+)(\d+)$/i);
    if (!cell) continue;
    const column = cell[1].toUpperCase();
    const rowNumber = Number(cell[2]);
    const body = match[2] ?? "";
    const valueMatch = body.match(/<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v\s*>/);
    const formula = /<(?:[\w.-]+:)?f\b/.test(body);
    let value = valueMatch ? decodeXml(valueMatch[1]) : "";
    if (attr.t === "s" && value !== "") value = sharedStrings[Number(value)] ?? "";
    else if (attr.t === "inlineStr") value = xmlText(body);
    else if (["str", "b", "e"].includes(attr.t) && value !== "") value = decodeXml(value);
    if (!rows.has(rowNumber)) rows.set(rowNumber, new Map());
    rows.get(rowNumber).set(column, { value, formula, type: attr.t ?? "n" });
  }
  return rows;
}

function parseDrawings(files, sheetPath, sheetXml) {
  const relsPath = `${sheetPath.slice(0, sheetPath.lastIndexOf("/") + 1)}_rels/${sheetPath.split("/").at(-1)}.rels`;
  const sheetRels = relationshipMap(readXml(files, relsPath));
  const drawingId = [...sheetXml.matchAll(/<(?:[\w.-]+:)?drawing\b([^>]*?)\/?\s*>/g)]
    .map((match) => attributes(match[1])["r:id"])
    .find(Boolean);
  if (!drawingId) return new Map();
  const drawingPath = resolveTarget(sheetPath, sheetRels.get(drawingId) ?? "");
  const drawingXml = readXml(files, drawingPath);
  if (!drawingXml) return new Map();
  const drawingRelsPath = `${drawingPath.slice(0, drawingPath.lastIndexOf("/") + 1)}_rels/${drawingPath.split("/").at(-1)}.rels`;
  const drawingRels = relationshipMap(readXml(files, drawingRelsPath));
  const images = new Map();
  const anchors = /<(?:[\w.-]+:)?(?:oneCellAnchor|twoCellAnchor)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:oneCellAnchor|twoCellAnchor)\s*>/g;
  for (const anchorMatch of drawingXml.matchAll(anchors)) {
    const anchor = anchorMatch[1];
    const from = anchor.match(/<(?:[\w.-]+:)?from\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?from\s*>/);
    const rowMatch = from?.[1].match(/<(?:[\w.-]+:)?row\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?row\s*>/);
    const colMatch = from?.[1].match(/<(?:[\w.-]+:)?col\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?col\s*>/);
    const embed = anchor.match(/<(?:[\w.-]+:)?blip\b[^>]*\br:embed\s*=\s*(["'])(.*?)\1/);
    if (!rowMatch || !colMatch || !embed) continue;
    const rowNumber = Number(rowMatch[1]) + 1;
    const columnNumber = Number(colMatch[1]);
    const mediaPath = resolveTarget(drawingPath, drawingRels.get(embed[2]) ?? "");
    const bytes = files.get(mediaPath);
    if (!bytes) throw new Error(`无法读取主播照片（第 ${rowNumber} 行）`);
    const contentType = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      ? "image/jpeg"
      : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? "image/png"
        : "";
    if (!contentType) throw new Error(`主播照片格式不支持（第 ${rowNumber} 行），请使用 JPG 或 PNG`);
    if (bytes.length > 8 * 1024 * 1024) throw new Error(`主播照片过大（第 ${rowNumber} 行），单张不能超过 8 MB`);
    if (!images.has(rowNumber)) images.set(rowNumber, []);
    images.get(rowNumber).push({ columnNumber, contentType, bytes });
  }
  return images;
}

export function parseXlsx(buffer) {
  const files = readZip(buffer);
  for (const name of files.keys()) {
    if (/vbaProject|externalLinks|embeddings\//i.test(name)) throw new Error("不支持含宏、外部链接或嵌入文件的工作簿");
    if (/\.rels$/i.test(name) && /TargetMode\s*=\s*["']External["']/i.test(readXml(files, name))) {
      throw new Error("不支持包含外部链接的工作簿");
    }
  }
  const workbook = readXml(files, "xl/workbook.xml");
  const workbookRels = relationshipMap(readXml(files, "xl/_rels/workbook.xml.rels"));
  const sharedStrings = parseSharedStrings(readXml(files, "xl/sharedStrings.xml"));
  const sheets = [];
  for (const match of workbook.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*?)\/?\s*>/g)) {
    const attr = attributes(match[1]);
    const path = workbookRels.has(attr["r:id"])
      ? resolveTarget("xl/workbook.xml", workbookRels.get(attr["r:id"]))
      : "";
    if (!attr.name || !path) continue;
    const xml = readXml(files, path);
    if (!xml) throw new Error(`无法读取工作表“${attr.name}”`);
    let images;
    try {
      images = parseDrawings(files, path, xml);
    } catch (cause) {
      throw new Error(`工作表“${attr.name}”：${cause.message}`);
    }
    sheets.push({ name: attr.name, rows: parseSheet(xml, sharedStrings), images });
  }
  return sheets;
}

export function cellValue(sheet, row, column) {
  return sheet.rows.get(row)?.get(column)?.value ?? "";
}

export function cellHasFormula(sheet, row, column) {
  return Boolean(sheet.rows.get(row)?.get(column)?.formula);
}
