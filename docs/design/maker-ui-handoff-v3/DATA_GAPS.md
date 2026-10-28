# Maker v3 data gaps

These are presentation gaps only. They do not justify a trading-behaviour change.

| Surface           | Missing or uncertain data                                      | Current rendering                                                                           | Follow-up                                                                |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Today performance | A server-declared calendar window and timezone                 | The UI labels the existing 24-hour period honestly                                          | Return window kind, start, and end with performance.                     |
| PnL trend         | Timestamped net-known-result samples                           | No chart is rendered                                                                        | Add a bounded PnL series with realized PnL and known costs.              |
| Fill markouts     | Fair value after each fill                                     | Markouts are omitted                                                                        | Return signed 1 s, 10 s, and 60 s markouts after those windows mature.   |
| Taker rows        | Taker fill-level attribution in the existing Maker fills array | Per-market totals can include Taker history; expanded rows show attributed Maker fills only | Return a unified attributed-fill stream with role and bundle/account id. |
| Gas runway time   | Measured spend rate and conservative seconds remaining         | The existing action-count estimate is shown                                                 | Return recent spend, sample duration, and runway seconds.                |
| Legacy records    | Bundle attribution before a future bundle migration            | Future bundle performance must label unassigned history                                     | Preserve and label unassigned records during the approved migration.     |
