# Maker access registry

A minimal Sui Move package for public access control.

Publishing creates one shared `Registry` and transfers one `AdminCap` to the publisher. The publisher is the first member. Only possession of the cap can add or remove addresses.

```bash
sudo docker run --rm \
  -v "$PWD:/workspace" \
  -w /workspace mysten/sui-tools@sha256:bd90eaa5ca94d880ee4d6ac232a36b21d3b52d5ef95e3178b7fb0a148d85fe59 sui move test
```

The web operator console publishes the compiled module and records the resulting package, registry, and cap object IDs. The server reads the registry through Sui gRPC; membership is never mirrored as the authority in SQLite.
