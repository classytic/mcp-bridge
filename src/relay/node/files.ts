/** `fs`-backed {@link RelayFiles}: reads confined to configured folders, saves to the downloads folder. */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { base64ToBytes, bytesToBase64 } from "../../internal/encoding.js";
import type { FilePayload, SaveRequest } from "../../protocol/index.js";
import type { RelayFiles } from "../files.js";

const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".zip": "application/zip",
};

export const mediaTypeOf = (name: string): string =>
  MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

const within = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Characters no file system accepts in a name; control characters are replaced too. */
const UNSAFE_NAME = /[<>:"/\\|?*]/g;
const safeName = (name: string): string =>
  Array.from(basename(name).replace(UNSAFE_NAME, "_"), (c) =>
    c.charCodeAt(0) < 32 ? "_" : c,
  ).join("");

export function nodeFiles(opts: {
  roots: readonly string[];
  downloadsDir?: string | undefined;
  maxBytes?: number;
}): RelayFiles {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  return {
    async read(path: string): Promise<FilePayload> {
      if (!isAbsolute(path)) throw new Error(`Give an absolute path (got "${path}").`);
      if (!opts.roots.some((r) => within(r, path))) {
        throw new Error(
          `${path} is outside the folders this relay may read (${opts.roots.join(", ") || "none configured"}).`,
        );
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new Error(`${path} is not a file.`);
      if (info.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes.`);
      const name = basename(path);
      return {
        name,
        mediaType: mediaTypeOf(name),
        size: info.size,
        base64: bytesToBase64(await readFile(path)),
      };
    },
    async save(req: SaveRequest): Promise<string> {
      if (!opts.downloadsDir) throw new Error("no downloads folder configured");
      await mkdir(opts.downloadsDir, { recursive: true });
      const safe = safeName(req.name) || "download";
      const ext = extname(safe);
      const stem = safe.slice(0, safe.length - ext.length);
      for (let n = 0; ; n++) {
        const target = join(opts.downloadsDir, n ? `${stem} (${n})${ext}` : safe);
        try {
          await writeFile(target, base64ToBytes(req.base64), { flag: "wx" });
          return target;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
    },
  };
}
