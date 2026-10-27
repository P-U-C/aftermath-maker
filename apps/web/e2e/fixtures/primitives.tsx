"use client";

import { useState } from "react";
import {
  Button,
  Card,
  Input,
  ListRow,
  Meter,
  Pill,
  SegmentedTabs,
  Sheet,
  Toast,
  Toggle,
} from "../../components/ui/primitives";

type FixtureTab = "desk" | "markets" | "venues";

function PrimitiveTheme({ theme }: { theme: "light" | "dark" }) {
  const [tab, setTab] = useState<FixtureTab>("desk");
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <section className="ui-primitives-theme" data-theme={theme}>
      <h1>{theme === "light" ? "Light" : "Dark"} primitives</h1>

      <div className="ui-primitives-section">
        <Button size="small">Small</Button>
        <Button>Primary</Button>
        <Button size="large">Large</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="stop">Stop</Button>
        <Button disabled>Disabled</Button>
      </div>

      <div className="ui-primitives-section">
        <Pill tone="live" dot>
          Live
        </Pill>
        <Pill tone="paper" dot>
          Paper
        </Pill>
        <Pill>Stopped</Pill>
      </div>

      <SegmentedTabs
        label="Fixture views"
        value={tab}
        onChange={setTab}
        options={[
          { value: "desk", label: "Desk" },
          { value: "markets", label: "Markets" },
          { value: "venues", label: "Venues" },
        ]}
      />

      <div className="ui-primitives-fields">
        <Input
          label="Size per side"
          defaultValue="25.00"
          unit="USDC"
          hint="Applied on the next quote"
        />
        <Input
          label="Maximum exposure"
          defaultValue="5,000"
          unit="USDC"
          error="Enter an amount below available collateral"
        />
      </div>

      <Card title="Controls" subtitle="Every state uses the same vocabulary.">
        <Toggle
          label="Inventory skew"
          description="Pulls quotes toward the target"
          defaultChecked
        />
        <Toggle label="Automatic hedge" description="Uses the paired account" />
      </Card>

      <Card title="Markets" subtitle="Rows use inset hairlines.">
        <div className="ui-primitives-list">
          <ListRow leading={<Pill tone="paper">Paper</Pill>} trailing="$14.32">
            SUI / USDC
          </ListRow>
          <ListRow leading={<Pill tone="neutral">Idle</Pill>} trailing="−$0.18">
            BTC / USDC
          </ListRow>
        </div>
      </Card>

      <Card title="Risk">
        <div className="ui-primitives-stack">
          <Meter
            label="Gross exposure"
            value={32}
            max={100}
            valueText="$32 of $100"
          />
          <Meter
            label="Run drawdown"
            value={74}
            max={100}
            valueText="$74 of $100"
          />
          <Meter
            label="Gas runway"
            value={100}
            max={100}
            valueText="At limit"
          />
        </div>
      </Card>

      <div className="ui-primitives-section">
        <Button variant="quiet" onClick={() => setSheetOpen(true)}>
          Open sheet
        </Button>
      </div>

      <div className="ui-primitives-stack">
        <Toast message="Strategy saved" />
        <Toast
          tone="error"
          message="The venue rejected this request. Review the limits and try again."
        />
      </div>

      <Sheet
        open={sheetOpen}
        title="Review live settings"
        description="Nothing is submitted until you confirm."
        onClose={() => setSheetOpen(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setSheetOpen(false)}>
              Cancel
            </Button>
            <Button disabled>Live trading is off</Button>
          </>
        }
      >
        <div className="ui-primitives-stack">
          <ListRow trailing="Aftermath">Venue</ListRow>
          <ListRow trailing="15">Markets</ListRow>
          <ListRow trailing="$25 USDC">Size per side</ListRow>
        </div>
      </Sheet>
    </section>
  );
}

export function PrimitivesFixture() {
  return (
    <main className="ui-primitives-fixture">
      <PrimitiveTheme theme="light" />
      <PrimitiveTheme theme="dark" />
    </main>
  );
}
