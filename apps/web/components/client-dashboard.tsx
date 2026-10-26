"use client";

import dynamic from "next/dynamic";

const Dashboard = dynamic(
  () => import("./maker-dashboard").then((module) => module.MakerDashboard),
  {
    ssr: false,
    loading: () => (
      <main className="loading-shell">
        <div className="loading-mark">AM</div>
        <span>Starting Maker...</span>
      </main>
    ),
  },
);

export function ClientDashboard() {
  return <Dashboard />;
}
