"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { AgentDemoContent } from "@/components/agent-demo/AgentDemoContent";

export default function AgentDemoPage() {
  return (
    <Shell crumbs={["Build", "Sample Agent Demo"]} directionTag="设计验证 · Sample Agent">
      <AgentDemoContent />
    </Shell>
  );
}
