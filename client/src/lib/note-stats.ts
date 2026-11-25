import { headingSlug } from "./heading-slug";

export interface HeadingOutlineItem {
  level: number;
  text: string;
  slug: string;
}

function replaceMarkdownLinks(
  text: string,
  options: { images: boolean; replacementSuffix?: string; allowEmptyLabel?: boolean }
): string {
  const needle = options.images ? "![" : "[";
  const allowEmpty = options.allowEmptyLabel ?? options.images;
  const suffix = options.replacementSuffix ?? "";
  let out = "";
  let lastCopied = 0;
  let nextCloseBracket = -1;
  let pos = 0;

  while (pos < text.length) {
    const open = text.indexOf(needle, pos);
    if (open === -1) break;
    const labelStart = open + needle.length;
    if (nextCloseBracket < labelStart) {
      nextCloseBracket = text.indexOf("]", labelStart);
      if (nextCloseBracket === -1) break;
    }
    if ((allowEmpty || nextCloseBracket > labelStart) && text[nextCloseBracket + 1] === "(") {
      const closeParen = text.indexOf(")", nextCloseBracket + 2);
      if (closeParen === -1) break;
      out += text.slice(lastCopied, open);
      out += text.slice(labelStart, nextCloseBracket);
      out += suffix;
      lastCopied = closeParen + 1;
      pos = lastCopied;
    } else {
      pos = labelStart;
    }
  }

  return lastCopied === 0 ? text : out + text.slice(lastCopied);
}

function stripTrailingAtxHashes(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  let hashStart = end;
  while (hashStart > 0 && text[hashStart - 1] === "#") hashStart--;
  if (hashStart < end && hashStart > 0 && /\s/.test(text[hashStart - 1])) {
    while (hashStart > 0 && /\s/.test(text[hashStart - 1])) hashStart--;
    return text.slice(0, hashStart);
  }
  return text.slice(0, end);
}

function cleanHeadingInlineMarkdown(raw: string): string {
  let text = raw;
  if (text.includes("[")) {
    if (text.includes("![")) text = replaceMarkdownLinks(text, { images: true, allowEmptyLabel: true });
    text = replaceMarkdownLinks(text, { images: false, allowEmptyLabel: false });
  }
  text = text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|==|\+\+|\^|~)/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!~^])/g, "$1");
  return stripTrailingAtxHashes(text).trim();
}

/**
 * Extracts ATX headings outside fenced code blocks with unique Joplin-compatible anchor slugs.
 */
export function extractHeadings(markdown: string): HeadingOutlineItem[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const items: HeadingOutlineItem[] = [];
  const counts = new Map<string, number>();
  let fence: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;

    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const text = cleanHeadingInlineMarkdown(match[2]);
    if (!text) continue;
    const base = headingSlug(text) || "heading";
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    const slug = seen === 0 ? base : `${base}-${seen}`;
    items.push({ level: match[1].length, text, slug });
  }
  return items;
}

/** Computes word count, character count and estimated reading time in minutes. */
export function computeNoteStats(text: string, isHtml = false): {
  words: number;
  characters: number;
  readingMinutes: number;
} {
  let plain: string;
  if (isHtml) {
    plain = text.replace(/<[^<>]+>/g, " ").replace(/&[a-z0-9#]+;/gi, " ");
  } else {
    plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
    if (plain.includes("[")) {
      if (plain.includes("![")) {
        plain = replaceMarkdownLinks(plain, { images: true, replacementSuffix: " ", allowEmptyLabel: true });
      }
      plain = replaceMarkdownLinks(plain, { images: false, replacementSuffix: " ", allowEmptyLabel: true });
    }
    plain = plain.replace(/[#>*_~=`[\]()-]/g, " ");
  }
  const normalized = plain.trim();
  const words = normalized ? normalized.split(/\s+/).length : 0;
  const characters = normalized.replace(/\s+/g, "").length;
  const readingMinutes = words > 0 ? Math.max(1, Math.ceil(words / 225)) : 0;
  return { words, characters, readingMinutes };
}

/** Converts Joplin :/id image & item links to web URLs before TipTap WYSIWYG editing. */
export function joplinToRichMarkdown(markdown: string): string {
  if (!markdown || !markdown.includes(":")) return markdown || "";
  let out = markdown.replace(
    /!\[([^[\]]*)\]\(:\/?([0-9a-fA-F]{32})(\s+"[^"]*")?\)/g,
    (_, alt, id, title = "") => `![${alt}](/api/resources/${id.toLowerCase()}${title})`
  );
  out = out.replace(
    /(^|[^!])\[([^[\]]*)\]\(:\/?([0-9a-fA-F]{32})(#[^\s()"'<>]*)?(\s+"[^"]*")?\)/g,
    (_, before, text, id, fragment = "", title = "") =>
      `${before}[${text}](/joplin-item/${id.toLowerCase()}${fragment}${title})`
  );
  return out;
}

/** Converts /api/resources/<id> and /joplin-item/<id> back to Joplin :/id after TipTap editing. */
export function richMarkdownToJoplin(markdown: string): string {
  if (!markdown) return "";
  let out = markdown.replace(
    /!\[([^[\]]*)\]\((?:https?:\/\/[^/\s)]+)?\/api\/resources\/([0-9a-fA-F]{32})(\s+"[^"]*")?\)/g,
    (_, alt, id, title = "") => `![${alt}](:/${id.toLowerCase()}${title})`
  );
  out = out.replace(
    /(^|[^!])\[([^[\]]*)\]\((?:https?:\/\/[^/\s)]+)?\/joplin-item\/([0-9a-fA-F]{32})(#[^\s()"'<>]*)?(\s+"[^"]*")?\)/g,
    (_, before, text, id, fragment = "", title = "") =>
      `${before}[${text}](:/${id.toLowerCase()}${fragment}${title})`
  );
  return out;
}

/** Converts Joplin :/id img & link tags in HTML notes to web URLs before TipTap WYSIWYG editing. */
export function joplinToRichHtml(html: string): string {
  if (!html || !html.includes(":")) return html || "";
  let out = html.replace(/<img\b[^<>]*>/gi, (tag) =>
    tag.replace(/\ssrc=(["']):\/?([0-9a-fA-F]{32})\1/i, (_, _quote, id) => ` src="/api/resources/${id.toLowerCase()}"`)
  );
  out = out.replace(/<a\b[^<>]*>/gi, (tag) =>
    tag.replace(
      /\shref=(["']):\/?([0-9a-fA-F]{32})(#[^"'<>\s]*)?\1/i,
      (_, _quote, id, fragment = "") => ` href="/joplin-item/${id.toLowerCase()}${fragment}"`
    )
  );
  return out;
}

/** Converts /api/resources/<id> and /joplin-item/<id> HTML attributes back to Joplin :/id after TipTap editing. */
export function richHtmlToJoplin(html: string): string {
  if (!html) return "";
  let out = html.replace(/<img\b[^<>]*>/gi, (tag) =>
    tag.replace(
      /\ssrc=(["'])(?:https?:\/\/[^/"']+)?\/api\/resources\/([0-9a-fA-F]{32})\1/i,
      (_, quote, id) => ` src=${quote}:/${id.toLowerCase()}${quote}`
    )
  );
  out = out.replace(/<a\b[^<>]*>/gi, (tag) =>
    tag.replace(
      /\shref=(["'])(?:https?:\/\/[^/"']+)?\/joplin-item\/([0-9a-fA-F]{32})(#[^"'<>\s]*)?\1/i,
      (_, quote, id, fragment = "") => ` href=${quote}:/${id.toLowerCase()}${fragment}${quote}`
    )
  );
  return out;
}
