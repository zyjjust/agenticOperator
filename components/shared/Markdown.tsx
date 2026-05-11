"use client";
import React from "react";

// Tiny, dependency-free Markdown renderer. Covers exactly what our LLM
// outputs in chat replies + AI summary:
//   - ## H2 / ### H3
//   - **bold** / *italic* / `inline code`
//   - ```code block```
//   - - bullet lists / 1. ordered lists
//   - [text](url) links
//   - paragraph breaks (blank line)
//   - inline line breaks
//
// Why not react-markdown: adds ~30KB + 5 deps. Project prefers hand-rolled
// atoms (see components/shared/atoms.tsx). This handles >95% of LLM
// output we produce; if/when we need GFM tables or footnotes we can swap.

type Props = {
  children: string;
  /** Compact spacing for chat bubbles. */
  compact?: boolean;
};

type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; body: string }
  | { kind: "p"; text: string }
  | { kind: "blank" };

export function Markdown({ children, compact = false }: Props) {
  const blocks = React.useMemo(() => parseBlocks(children ?? ""), [children]);
  const headSpace = compact ? "mt-2" : "mt-3";
  const blockSpace = compact ? "my-1.5" : "my-2";
  const fontSize = compact ? 12 : 12.5;

  return (
    <div
      className="text-ink-1"
      style={{ fontSize, lineHeight: 1.55, fontFamily: "var(--f-sans)" }}
    >
      {blocks.map((b, i) => {
        if (b.kind === "blank") return null;
        if (b.kind === "h2") {
          return (
            <h2
              key={i}
              className={`${headSpace} mb-1.5 font-semibold tracking-tight`}
              style={{ fontSize: compact ? 13.5 : 14.5 }}
            >
              {renderInline(b.text)}
            </h2>
          );
        }
        if (b.kind === "h3") {
          return (
            <h3
              key={i}
              className={`${headSpace} mb-1 font-semibold tracking-tight`}
              style={{ fontSize: compact ? 12.5 : 13 }}
            >
              {renderInline(b.text)}
            </h3>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul
              key={i}
              className={`${blockSpace} pl-5`}
              style={{ listStyle: "disc" }}
            >
              {b.items.map((it, j) => (
                <li key={j} className="my-0.5">
                  {renderInline(it)}
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol
              key={i}
              className={`${blockSpace} pl-5`}
              style={{ listStyle: "decimal" }}
            >
              {b.items.map((it, j) => (
                <li key={j} className="my-0.5">
                  {renderInline(it)}
                </li>
              ))}
            </ol>
          );
        }
        if (b.kind === "code") {
          return (
            <pre
              key={i}
              className={`mono ${blockSpace} overflow-auto rounded-sm border border-line bg-panel`}
              style={{
                padding: compact ? "8px 10px" : "10px 12px",
                fontSize: compact ? 10.5 : 11,
                lineHeight: 1.5,
              }}
            >
              <code>{b.body}</code>
            </pre>
          );
        }
        // paragraph
        return (
          <p key={i} className={blockSpace}>
            {renderInline(b.text)}
          </p>
        );
      })}
    </div>
  );
}

// ── Block parser ─────────────────────────────────────────────────────

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push({ kind: "code", lang, body: buf.join("\n") });
      continue;
    }

    // Headings
    if (line.startsWith("## ")) {
      out.push({ kind: "h2", text: line.slice(3).trim() });
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      out.push({ kind: "h3", text: line.slice(4).trim() });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      // Treat single # as h2 too — LLM rarely uses h1 meaningfully.
      out.push({ kind: "h2", text: line.slice(2).trim() });
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", items });
      continue;
    }

    // Blank line — paragraph separator
    if (line.trim() === "") {
      out.push({ kind: "blank" });
      i++;
      continue;
    }

    // Paragraph — accumulate consecutive non-blank, non-special lines
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("#") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ kind: "p", text: buf.join(" ") });
  }
  return out;
}

// ── Inline parser ────────────────────────────────────────────────────
//
// Tokenizes inline runs of: `code`, **bold**, *italic*, [text](url).
// Everything else is text. Order matters: code first (so ** inside `code`
// stays literal), then bold (** before *), then italic, then links.

type Inline =
  | { kind: "text"; v: string }
  | { kind: "code"; v: string }
  | { kind: "bold"; v: Inline[] }
  | { kind: "italic"; v: Inline[] }
  | { kind: "link"; v: string; href: string };

function renderInline(s: string): React.ReactNode {
  const tokens = parseInline(s);
  return tokens.map((t, i) => renderToken(t, i));
}

function renderToken(t: Inline, key: React.Key): React.ReactNode {
  if (t.kind === "text") return <React.Fragment key={key}>{t.v}</React.Fragment>;
  if (t.kind === "code") {
    return (
      <code
        key={key}
        className="mono"
        style={{
          padding: "0 4px",
          margin: "0 1px",
          background: "var(--c-panel)",
          border: "1px solid var(--c-line)",
          borderRadius: 3,
          fontSize: "0.92em",
        }}
      >
        {t.v}
      </code>
    );
  }
  if (t.kind === "bold") {
    return (
      <strong key={key} style={{ fontWeight: 600, color: "var(--c-ink-1)" }}>
        {t.v.map((c, i) => renderToken(c, i))}
      </strong>
    );
  }
  if (t.kind === "italic") {
    return (
      <em key={key} style={{ fontStyle: "italic" }}>
        {t.v.map((c, i) => renderToken(c, i))}
      </em>
    );
  }
  if (t.kind === "link") {
    return (
      <a
        key={key}
        href={t.href}
        target={t.href.startsWith("http") ? "_blank" : undefined}
        rel="noreferrer"
        className="underline hover:text-ink-1"
        style={{ color: "var(--c-accent)" }}
      >
        {t.v}
      </a>
    );
  }
  return null;
}

function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ kind: "text", v: buf });
      buf = "";
    }
  };
  while (i < s.length) {
    const ch = s[i];
    // Inline code
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Bold (**)
    if (ch === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i) {
        flush();
        out.push({ kind: "bold", v: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // Italic (*)
    if (ch === "*") {
      const end = s.indexOf("*", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "italic", v: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    // Link [text](href)
    if (ch === "[") {
      const close = s.indexOf("]", i + 1);
      if (close > i && s[close + 1] === "(") {
        const hrefEnd = s.indexOf(")", close + 2);
        if (hrefEnd > close) {
          flush();
          out.push({
            kind: "link",
            v: s.slice(i + 1, close),
            href: s.slice(close + 2, hrefEnd),
          });
          i = hrefEnd + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
