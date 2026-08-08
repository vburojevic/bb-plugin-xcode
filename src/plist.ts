/**
 * Minimal XML property list reader.
 *
 * `LogStoreManifest.plist` is written as an XML plist (verified on Xcode 26.6),
 * so parsing it in pure JS avoids shelling out to `plutil` — which in turn lets
 * the same code read manifests on remote hosts through `bb.sdk.files`.
 *
 * Deliberately not a general plist implementation: it covers the value types
 * Xcode actually emits in these manifests.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue };

interface Cursor {
  xml: string;
  index: number;
}

/** Parse an XML plist document into plain JS values. Throws on malformed input. */
export function parsePlist(xml: string): PlistValue | null {
  const cursor: Cursor = { xml, index: 0 };
  const root = skipToElement(cursor, "plist");
  if (!root) return null;
  const value = readValue(cursor);
  return value;
}

/** Advance the cursor past the opening tag of `name`; false if not found. */
function skipToElement(cursor: Cursor, name: string): boolean {
  const open = cursor.xml.indexOf(`<${name}`, cursor.index);
  if (open === -1) return false;
  const close = cursor.xml.indexOf(">", open);
  if (close === -1) return false;
  cursor.index = close + 1;
  return true;
}

interface Tag {
  name: string;
  selfClosing: boolean;
}

/** Read the next tag, skipping text, comments, declarations and doctypes. */
function nextTag(cursor: Cursor): Tag | null {
  while (cursor.index < cursor.xml.length) {
    const open = cursor.xml.indexOf("<", cursor.index);
    if (open === -1) return null;

    if (cursor.xml.startsWith("<!--", open)) {
      const end = cursor.xml.indexOf("-->", open);
      cursor.index = end === -1 ? cursor.xml.length : end + 3;
      continue;
    }
    if (cursor.xml.startsWith("<?", open) || cursor.xml.startsWith("<!", open)) {
      const end = cursor.xml.indexOf(">", open);
      cursor.index = end === -1 ? cursor.xml.length : end + 1;
      continue;
    }

    const close = cursor.xml.indexOf(">", open);
    if (close === -1) return null;
    const raw = cursor.xml.slice(open + 1, close).trim();
    cursor.index = close + 1;
    const selfClosing = raw.endsWith("/");
    const name = (selfClosing ? raw.slice(0, -1) : raw).split(/\s/)[0] ?? "";
    return { name, selfClosing };
  }
  return null;
}

/** Text content up to the matching `</name>`, with entities decoded. */
function readText(cursor: Cursor, name: string): string {
  const end = cursor.xml.indexOf(`</${name}>`, cursor.index);
  if (end === -1) {
    const rest = cursor.xml.slice(cursor.index);
    cursor.index = cursor.xml.length;
    return decodeEntities(rest);
  }
  const text = cursor.xml.slice(cursor.index, end);
  cursor.index = end + name.length + 3;
  return decodeEntities(text);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

function readValue(cursor: Cursor): PlistValue | null {
  const tag = nextTag(cursor);
  if (!tag) return null;
  return readValueForTag(cursor, tag);
}

function readValueForTag(cursor: Cursor, tag: Tag): PlistValue | null {
  switch (tag.name) {
    case "dict": {
      const dict: { [key: string]: PlistValue } = {};
      if (tag.selfClosing) return dict;
      for (;;) {
        const next = nextTag(cursor);
        if (!next || next.name === "/dict") return dict;
        if (next.name !== "key") continue;
        const key = readText(cursor, "key");
        const valueTag = nextTag(cursor);
        if (!valueTag) return dict;
        const value = readValueForTag(cursor, valueTag);
        if (value !== null) dict[key] = value;
      }
    }
    case "array": {
      const array: PlistValue[] = [];
      if (tag.selfClosing) return array;
      for (;;) {
        const next = nextTag(cursor);
        if (!next || next.name === "/array") return array;
        const value = readValueForTag(cursor, next);
        if (value !== null) array.push(value);
      }
    }
    case "string":
      return tag.selfClosing ? "" : readText(cursor, "string");
    case "integer":
      return tag.selfClosing ? 0 : Number(readText(cursor, "integer").trim());
    case "real":
      return tag.selfClosing ? 0 : Number(readText(cursor, "real").trim());
    case "true":
      return true;
    case "false":
      return false;
    case "date":
      return tag.selfClosing ? new Date(0) : new Date(readText(cursor, "date"));
    case "data":
      return tag.selfClosing ? "" : readText(cursor, "data").replace(/\s+/g, "");
    default:
      return null;
  }
}

export function isRecord(
  value: PlistValue | null | undefined,
): value is { [key: string]: PlistValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}
