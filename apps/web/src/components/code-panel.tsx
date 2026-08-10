import type { ReactNode } from "react";

// Read-only C rendering, deliberately not an editor.
//
// This used to mount Monaco, which fetches its assets from a CDN unless it is
// configured otherwise. The site sends script-src 'self', so those requests were
// refused and the panel sat on "Loading..." forever. Self-hosting Monaco would mean
// shipping megabytes of assets and loosening the policy for its eval and blob
// workers, all to display a struct nobody can edit.
//
// Tokens become React elements rather than an HTML string, so type names out of the
// archive cannot inject markup and no dangerouslySetInnerHTML is involved.

const keywords = new Set([
  "struct", "union", "enum", "typedef", "const", "volatile", "static", "extern",
  "unsigned", "signed", "void", "char", "short", "int", "long", "float", "double",
  "_Bool", "sizeof", "return", "if", "else", "for", "while", "switch", "case",
]);

// Windows kernel headers lean on these, and colouring them apart from user types
// makes a layout easier to scan.
const primitives = /^(U?INT(8|16|32|64)?|BYTE|WORD|DWORD|QWORD|BOOLEAN|UCHAR|USHORT|ULONG|ULONGLONG|LONG|SHORT|CHAR|PVOID|HANDLE|NTSTATUS|SIZE_T|W?CHAR)$/;

function token_class(token: string) {
  if (token.startsWith("//") || token.startsWith("/*")) { return "text-zinc-500 italic"; }
  if (token.startsWith("\"") || token.startsWith("'")) { return "text-amber-200/90"; }
  if (/^0[xX][0-9a-fA-F]+$/.test(token) || /^\d+$/.test(token)) { return "text-orange-300/90"; }
  if (keywords.has(token)) { return "text-cyan-300"; }
  if (primitives.test(token)) { return "text-teal-200"; }
  if (/^[A-Z_][A-Z0-9_]*$/.test(token) && token.length > 2) { return "text-violet-200/90"; }
  return "";
}

// Split into comments, strings, words, numbers and everything else. Keeping the
// separators in the output means the line reassembles exactly as it came in.
const token_pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*|0[xX][0-9a-fA-F]+|\d+)/g;

function highlight(line: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let match: RegExpExecArray | null;
  token_pattern.lastIndex = 0;
  while ((match = token_pattern.exec(line)) !== null) {
    if (match.index > index) { nodes.push(line.slice(index, match.index)); }
    const value = match[0];
    const classes = token_class(value);
    nodes.push(classes ? <span className={classes} key={`${match.index}-${value}`}>{value}</span> : value);
    index = match.index + value.length;
  }
  if (index < line.length) { nodes.push(line.slice(index)); }
  return nodes;
}

export function CodePanel({ code }: { code: string }) {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const gutter_width = `${String(lines.length).length + 1}ch`;

  return (
    <div className="ka-scroll min-w-0 max-h-[360px] overflow-auto rounded-md border border-white/10 bg-black/35">
      <pre className="min-w-0 p-3 font-mono text-[13px] leading-[1.55] text-zinc-200">
        <code>
          {lines.map((line, number) => (
            <div className="flex" key={number}>
              <span
                aria-hidden="true"
                className="shrink-0 select-none pr-4 text-right text-zinc-600"
                style={{ width: gutter_width }}
              >
                {number + 1}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-words">{highlight(line)}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
