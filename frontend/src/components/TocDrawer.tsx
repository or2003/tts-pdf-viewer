import { useMemo, useState } from "react";
import type { Sentence } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  sentences: Sentence[];
  currentIndex: number;
  onSeekSentence: (index: number) => void;
  onSeekPage: (pageIndex: number) => void;
}

interface PageGroup {
  pageIndex: number;
  firstSentenceIndex: number;
  preview: string[];
  totalCount: number;
}

function groupByPage(sentences: Sentence[]): PageGroup[] {
  const groups: PageGroup[] = [];
  let current: PageGroup | null = null;
  sentences.forEach((s, i) => {
    const p = s.spans[0]?.pageIndex ?? 0;
    if (!current || current.pageIndex !== p) {
      current = { pageIndex: p, firstSentenceIndex: i, preview: [], totalCount: 0 };
      groups.push(current);
    }
    current.totalCount++;
    if (current.preview.length < 3) current.preview.push(s.text);
  });
  return groups;
}

export default function TocDrawer({
  open,
  onClose,
  sentences,
  currentIndex,
  onSeekSentence,
  onSeekPage,
}: Props) {
  const groups = useMemo(() => groupByPage(sentences), [sentences]);
  const [expandedPage, setExpandedPage] = useState<number | null>(null);

  const activePage = sentences[currentIndex]?.spans[0]?.pageIndex ?? null;

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? "open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`drawer toc-drawer ${open ? "open" : ""}`}
        role="dialog"
        aria-label="Table of contents"
      >
        <header className="drawer-head">
          <h2>Contents</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </header>
        {sentences.length === 0 ? (
          <div className="drawer-empty">Load a PDF to see its pages.</div>
        ) : (
          <ul className="toc-list">
            {groups.map((g) => {
              const isActive = activePage === g.pageIndex;
              const isExpanded = expandedPage === g.pageIndex;
              return (
                <li key={g.pageIndex} className={isActive ? "active" : ""}>
                  <div className="toc-row">
                    <button
                      className="toc-page"
                      onClick={() => {
                        onSeekPage(g.pageIndex);
                        onClose();
                      }}
                    >
                      <span className="toc-page-num">Page {g.pageIndex + 1}</span>
                      <span className="toc-page-meta">{g.totalCount} sentences</span>
                    </button>
                    <button
                      className="toc-expand"
                      onClick={() => setExpandedPage(isExpanded ? null : g.pageIndex)}
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </button>
                  </div>
                  {isExpanded && (
                    <ol className="toc-sublist" start={g.firstSentenceIndex + 1}>
                      {g.preview.map((text, k) => {
                        const sIdx = g.firstSentenceIndex + k;
                        return (
                          <li key={sIdx} className={sIdx === currentIndex ? "active" : ""}>
                            <button
                              onClick={() => {
                                onSeekSentence(sIdx);
                                onClose();
                              }}
                            >
                              {text.length > 90 ? `${text.slice(0, 90)}…` : text}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </>
  );
}
