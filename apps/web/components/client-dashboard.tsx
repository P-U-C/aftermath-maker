"use client";

import dynamic from "next/dynamic";
import { SpreadMark } from "./spread-mark";

const Dashboard = dynamic(
  () => import("./maker-dashboard").then((module) => module.MakerDashboard),
  {
    ssr: false,
    loading: () => (
      <main className="loading-shell">
        <SpreadMark state="stopped" size={48} />
        <span>Starting Maker...</span>
      </main>
    ),
  },
);

export function ClientDashboard() {
  return <Dashboard />;
}
