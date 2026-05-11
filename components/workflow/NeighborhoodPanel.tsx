"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge } from "@/components/shared/atoms";
import { upstreamOf, downstreamOf, type Neighbor } from "@/lib/agent-graph";
import type { AgentKind } from "@/lib/agent-mapping";

// P0: shows the upstream / downstream agents for the selected agent in the
// Workflow Inspector. Pure derivation from AGENT_MAP (lib/agent-graph.ts) —
// no fetches. Click an entry to navigate the canvas selection without
// scrolling away.

type Props = {
  /** Canonical agent short of the currently selected node. */
  short: string | null;
  /** Switch the canvas selection to the agent with this short. */
  onJump: (short: string) => void;
};

export function NeighborhoodPanel({ short, onJump }: Props) {
  if (!short) return null;
  const ups = upstreamOf(short);
  const downs = downstreamOf(short);
  if (ups.length === 0 && downs.length === 0) {
    return (
      <div className="border-b border-line" style={{ padding: "10px 16px" }}>
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-1.5">
          上下游 · NEIGHBORHOOD
        </div>
        <div className="text-[11px] text-ink-3">
          此 agent 不与其他 agent 直接通过事件相连
          （触发源或下游可能是外部系统）。
        </div>
      </div>
    );
  }
  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-1.5">
        上下游 · NEIGHBORHOOD
      </div>
      {ups.length > 0 && (
        <NeighborGroup
          title="上游 · 谁会触发我"
          neighbors={ups}
          direction="up"
          onJump={onJump}
        />
      )}
      {downs.length > 0 && (
        <NeighborGroup
          title="下游 · 我会触发谁"
          neighbors={downs}
          direction="down"
          onJump={onJump}
        />
      )}
    </div>
  );
}

function NeighborGroup({
  title,
  neighbors,
  direction,
  onJump,
}: {
  title: string;
  neighbors: Neighbor[];
  direction: "up" | "down";
  onJump: (short: string) => void;
}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[10.5px] text-ink-4 font-semibold mb-1">{title}</div>
      <div className="flex flex-col gap-1">
        {neighbors.map((n) => (
          <NeighborRow
            key={n.agent.short}
            neighbor={n}
            direction={direction}
            onJump={onJump}
          />
        ))}
      </div>
    </div>
  );
}

function NeighborRow({
  neighbor,
  direction,
  onJump,
}: {
  neighbor: Neighbor;
  direction: "up" | "down";
  onJump: (short: string) => void;
}) {
  const arrow = direction === "up" ? "←" : "→";
  return (
    <button
      type="button"
      onClick={() => onJump(neighbor.agent.short)}
      className="bg-panel border border-line rounded-sm hover:bg-surface text-left cursor-pointer flex items-center gap-2 transition-colors"
      style={{ padding: "6px 8px" }}
    >
      <span className="mono text-[11px] text-ink-3 w-3 text-center">
        {arrow}
      </span>
      <Ic.sparkle />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-ink-1 truncate">
          {neighbor.agent.short}
        </div>
        <div className="mono text-[10px] text-ink-3 truncate">
          via {neighbor.viaEvents.join(", ")}
        </div>
      </div>
      <KindBadge kind={neighbor.agent.kind} />
    </button>
  );
}

function KindBadge({ kind }: { kind: AgentKind }) {
  const variant: "ok" | "warn" | "info" =
    kind === "auto" ? "ok" : kind === "hitl" ? "warn" : "info";
  const label = kind === "auto" ? "auto" : kind === "hitl" ? "HITL" : "hybrid";
  return (
    <Badge variant={variant} className="text-[9.5px]">
      {label}
    </Badge>
  );
}
