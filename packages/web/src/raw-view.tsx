// Raw source view (debug): the session's on-disk file, monospace + line-numbered,
// fetched lazily in ~1MB line-aligned chunks (see readRawSource in @trove/core).
// Clicking a JSON line pretty-prints it inline — the point of the whole view: a
// flat .jsonl record is unreadable otherwise.

import { memo, useEffect, useMemo, useState } from "react";
import { Archive } from "lucide-react";
import { trpc } from "./trpc.ts";
import { fmtSize, splitRawLines, looksJson, prettyJsonLine } from "./lib.ts";

interface Meta {
  totalBytes: number;
  sourcePath: string;
  fromArchive: boolean;
}

const RawLine = memo(function RawLine({
  n,
  line,
  open,
  onToggle,
}: {
  n: number;
  line: string;
  open: boolean;
  onToggle(n: number): void;
}) {
  // Parse only when toggled open — not per render for every line.
  const pretty = open ? prettyJsonLine(line) : null;
  const jsonish = looksJson(line);
  return (
    <div className={`raw-line${jsonish ? " json" : ""}${pretty ? " open" : ""}`}>
      <span className="ln">{n}</span>
      <span
        className="lc"
        title={jsonish ? "click to toggle pretty-printed JSON" : undefined}
        onClick={jsonish ? () => onToggle(n) : undefined}
      >
        {pretty ?? line}
      </span>
    </div>
  );
});

export function RawView({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const load = async (offset: number) => {
    setState("loading");
    try {
      const r = await trpc.rawSource.query({ id, offset });
      if (!r || !r.available) {
        if (r) setMeta({ totalBytes: 0, sourcePath: r.sourcePath, fromArchive: false });
        setState("unavailable");
        return;
      }
      // offset 0 REPLACES (idempotent under StrictMode's double effect); later
      // offsets append — the server cuts chunks at line boundaries, so plain
      // concatenation never splits a line.
      setText((prev) => (offset === 0 ? r.text : prev + r.text));
      setNextOffset(r.nextOffset);
      setMeta({ totalBytes: r.totalBytes, sourcePath: r.sourcePath, fromArchive: r.fromArchive });
      setState("ready");
    } catch {
      setState("error");
    }
  };
  useEffect(() => {
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const lines = useMemo(() => splitRawLines(text), [text]);
  const toggle = (n: number) => {
    // Only toggle lines that actually parse — a `{oops` line shows the affordance
    // (cheap looksJson check) but stays inert here.
    if (prettyJsonLine(lines[n - 1]) == null) return;
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  };

  if (state === "unavailable")
    return (
      <div className="raw-view">
        <p className="raw-empty">
          Source file is gone and no archived copy exists.
          {meta?.sourcePath && <span className="raw-path">{meta.sourcePath}</span>}
        </p>
      </div>
    );
  if (state === "error")
    return (
      <div className="raw-view">
        <p className="raw-empty">Couldn’t read the source file.</p>
      </div>
    );

  return (
    <div className="raw-view">
      <div className="raw-head">
        {meta ? (
          <>
            <span className="raw-path" title={meta.sourcePath}>
              {meta.sourcePath}
            </span>
            <span className="raw-size">{fmtSize(meta.totalBytes)}</span>
            {meta.fromArchive && (
              <span className="raw-archived" title="the live file is gone — showing trove's gzipped archive copy">
                <Archive size={11} /> archived copy
              </span>
            )}
          </>
        ) : (
          <span className="raw-size">loading…</span>
        )}
      </div>
      <div className="raw-body">
        <div className="raw-lines">
          {lines.map((ln, i) => (
            <RawLine key={i} n={i + 1} line={ln} open={open.has(i + 1)} onToggle={toggle} />
          ))}
        </div>
      </div>
      {nextOffset != null && (
        <button className="raw-more" disabled={state === "loading"} onClick={() => load(nextOffset)}>
          {state === "loading"
            ? "loading…"
            : `load more (${fmtSize(nextOffset)} of ${fmtSize(meta?.totalBytes)})`}
        </button>
      )}
    </div>
  );
}
